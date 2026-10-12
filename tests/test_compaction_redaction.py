"""Redaction undoes compaction precisely instead of discarding the whole scope."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import TYPE_CHECKING

import pytest
from agno.db.base import SessionType
from agno.db.sqlite import SqliteDb
from agno.models.message import Message
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.run.team import TeamRunOutput
from agno.session.agent import AgentSession
from agno.session.summary import SessionSummary
from agno.session.team import TeamSession

from mindroom import constants
from mindroom.constants import MID_TURN_GENERATION_METADATA_KEY
from mindroom.history import archive
from mindroom.history.interrupted_replay import persist_interrupted_replay_snapshot
from mindroom.history.native import restore_paused_history
from mindroom.history.storage import (
    _read_scope_history_event_ids,
    _remove_redacted_event_from_compaction,
    _remove_redacted_event_from_history,
    archive_compaction_chunk,
    read_scope_seen_event_ids,
    reconcile_compaction_state,
    record_mid_turn_generation,
    remove_runs_for_sources,
    update_scope_seen_event_ids,
)
from mindroom.history.turn_recorder import TurnRecorder
from mindroom.history.types import HistoryScope
from mindroom.session_storage.agent_storage import create_state_storage, get_agent_session, get_team_session
from mindroom.tool_system.events import ToolTraceEntry
from tests.conftest import seed_session
from tests.history_helpers import archived_content

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator
    from pathlib import Path

_SCOPE = HistoryScope(kind="agent", scope_id="code")


def _open(tmp_path: Path) -> SqliteDb:
    db = create_state_storage("code", tmp_path, subdir="sessions", session_table="code_sessions")
    assert isinstance(db, SqliteDb)
    return db


@pytest.fixture
def storage(tmp_path: Path) -> Iterator[SqliteDb]:
    """Use the production conversation storage owner."""
    db = _open(tmp_path)
    try:
        yield db
    finally:
        db.close()


@pytest.fixture
def open_legacy(tmp_path: Path) -> Iterator[Callable[[AgentSession], SqliteDb]]:
    """Seed a session as a pre-archive release left it, then reopen so the migration adopts it."""
    opened: list[SqliteDb] = []

    def open_migrated(session: AgentSession) -> SqliteDb:
        seeding = _open(tmp_path)
        seed_session(seeding, session)
        seeding.close()
        opened.append(_open(tmp_path))
        return opened[-1]

    yield open_migrated
    for db in opened:
        db.close()


def _run(run_id: str) -> RunOutput:
    return RunOutput(
        run_id=run_id,
        agent_id="code",
        session_id="session",
        content=f"answer {run_id}",
        messages=[Message(role="user", content=f"question {run_id}")],
        metadata={
            constants.MATRIX_EVENT_ID_METADATA_KEY: f"${run_id}",
            constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY: [f"${run_id}"],
        },
    )


def _seed(storage: SqliteDb, run_ids: list[str]) -> AgentSession:
    return seed_session(
        storage,
        AgentSession(session_id="session", agent_id="code", runs=[_run(run_id) for run_id in run_ids]),
    )


def _compact(storage: SqliteDb, session: AgentSession, run_ids: list[str], summary: str) -> None:
    archive_compaction_chunk(
        storage=storage,
        session=session,
        scope=_SCOPE,
        summary=SessionSummary(summary=summary, updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in session.runs or [] if run.run_id in run_ids],
    )


def _stored(storage: SqliteDb) -> AgentSession:
    session = get_agent_session(storage, "session")
    assert session is not None
    return session


def _summary(session: AgentSession) -> str | None:
    return session.summary.summary if session.summary is not None else None


def _seen(storage: SqliteDb, session: AgentSession) -> set[str]:
    return read_scope_seen_event_ids(storage, session, _SCOPE)


def _legacy_session(run_ids: list[str], summary: str, seen_event_ids: list[str]) -> AgentSession:
    session = AgentSession(
        session_id="session",
        agent_id="code",
        runs=[_run(run_id) for run_id in run_ids],
        summary=SessionSummary(summary=summary),
    )
    update_scope_seen_event_ids(session, _SCOPE, seen_event_ids)
    return session


def test_a_compacted_run_counts_as_seen_what_it_counted_while_live(storage: SqliteDb) -> None:
    """Compaction changes where seen ids come from, not which ids a run marks seen; redaction still matches all."""
    run = _run("r1")
    assert run.metadata is not None
    run.metadata[constants.MATRIX_SOURCE_EVENT_IDS_METADATA_KEY] = ["$coalesced"]
    session = seed_session(storage, AgentSession(session_id="session", agent_id="code", runs=[run, _run("r2")]))
    seen_while_live = _seen(storage, _stored(storage))
    _compact(storage, session, ["r1"], "summary of r1")

    assert _seen(storage, _stored(storage)) == seen_while_live == {"$r1", "$r2"}
    assert _remove_redacted_event_from_compaction(
        storage,
        session,
        _SCOPE,
        event_id="$coalesced",
        removed_live_run=False,
    )
    assert _summary(_stored(storage)) is None


def test_compaction_derives_seen_ids_without_storing_them(storage: SqliteDb) -> None:
    """Compacted runs count as seen through the archive, so session metadata keeps no copy to repair."""
    session = _seed(storage, ["r1", "r2"])
    _compact(storage, session, ["r1"], "summary of r1")

    stored = _stored(storage)
    assert constants.MINDROOM_MATRIX_HISTORY_METADATA_KEY not in (stored.metadata or {})
    assert _seen(storage, stored) == {"$r1", "$r2"}


def test_redaction_restores_the_runs_compacted_before_the_redacted_one(storage: SqliteDb) -> None:
    """Only the redacted run and what follows it leave history; earlier compacted runs return to replay."""
    session = _seed(storage, ["r1", "r2", "r3", "r4", "r5"])
    _compact(storage, session, ["r1"], "summary of r1")
    _compact(storage, session, ["r2", "r3"], "summary of r1 to r3")

    changed = _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r3", removed_live_run=False)

    assert changed is True
    stored = _stored(storage)
    assert [run.run_id for run in stored.runs or []] == ["r2"]
    assert _summary(stored) == "summary of r1"
    assert archived_content(storage, "session") == {"r1": True, "r3": False}
    assert _seen(storage, stored) == {"$r1", "$r2"}
    assert _summary(session) == "summary of r1"


def test_redacting_the_first_compacted_run_clears_the_summary_for_good(storage: SqliteDb) -> None:
    """A rollback past every generation keeps a stale summary write from replaying again."""
    session = _seed(storage, ["r1", "r2"])
    _compact(storage, session, ["r1"], "summary with the redacted content")

    assert (
        _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r1", removed_live_run=False) is True
    )
    stored = _stored(storage)
    assert stored.runs == []
    assert stored.summary is None

    stored.summary = SessionSummary(summary="summary with the redacted content")
    storage.upsert_session(stored)
    reconcile_compaction_state(storage, stored, _SCOPE)

    assert _stored(storage).summary is None


def test_redacting_a_live_only_event_keeps_the_archive_summary(storage: SqliteDb) -> None:
    """A summary provably built without the event survives its redaction."""
    session = _seed(storage, ["r1", "r2"])
    _compact(storage, session, ["r1"], "summary of r1")
    update_scope_seen_event_ids(session, _SCOPE, ["$team-consumed"])
    storage.upsert_session(session)

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r2", removed_live_run=True)

    stored = _stored(storage)
    assert _summary(stored) == "summary of r1"
    assert [run.run_id for run in stored.runs or []] == ["r2"]
    # Preserved ids are dropped; the archive and live runs still supply everything replay represents.
    assert _seen(storage, stored) == {"$r1", "$r2"}


def test_compacted_history_that_read_a_redacted_event_is_found_and_removed(storage: SqliteDb) -> None:
    """A message a compacted run read only as context still marks that history, and its removal syncs the session."""
    run = _run("r1")
    assert run.metadata is not None
    run.metadata[constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY] = ["$context", "$r1"]
    session = seed_session(storage, AgentSession(session_id="session", agent_id="code", runs=[run, _run("r2")]))
    _compact(storage, session, ["r1"], "summary that quotes the context")
    loaded = _stored(storage)

    assert "$context" in _read_scope_history_event_ids(storage, loaded, _SCOPE)
    assert _remove_redacted_event_from_history(storage, loaded, _SCOPE, event_id="$context") is True

    assert loaded.runs == []
    assert loaded.summary is None
    assert "$context" not in _read_scope_history_event_ids(storage, _stored(storage), _SCOPE)


def test_history_event_ids_include_compacted_sources_and_paused_runs(storage: SqliteDb) -> None:
    """Redaction finds a coalesced source compaction archived and a run paused for approval."""
    coalesced = _run("r1")
    assert coalesced.metadata is not None
    coalesced.metadata[constants.MATRIX_SOURCE_EVENT_IDS_METADATA_KEY] = ["$coalesced"]
    paused = _run("r3")
    paused.status = RunStatus.paused
    session = seed_session(
        storage,
        AgentSession(session_id="session", agent_id="code", runs=[coalesced, _run("r2"), paused]),
    )
    _compact(storage, session, ["r1"], "summary of r1")

    event_ids = _read_scope_history_event_ids(storage, _stored(storage), _SCOPE)

    assert {"$coalesced", "$r1", "$r2", "$r3"} <= event_ids
    assert "$coalesced" not in read_scope_seen_event_ids(storage, _stored(storage), _SCOPE)


def test_redaction_without_any_matching_history_changes_nothing(storage: SqliteDb) -> None:
    """An event no stored history represents leaves compaction untouched."""
    session = _seed(storage, ["r1", "r2"])
    _compact(storage, session, ["r1"], "summary of r1")

    changed = _remove_redacted_event_from_compaction(
        storage,
        session,
        _SCOPE,
        event_id="$other",
        removed_live_run=False,
    )

    assert changed is False
    assert _summary(_stored(storage)) == "summary of r1"


def test_redacting_legacy_provenance_clears_summary_and_archived_generations(
    open_legacy: Callable[[AgentSession], SqliteDb],
) -> None:
    """Content-free legacy history cannot be split, so an event it consumed clears the scope."""
    storage = open_legacy(_legacy_session(["r2", "r3"], "legacy summary", ["$legacy"]))
    session = _stored(storage)
    _compact(storage, session, ["r2"], "legacy summary and r2")

    assert (
        _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$legacy", removed_live_run=False)
        is True
    )

    stored = _stored(storage)
    assert stored.runs == []
    assert stored.summary is None
    assert _seen(storage, stored) == set()
    assert archived_content(storage, "session") == {"r2": False}


def test_removing_a_live_run_retires_a_legacy_summary(open_legacy: Callable[[AgentSession], SqliteDb]) -> None:
    """Legacy summaries lack complete provenance, so any live removal for the event retires them."""
    storage = open_legacy(_legacy_session(["r2"], "legacy summary", []))
    session = _stored(storage)

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$gone", removed_live_run=True)

    stored = _stored(storage)
    assert [run.run_id for run in stored.runs or []] == ["r2"]
    assert stored.summary is None


def test_removing_a_live_run_keeps_runs_archived_after_a_legacy_summary(
    open_legacy: Callable[[AgentSession], SqliteDb],
) -> None:
    """Retiring a legacy summary keeps later archived runs stored, but no longer counts them as seen."""
    storage = open_legacy(_legacy_session(["r1", "r2"], "legacy summary", ["$legacy"]))
    session = _stored(storage)
    _compact(storage, session, ["r1"], "legacy summary and r1")

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$gone", removed_live_run=True)

    stored = _stored(storage)
    assert [run.run_id for run in stored.runs or []] == ["r2"]
    assert stored.summary is None
    assert archive.archived_run_ids(storage, session_id="session", run_ids=["r1"]) == {"r1"}
    assert _seen(storage, stored) == {"$r2"}
    stored.summary = SessionSummary(summary="legacy summary and r1")
    storage.upsert_session(stored)
    reconcile_compaction_state(storage, stored, _SCOPE)
    assert _stored(storage).summary is None


def test_a_late_save_of_a_rolled_back_run_cannot_replay_it(storage: SqliteDb) -> None:
    """A stale copy of a run redaction removed from the archive is pruned when it is written back."""
    session = _seed(storage, ["r1", "r2"])
    late_copy = next(run for run in session.runs or [] if run.run_id == "r1")
    _compact(storage, session, ["r1"], "summary of r1")
    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r1", removed_live_run=False)

    storage.upsert_run(run=late_copy, session_id="session", user_id=None)
    reconcile_compaction_state(storage, _stored(storage), _SCOPE)

    assert _stored(storage).runs == []


def test_a_late_save_after_a_legacy_clear_cannot_replay_the_cleared_run(
    open_legacy: Callable[[AgentSession], SqliteDb],
) -> None:
    """Runs archived after a legacy summary stay tombstoned when that summary is cleared."""
    storage = open_legacy(_legacy_session(["r1", "r2"], "legacy summary", ["$legacy"]))
    session = _stored(storage)
    late_copy = next(run for run in session.runs or [] if run.run_id == "r1")
    _compact(storage, session, ["r1"], "legacy summary and r1")
    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$legacy", removed_live_run=False)

    storage.upsert_run(run=late_copy, session_id="session", user_id=None)
    reconcile_compaction_state(storage, _stored(storage), _SCOPE)

    assert _stored(storage).runs == []


def test_team_redaction_without_compaction_keeps_unrelated_runs(storage: SqliteDb) -> None:
    """Seen ids a team records on the session row are not legacy provenance."""
    session = _seed(storage, ["t1", "t2"])
    update_scope_seen_event_ids(session, _SCOPE, ["$t1", "$t2", "$t3"])
    storage.upsert_session(session)

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$t3", removed_live_run=True)

    stored = _stored(storage)
    assert [run.run_id for run in stored.runs or []] == ["t1", "t2"]
    assert _seen(storage, stored) == {"$t1", "$t2"}


def test_rollback_forgets_seen_ids_of_the_removed_runs(storage: SqliteDb) -> None:
    """Messages whose runs a rollback removed become unseen, so thread history supplies them again."""
    session = _seed(storage, ["r1", "r2", "r3"])
    _compact(storage, session, ["r1"], "summary of r1")
    _compact(storage, session, ["r2"], "summary of r1 and r2")
    update_scope_seen_event_ids(session, _SCOPE, ["$r3"])
    storage.upsert_session(session)

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r2", removed_live_run=False)

    stored = _stored(storage)
    assert stored.runs == []
    assert _summary(stored) == "summary of r1"
    assert _seen(storage, stored) == {"$r1"}


def test_legacy_provenance_wins_over_a_later_archive_hit(open_legacy: Callable[[AgentSession], SqliteDb]) -> None:
    """An event a legacy summary may contain clears it even when an archived run also represents it."""
    storage = open_legacy(_legacy_session(["r1", "r2"], "legacy summary quoting $r1", ["$r1"]))
    session = _stored(storage)
    _compact(storage, session, ["r1"], "legacy summary quoting $r1, then r1")

    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r1", removed_live_run=False)

    stored = _stored(storage)
    assert stored.summary is None
    assert stored.runs == []


def test_a_rearchived_run_keeps_its_first_generation(storage: SqliteDb) -> None:
    """Redaction rolls back to the generation that first folded a run, even if it was archived again."""
    session = _seed(storage, ["r1", "r2"])
    _compact(storage, session, ["r1"], "summary mentioning r1")
    resurrected = seed_session(
        storage,
        AgentSession(session_id="session", agent_id="code", runs=[_run("r1"), *(_stored(storage).runs or [])]),
    )
    _compact(storage, resurrected, ["r1", "r2"], "summary mentioning r1 and r2")

    assert _remove_redacted_event_from_compaction(storage, resurrected, _SCOPE, event_id="$r1", removed_live_run=False)

    stored = _stored(storage)
    assert stored.summary is None
    assert stored.runs == []


def test_refreshing_a_stale_summary_drops_the_stale_rows_seen_ids(storage: SqliteDb) -> None:
    """A stale pre-rollback row cannot mark the rolled-back messages as seen again."""
    session = _seed(storage, ["r1", "r2", "r3"])
    _compact(storage, session, ["r1"], "summary of r1")
    _compact(storage, session, ["r2"], "summary of r1 and r2")
    stale = _stored(storage)
    update_scope_seen_event_ids(stale, _SCOPE, ["$r3"])
    assert _remove_redacted_event_from_compaction(storage, session, _SCOPE, event_id="$r2", removed_live_run=False)

    storage.upsert_session(stale)
    reconciled = _stored(storage)
    reconcile_compaction_state(storage, reconciled, _SCOPE)

    stored = _stored(storage)
    assert _summary(stored) == "summary of r1"
    assert _seen(storage, stored) == {"$r1"}


def _live_run_with(events: list[str], *, reply: str | None = None) -> RunOutput:
    run = _run("x")
    metadata = dict(run.metadata or {})
    metadata[constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY] = events
    if reply is not None:
        metadata[constants.MATRIX_RESPONSE_EVENT_ID_METADATA_KEY] = reply
    run.metadata = metadata
    return run


@pytest.mark.parametrize("materialized", [False, True])
@pytest.mark.parametrize("folds", [1, 2])
@pytest.mark.parametrize("event_id", ["$x", "$mid", "$late", "$reply"])
def test_redacting_any_event_of_a_run_that_compacted_mid_turn_rolls_back_before_it(
    storage: SqliteDb,
    *,
    materialized: bool,
    folds: int,
    event_id: str,
) -> None:
    """Events the run consumed before or after its folds, and its reply, all undo the folds."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _live_run_with(["$x", "$mid", "$late"], reply="$reply"))
    _fold(storage, session, "x", ["r1", "r2"])
    if folds == 2:
        _fold(storage, session, "x", [], summary="folded twice")
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id=event_id) is True

    assert _live(storage) == ["r1", "r2"]
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_a_turn_whose_fold_never_applied_keeps_earlier_runs(storage: SqliteDb, removal: str) -> None:
    """A fold a crash kept out of the run's record summarizes nothing, so removing the turn rolls nothing back."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _live_run_with(["$x"], reply="$reply"))
    _fold(storage, session, "x", ["r1", "r2"], applied=False)

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$x",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$reply") is True

    assert _live(storage) == ["r1", "r2"]
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE.key) == []


@pytest.mark.parametrize("materialized", [False, True])
@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_a_turn_that_compacted_mid_turn_keeps_an_older_paused_run(
    storage: SqliteDb,
    *,
    materialized: bool,
    removal: str,
) -> None:
    """A pending approval that compaction skipped survives undoing a later turn's fold, in its place."""
    session = _seed_runs(storage, _run("r1"), _paused("p"), _live_run_with(["$x"], reply="$reply"))
    _fold(storage, session, "x", ["r1"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)
        assert _live(storage) == ["p", "x"]

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$x",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$reply") is True

    assert _live(storage) == ["r1", "p"]
    assert _summary(_stored(storage)) is None


def _fold(
    storage: SqliteDb,
    session: AgentSession | TeamSession,
    position_run_id: str,
    covered: list[str],
    *,
    applied: bool = True,
    summary: str = "folded",
    scope: HistoryScope = _SCOPE,
) -> int:
    """Commit a mid-turn generation on ``position_run_id`` and, when applied, record it on the stored run."""
    runs = {run.run_id: run for run in session.runs or []}
    generation_id = record_mid_turn_generation(
        storage,
        session=session,
        scope=scope,
        summary=summary,
        summary_model="summary-model",
        position_run=runs[position_run_id],
        covered_runs=[runs[run_id] for run_id in covered],
    )
    if applied:
        position = runs[position_run_id]
        position.metadata = {**(position.metadata or {}), MID_TURN_GENERATION_METADATA_KEY: generation_id}
        storage.upsert_run(run=position, session_id=session.session_id, user_id=position.user_id)
    return generation_id


def _paused(run_id: str) -> RunOutput:
    run = _run(run_id)
    run.status = RunStatus.paused
    return run


def _live(storage: SqliteDb) -> list[str]:
    return [run.run_id or "" for run in _stored(storage).runs or []]


def _seed_runs(storage: SqliteDb, *runs: RunOutput) -> AgentSession:
    return seed_session(storage, AgentSession(session_id="session", agent_id="code", runs=list(runs)))


def test_reconcile_archives_exactly_the_runs_an_applied_fold_covered(storage: SqliteDb) -> None:
    """The next reply replays the fold's summary and the position run, without another summary call."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _run("x"))
    _fold(storage, session, "x", ["r1", "r2"])

    reconcile_compaction_state(storage, session, _SCOPE)

    assert _live(storage) == ["x"]
    assert _summary(_stored(storage)) == "folded"
    assert archived_content(storage, "session") == {"r1": True, "r2": True}


def test_reconcile_deletes_a_fold_its_run_never_recorded(storage: SqliteDb) -> None:
    """A crash between the commit and the run's next save leaves the run as it was and no summary of it."""
    session = _seed_runs(storage, _run("r1"), _paused("p"))
    _fold(storage, session, "p", ["r1"], applied=False)

    reconcile_compaction_state(storage, session, _SCOPE)

    assert _live(storage) == ["r1", "p"]
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE.key) == []
    assert _summary(_stored(storage)) is None


def test_reconcile_rolls_back_a_fold_whose_run_is_gone(storage: SqliteDb) -> None:
    """A fold of a run that was never saved, or was removed, no longer summarizes anything."""
    session = _seed_runs(storage, _run("r1"))
    generation_id = record_mid_turn_generation(
        storage,
        session=session,
        scope=_SCOPE,
        summary="folded",
        summary_model="summary-model",
        position_run=_run("gone"),
        covered_runs=[run for run in session.runs or [] if run.run_id == "r1"],
    )
    assert generation_id

    reconcile_compaction_state(storage, session, _SCOPE)

    assert _live(storage) == ["r1"]
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE.key) == []


@pytest.mark.parametrize("materialized", [False, True])
def test_redacting_a_covered_run_removes_the_shortened_position_run(storage: SqliteDb, *, materialized: bool) -> None:
    """The fold's summary and the run built on it both derive from the redacted run."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _run("x"))
    _fold(storage, session, "x", ["r1", "r2"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$r2") is True

    assert _live(storage) == ["r1"]
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("materialized", [False, True])
def test_redacting_a_newer_run_an_older_resumed_run_folded_removes_that_run(
    storage: SqliteDb,
    *,
    materialized: bool,
) -> None:
    """A resumed run whose fold covered a newer run goes with it, though it is older; the runs before both stay."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _paused("p"), _run("b"), _run("c"))
    _fold(storage, session, "p", ["r1", "r2", "b", "c"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$c") is True

    assert _live(storage) == ["r1", "r2", "b"]
    assert _summary(_stored(storage)) is None


def test_a_fold_of_a_run_that_then_stopped_keeps_its_folded_events_seen(storage: SqliteDb) -> None:
    """Thread context a stopped run folded into the summary does not return as unseen context."""
    stopped = _live_run_with(["$thread-context"])
    stopped.status = RunStatus.cancelled
    session = _seed_runs(storage, _run("r1"), stopped)
    _fold(storage, session, "x", ["r1"])
    reconcile_compaction_state(storage, session, _SCOPE)

    assert "$thread-context" in _seen(storage, _stored(storage))


def test_a_deleted_fold_with_no_earlier_generation_stops_replaying_its_summary(storage: SqliteDb) -> None:
    """A crash after Agno saved the session but not the run must not leave the discarded summary replaying."""
    session = _seed_runs(storage, _run("r1"), _paused("p"))
    _fold(storage, session, "p", ["r1"], applied=False)
    # Agno writes the session row, carrying the new summary, before the run row.
    session.summary = SessionSummary(summary="folded", updated_at=datetime.now(UTC))
    storage.upsert_session(session)

    reconcile_compaction_state(storage, session, _SCOPE)

    assert _summary(_stored(storage)) is None
    assert _live(storage) == ["r1", "p"]


def test_an_interrupted_record_keeps_the_fold_its_turn_applied(storage: SqliteDb) -> None:
    """Stopping a reply after a mid-turn compaction keeps that compaction for the next reply."""
    session = _seed_runs(storage, _run("r1"))
    generation_id = record_mid_turn_generation(
        storage,
        session=session,
        scope=_SCOPE,
        summary="folded",
        summary_model="summary-model",
        position_run=_run("x"),
        covered_runs=[run for run in session.runs or [] if run.run_id == "r1"],
    )
    recorder = TurnRecorder(user_message="Do the task", run_metadata={})
    recorder.record_mid_turn_generation(generation_id, folded_tool_call_ids={"call-before"})
    recorder.record_interrupted(
        run_metadata={},
        assistant_text="partial",
        completed_tools=[
            ToolTraceEntry(
                type="tool_call_completed",
                tool_name="probe",
                result_preview="BEFORE",
                tool_call_id="call-before",
            ),
            ToolTraceEntry(
                type="tool_call_completed",
                tool_name="probe",
                result_preview="AFTER",
                tool_call_id="call-after",
            ),
        ],
        interrupted_tools=[],
    )

    persist_interrupted_replay_snapshot(
        storage=storage,
        session=None,
        session_id="session",
        scope_id="code",
        run_id="x",
        snapshot=recorder.interrupted_snapshot(),
        is_team=False,
    )
    reconcile_compaction_state(storage, _stored(storage), _SCOPE)

    assert [
        generation.id
        for generation in archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE.key)
    ] == [generation_id]
    assert _summary(_stored(storage)) == "folded"
    assert _live(storage) == ["x"]
    # The fold's summary holds the earlier tool work; the interrupted record keeps only what came after it.
    replayed = str(_stored(storage).runs[0].to_dict())
    assert "AFTER" in replayed
    assert "BEFORE" not in replayed


def test_redacting_an_event_a_fold_read_undoes_the_fold_after_its_run_was_archived(storage: SqliteDb) -> None:
    """An event a folded run read as unseen context keeps reaching that fold after a later compaction."""
    session = _seed_runs(storage, _run("r1"), _paused("p"), _live_run_with(["$p", "$x"], reply="$reply"))
    _fold(storage, session, "x", ["r1"])
    reconcile_compaction_state(storage, session, _SCOPE)
    stored = _stored(storage)
    approved = next(run for run in stored.runs or [] if run.run_id == "p")
    approved.status = RunStatus.completed
    storage.upsert_run(run=approved, session_id="session", user_id=approved.user_id)
    stored = _stored(storage)
    archive_compaction_chunk(
        storage=storage,
        session=stored,
        scope=_SCOPE,
        summary=SessionSummary(summary="folded, p, and x", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=list(stored.runs or []),
    )

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$p") is True

    assert "$p" not in archive.redactable_compacted_event_ids(storage, session_id="session", scope_key=_SCOPE.key)
    assert _summary(_stored(storage)) is None
    assert _live(storage) == ["r1"]


@pytest.mark.asyncio
async def test_resuming_a_paused_run_settles_its_folds_before_the_route_reads_the_summary(storage: SqliteDb) -> None:
    """An approval recovery archives what the paused run's fold covered and loads the summary it replays."""
    session = _seed_runs(storage, _run("r1"), _paused("p"))
    _fold(storage, session, "p", ["r1"])
    paused_session = _stored(storage)
    paused_session.summary = None

    await restore_paused_history(
        object(),
        persisted_run=next(run for run in paused_session.runs or [] if run.run_id == "p"),
        storage=storage,
        session=paused_session,
        scope=_SCOPE,
    )

    assert archived_content(storage, "session") == {"r1": True}
    assert [run.run_id for run in paused_session.runs or []] == ["p"]
    assert _summary(paused_session) == "folded"


@pytest.mark.parametrize("materialized", [False, True])
def test_editing_a_run_an_older_resumed_run_folded_rolls_the_fold_back(
    storage: SqliteDb,
    *,
    materialized: bool,
) -> None:
    """Regenerating an edited reply removes its obsolete content from the summary that folded it."""
    session = _seed_runs(storage, _run("r1"), _paused("p"), _run("b"))
    _fold(storage, session, "p", ["r1", "b"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$b",)) is True

    assert _summary(_stored(storage)) is None
    assert "b" not in _live(storage)
    assert "$b" not in archive.redactable_compacted_event_ids(storage, session_id="session", scope_key=_SCOPE.key)


@pytest.mark.parametrize("materialized", [False, True])
@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_an_older_resumed_run_that_folded_also_removes_the_newer_run_it_folded(
    storage: SqliteDb,
    *,
    materialized: bool,
    removal: str,
) -> None:
    """Every run stored after the removed resumed run goes, whether or not its fold already archived it."""
    session = _seed_runs(storage, _run("r1"), _paused("p"), _run("b"))
    _fold(storage, session, "p", ["r1", "b"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$p",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$p") is True

    assert _live(storage) == ["r1"]
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_a_run_that_folded_and_was_then_archived_removes_the_runs_after_it(
    storage: SqliteDb,
    removal: str,
) -> None:
    """A later turn replayed the fold's summary, so it goes with the fold's run even after compaction archived it."""
    session = _seed_runs(storage, _run("r1"), _run("x"))
    _fold(storage, session, "x", ["r1"])
    reconcile_compaction_state(storage, session, _SCOPE)
    storage.upsert_run(run=_run("y"), session_id="session", user_id=None)
    archive_compaction_chunk(
        storage=storage,
        session=_stored(storage),
        scope=_SCOPE,
        summary=SessionSummary(summary="folded x", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in _stored(storage).runs or [] if run.run_id == "x"],
    )
    assert _live(storage) == ["y"]

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$x",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$x") is True

    assert _live(storage) == ["r1"]
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_an_older_resumed_run_archived_after_its_fold_keeps_only_the_runs_before_it(
    storage: SqliteDb,
    removal: str,
) -> None:
    """A later compaction archived the resumed run, and its fold's newer runs still go with it."""
    session = _seed_runs(storage, _run("r1"), _run("p"), _run("b"))
    _fold(storage, session, "p", ["r1", "b"])
    reconcile_compaction_state(storage, session, _SCOPE)
    archive_compaction_chunk(
        storage=storage,
        session=_stored(storage),
        scope=_SCOPE,
        summary=SessionSummary(summary="folded p", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in _stored(storage).runs or [] if run.run_id == "p"],
    )
    assert _live(storage) == []

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$p",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$p") is True

    assert _live(storage) == ["r1"]
    assert _summary(_stored(storage)) is None


def _answering(run_id: str, event_id: str) -> RunOutput:
    run = _run(run_id)
    run.metadata = {**(run.metadata or {}), constants.MATRIX_EVENT_ID_METADATA_KEY: event_id}
    return run


@pytest.mark.parametrize("materialized", [False, True])
def test_editing_a_retried_turn_whose_second_attempt_folded_the_first_removes_both(
    storage: SqliteDb,
    *,
    materialized: bool,
) -> None:
    """Both attempts answered the edited message, so neither the first attempt nor the fold survives."""
    session = _seed_runs(storage, _run("c"), _answering("p1", "$u"), _answering("p2", "$u"))
    _fold(storage, session, "p2", ["c", "p1"])
    if materialized:
        reconcile_compaction_state(storage, session, _SCOPE)

    assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$u",)) is True

    assert _live(storage) == ["c"]
    assert _summary(_stored(storage)) is None


def test_editing_a_message_a_later_bot_triggered_turn_folded_removes_that_turn(storage: SqliteDb) -> None:
    """A later turn's fold covered the edited turn, so the edit undoes the fold and removes the later turn."""
    session = _seed_runs(storage, _answering("p", "$u"), _answering("q", "$bot"))
    _fold(storage, session, "q", ["p"])
    reconcile_compaction_state(storage, session, _SCOPE)
    assert _live(storage) == ["q"]

    assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$u",)) is True

    assert _live(storage) == []
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_an_archived_run_keeps_an_older_pending_approval(storage: SqliteDb, removal: str) -> None:
    """Only runs after the removed one go; an older run compaction skipped, such as a pending approval, stays."""
    session = _seed_runs(storage, _paused("p"), _run("r1"), _run("r2"))
    archive_compaction_chunk(
        storage=storage,
        session=session,
        scope=_SCOPE,
        summary=SessionSummary(summary="r1", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in session.runs or [] if run.run_id == "r1"],
    )

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$r1",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$r1") is True

    assert _live(storage) == ["p"]
    assert _summary(_stored(storage)) is None


@pytest.mark.parametrize("removal", ["edit", "redaction"])
def test_removing_an_archived_run_removes_runs_saved_after_the_newest_live_run_went(
    storage: SqliteDb,
    removal: str,
) -> None:
    """Runs saved after compaction and an edit of the newest reply still follow every archived run."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _run("r3"))
    archive_compaction_chunk(
        storage=storage,
        session=session,
        scope=_SCOPE,
        summary=SessionSummary(summary="r1 r2", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in session.runs or [] if run.run_id in {"r1", "r2"}],
    )
    assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$r3",)) is True
    for run_id in ("r4", "r5"):
        storage.upsert_run(run=_run(run_id), session_id="session", user_id=None)
    assert _live(storage) == ["r4", "r5"]

    if removal == "edit":
        assert remove_runs_for_sources(storage, "session", SessionType.AGENT, _SCOPE, ("$r2",)) is True
    else:
        assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$r2") is True

    assert _live(storage) == ["r1"]
    assert _summary(_stored(storage)) is None


def test_a_fold_a_crash_kept_out_of_its_run_is_resolved_before_redaction(storage: SqliteDb) -> None:
    """Redacting a run an unapplied fold covered keeps the run that fold would have shortened."""
    session = _seed_runs(storage, _run("r1"), _paused("p"), _run("b"))
    _fold(storage, session, "p", ["r1", "b"], applied=False)

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$b") is True

    assert _live(storage) == ["r1", "p"]
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE.key) == []


def _team_run(run_id: str, *, parent_run_id: str | None = None) -> TeamRunOutput:
    return TeamRunOutput(
        run_id=run_id,
        team_id="crew",
        session_id="session",
        parent_run_id=parent_run_id,
        content=f"answer {run_id}",
        messages=[Message(role="user", content=f"question {run_id}")],
        metadata={
            constants.MATRIX_EVENT_ID_METADATA_KEY: f"${run_id}",
            constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY: [f"${run_id}"],
        },
    )


def test_redacting_a_team_turn_that_compacted_mid_turn_removes_its_member_runs(storage: SqliteDb) -> None:
    """A team turn's fold rolls back with the turn, and its delegated member runs go with it."""
    scope = HistoryScope(kind="team", scope_id="crew")
    live = _team_run("x")
    member = RunOutput(run_id="m", agent_id="helper", session_id="session", parent_run_id="x")
    session = seed_session(
        storage,
        TeamSession(session_id="session", team_id="crew", runs=[_team_run("r1"), _team_run("r2"), live, member]),
    )
    _fold(storage, session, "x", ["r1", "r2"], scope=scope)
    reconcile_compaction_state(storage, session, scope)

    assert _remove_redacted_event_from_history(storage, session, scope, event_id="$x") is True

    stored = get_team_session(storage, "session")
    assert stored is not None
    assert [run.run_id for run in stored.runs or []] == ["r1", "r2"]
    assert stored.summary is None


def test_redacting_an_event_of_a_folded_run_a_later_compaction_archived(storage: SqliteDb) -> None:
    """The fold, not the later archive of the whole run, decides where the rollback starts."""
    session = _seed_runs(storage, _run("r1"), _run("r2"), _live_run_with(["$x", "$mid"], reply="$reply"))
    _fold(storage, session, "x", ["r1", "r2"])
    reconcile_compaction_state(storage, session, _SCOPE)
    stored = _stored(storage)
    archive_compaction_chunk(
        storage=storage,
        session=stored,
        scope=_SCOPE,
        summary=SessionSummary(summary="everything through x", updated_at=datetime.now(UTC)),
        summary_model="summary-model",
        archived_runs=[run for run in stored.runs or [] if run.run_id == "x"],
    )

    assert _remove_redacted_event_from_history(storage, _stored(storage), _SCOPE, event_id="$mid") is True

    assert _live(storage) == ["r1", "r2"]
    assert _summary(_stored(storage)) is None
