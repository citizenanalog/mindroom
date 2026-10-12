"""Shrinkable mixed-operation coverage for the compaction archive invariants.

Each example drives one conversation through appends, compaction chunks, chunks
interrupted after the archive commit, mid-turn folds positioned on the newest run or on
an older approval's resumed run (some lost to a crash before the run's record named them), stale whole-row session
writes, redactions, and reopens, starting from an empty or a pre-archive database. Summaries name the
runs they cover, so after every step (and the reconcile the next run would do)
the test can check exactly what replay represents.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path

import pytest
from agno.db.base import SessionType
from agno.db.sqlite import SqliteDb
from agno.models.message import Message
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.session.agent import AgentSession
from agno.session.summary import SessionSummary
from hypothesis import HealthCheck, example, given, settings
from hypothesis import strategies as st

from mindroom import constants
from mindroom.agent_storage import create_state_storage, get_agent_session
from mindroom.constants import MID_TURN_GENERATION_METADATA_KEY
from mindroom.history import archive
from mindroom.history.storage import (
    _remove_redacted_event_from_history,
    archive_compaction_chunk,
    read_scope_seen_event_ids,
    reconcile_compaction_state,
    record_mid_turn_generation,
    remove_runs_for_sources,
)
from mindroom.history.types import HistoryScope
from tests.conftest import seed_session
from tests.history_helpers import archived_content, archived_run_ids

_SCOPE = HistoryScope(kind="agent", scope_id="code")
_SESSION = "session"
_LEGACY_RUNS = ("legacy-1", "legacy-2")


@dataclass(frozen=True)
class Action:
    """One generated operation on the conversation."""

    kind: str
    count: int = 1
    index: int = 0


def _event(run_id: str) -> str:
    return f"${run_id}"


def _summary_of(run_ids: set[str]) -> str:
    return "|".join(sorted(run_ids))


def _seen_ids(run: RunOutput) -> set[str]:
    seen = (run.metadata or {}).get(constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY)
    return set(seen) if isinstance(seen, list) else set()


def _covered(session: AgentSession) -> set[str]:
    """Return the run ids the replayed summary covers."""
    return set(session.summary.summary.split("|")) if session.summary is not None else set()


class _Runner:
    """Drive one conversation and check the archive invariants after every step."""

    def __init__(self, root: Path, *, legacy: bool) -> None:
        self._root = root
        self._created: list[str] = []
        self._events: list[str] = []
        self._redacted: set[str] = set()
        self._ever_archived: set[str] = set()
        self._snapshots: list[AgentSession] = []
        # Runs waiting for an approval: stored but not history-visible, so a later run reads them as unseen context.
        self._paused: set[str] = set()
        # Run ids whose events each run read as unseen context; reading one makes it part of what that run represents.
        self._reads: dict[str, set[str]] = {}
        # The runs each applied fold covered; its position run depends on them, even when it is older.
        self._folds: dict[str, set[str]] = {}
        self._legacy = legacy
        self._retiring = False
        seeding = self._open()
        if legacy:
            seed_session(seeding, self._legacy_session())
            self._events.extend(_event(run_id) for run_id in _LEGACY_RUNS)
        else:
            seed_session(seeding, AgentSession(session_id=_SESSION, agent_id="code"))
        seeding.close()
        self._storage = self._open()
        self._present = self._present_run_ids()
        self._replayable = {run.run_id for run in self._load().runs or [] if run.run_id}

    def run(self, actions: list[Action]) -> None:
        operations = {
            "add": self._add,
            "pause": self._pause,
            "approve": self._approve,
            "compact": self._compact,
            "midturn": self._midturn,
            "resume_fold": self._resume_fold,
            "interrupt": self._interrupt,
            "snapshot": self._snapshot,
            "stale_write": self._stale_write,
            "resurrect": self._resurrect,
            "reopen": self._reopen,
        }
        for action in actions:
            if action.kind in {"redact", "edit"}:
                redacted_event_id = self._redact(action, edit=action.kind == "edit")
            else:
                redacted_event_id = operations[action.kind](action)
            self._check(redacted_event_id)

    def close(self) -> None:
        self._storage.close()

    def _open(self) -> SqliteDb:
        db = create_state_storage("code", self._root, subdir="sessions", session_table="code_sessions")
        assert isinstance(db, SqliteDb)
        return db

    @staticmethod
    def _legacy_session() -> AgentSession:
        """Return a session as the destructive compactor left it after folding the legacy runs."""
        return AgentSession(
            session_id=_SESSION,
            agent_id="code",
            summary=SessionSummary(summary=_summary_of(set(_LEGACY_RUNS))),
            metadata={
                constants.MINDROOM_COMPACTION_METADATA_KEY: {
                    "version": 2,
                    "states": {_SCOPE.key: {"compacted_run_ids": list(_LEGACY_RUNS)}},
                },
                constants.MINDROOM_MATRIX_HISTORY_METADATA_KEY: {
                    "version": 1,
                    "states": {_SCOPE.key: {"seen_event_ids": [_event(run_id) for run_id in _LEGACY_RUNS]}},
                },
            },
        )

    def _load(self) -> AgentSession:
        session = get_agent_session(self._storage, _SESSION)
        assert session is not None
        return session

    def _add(self, _action: Action, *, status: RunStatus = RunStatus.completed) -> None:
        run_id = f"r{len(self._created)}"
        self._storage.upsert_run(
            run=RunOutput(
                run_id=run_id,
                agent_id="code",
                session_id=_SESSION,
                status=status,
                content=f"answer {run_id}",
                messages=[Message(role="user", content=f"question {run_id}")],
                metadata={
                    constants.MATRIX_EVENT_ID_METADATA_KEY: _event(run_id),
                    constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY: [_event(run_id)],
                },
            ),
            session_id=_SESSION,
            user_id=None,
        )
        self._created.append(run_id)
        self._events.append(_event(run_id))
        if status is RunStatus.paused:
            self._paused.add(run_id)

    def _pause(self, action: Action) -> None:
        self._add(action, status=RunStatus.paused)

    def _approve(self, _action: Action) -> None:
        """Complete the oldest paused run that is still live, as an approval resume would."""
        session = self._load()
        paused = [run for run in session.runs or [] if isinstance(run, RunOutput) and run.run_id in self._paused]
        if not paused:
            return
        run = paused[0]
        run.status = RunStatus.completed
        self._storage.upsert_run(run=run, session_id=_SESSION, user_id=None)
        self._paused.discard(run.run_id or "")

    def _chunk(self, count: int) -> tuple[AgentSession, list[RunOutput], str] | None:
        """Return the oldest live runs a compaction would fold next, after the reconcile it runs first."""
        session = self._load()
        reconcile_compaction_state(self._storage, session, _SCOPE)
        session = self._load()
        # Compaction folds only history-visible runs, so a run waiting for an approval stays live.
        chunk = [run for run in session.runs or [] if isinstance(run, RunOutput) and run.run_id not in self._paused][
            :count
        ]
        if not chunk:
            return None
        return session, chunk, _summary_of(_covered(session) | {run.run_id for run in chunk if run.run_id})

    def _compact(self, action: Action) -> None:
        chunk = self._chunk(action.count)
        if chunk is None:
            return
        session, runs, summary = chunk
        self._ever_archived.update(run.run_id for run in runs if run.run_id)
        archive_compaction_chunk(
            storage=self._storage,
            session=session,
            scope=_SCOPE,
            summary=SessionSummary(summary=summary),
            summary_model="fuzz-model",
            archived_runs=runs,
        )

    def _midturn(self, action: Action) -> None:
        """Fold the earlier live runs and the newest one into a generation positioned on it; it stays live.

        Every third fold is lost to a crash before the run's record names it.
        """
        session = self._load()
        reconcile_compaction_state(self._storage, session, _SCOPE)
        session = self._load()
        live = [
            run
            for run in session.runs or []
            if isinstance(run, RunOutput) and run.run_id and run.run_id not in self._paused
        ]
        if not live:
            return
        *prior, current = live
        # The running run reads every paused run's prompt as unseen thread context, so its fold covers them too.
        unseen = sorted(
            run.run_id for run in session.runs or [] if isinstance(run, RunOutput) and run.run_id in self._paused
        )
        self._reads.setdefault(current.run_id or "", set()).update(unseen)
        current.metadata = {
            **(current.metadata or {}),
            constants.MATRIX_SEEN_EVENT_IDS_METADATA_KEY: [
                _event(current.run_id or ""),
                *map(_event, sorted(self._reads[current.run_id or ""])),
            ],
        }
        self._storage.upsert_run(run=current, session_id=_SESSION, user_id=None)
        generation_id = record_mid_turn_generation(
            self._storage,
            session=session,
            scope=_SCOPE,
            summary=_summary_of(_covered(session) | {run.run_id for run in live if run.run_id} | set(unseen)),
            summary_model="fuzz-model",
            position_run=current,
            covered_runs=prior,
        )
        if action.index % 3 == 0:
            return
        self._ever_archived.update(run.run_id for run in prior if run.run_id)
        self._folds[current.run_id or ""] = {run.run_id for run in prior if run.run_id}
        current.metadata = {**(current.metadata or {}), MID_TURN_GENERATION_METADATA_KEY: generation_id}
        self._storage.upsert_run(run=current, session_id=_SESSION, user_id=None)

    def _resume_fold(self, action: Action) -> None:
        """Approve the oldest paused run and fold, mid-turn, every live run, including newer ones, on it.

        That is what an approval resumed after later turns does when its continuation compacts. Every third
        fold is lost to a crash before the run's record names it, so the run stays paused.
        """
        session = self._load()
        reconcile_compaction_state(self._storage, session, _SCOPE)
        session = self._load()
        runs = [run for run in session.runs or [] if isinstance(run, RunOutput) and run.run_id]
        paused = [run for run in runs if run.run_id in self._paused]
        covered = [run for run in runs if run.run_id not in self._paused]
        if not paused or not covered:
            return
        current = paused[0]
        generation_id = record_mid_turn_generation(
            self._storage,
            session=session,
            scope=_SCOPE,
            summary=_summary_of(_covered(session) | {run.run_id for run in [*covered, current] if run.run_id}),
            summary_model="fuzz-model",
            position_run=current,
            covered_runs=covered,
        )
        if action.index % 3 == 0:
            return
        self._ever_archived.update(run.run_id for run in covered if run.run_id)
        self._folds[current.run_id or ""] = {run.run_id for run in covered if run.run_id}
        current.status = RunStatus.completed
        current.metadata = {**(current.metadata or {}), MID_TURN_GENERATION_METADATA_KEY: generation_id}
        self._storage.upsert_run(run=current, session_id=_SESSION, user_id=None)
        self._paused.discard(current.run_id or "")

    def _interrupt(self, action: Action) -> None:
        """Commit a chunk's archive transaction but lose the session write that follows it."""
        chunk = self._chunk(action.count)
        if chunk is None:
            return
        _session, runs, summary = chunk
        self._ever_archived.update(run.run_id for run in runs if run.run_id)
        archive.archive_runs(
            self._storage,
            session_id=_SESSION,
            scope_key=_SCOPE.key,
            summary=summary,
            summary_model="fuzz-model",
            runs=runs,
            # The same ids compaction derives from each run's metadata, including events it read as context.
            event_ids={run.run_id: _seen_ids(run) for run in runs if run.run_id},
            seen_event_ids={run.run_id: _seen_ids(run) for run in runs if run.run_id},
        )

    def _snapshot(self, _action: Action) -> None:
        self._snapshots.append(self._load())

    def _stale_write(self, action: Action) -> None:
        """Write an older snapshot's whole session row back, as a concurrent run's end would."""
        if self._snapshots:
            self._storage.upsert_session(self._snapshots[action.index % len(self._snapshots)])

    def _resurrect(self, action: Action) -> None:
        """Save an old copy of a run compaction archived as live again, as a late run save would.

        That includes runs a redaction later removed, which must not replay either.
        """
        candidates = self._ever_archived - {run.run_id for run in self._load().runs or []}
        copies = [run for snapshot in self._snapshots for run in snapshot.runs or [] if run.run_id in candidates]
        if copies:
            run = copies[action.index % len(copies)]
            self._storage.upsert_run(run=run, session_id=_SESSION, user_id=None)

    def _redact(self, action: Action, *, edit: bool = False) -> str | None:
        """Redact an event, or edit the message whose run answered it; either way its content must leave history."""
        # An edit regenerates a reply, so it targets a message whose run this conversation created.
        candidates = [_event(run_id) for run_id in self._created] if edit else self._events
        if not candidates:
            return None
        event_id = candidates[action.index % len(candidates)]
        # A legacy summary's provenance cannot be split by run, so redacting under it may retire every summary.
        self._retiring = self._legacy and archive.has_legacy_summary(
            self._storage,
            session_id=_SESSION,
            scope_key=_SCOPE.key,
        )
        if edit:
            remove_runs_for_sources(self._storage, _SESSION, SessionType.AGENT, _SCOPE, (event_id,))
        else:
            _remove_redacted_event_from_history(self._storage, self._load(), _SCOPE, event_id=event_id)
        self._redacted.add(event_id)
        return event_id

    def _reopen(self, _action: Action) -> None:
        self._storage.close()
        self._storage = self._open()

    def _archived_content_ids(self) -> set[str]:
        return set(archived_run_ids(self._storage, _SESSION)) - set(_LEGACY_RUNS)

    def _archived_event_ids(self) -> set[str]:
        with self._storage.db_engine.connect() as connection:
            return {
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT value FROM code_sessions_compacted_runs AS archived, json_each(archived.event_ids) "
                    "WHERE archived.session_id = ?",
                    (_SESSION,),
                )
            }

    def _present_run_ids(self) -> set[str]:
        return {run.run_id for run in self._load().runs or [] if run.run_id} | self._archived_content_ids()

    def _depending_on(self, removed: set[str]) -> set[str]:
        """Return ``removed`` with every fold position run that depends on it, even an older one."""
        # A fold depends on every run it covered; retiring a legacy summary takes every fold with it.
        return removed | {position for position, covered in self._folds.items() if covered & removed or self._retiring}

    def _check(self, redacted_event_id: str | None) -> None:
        session = self._load()
        reconcile_compaction_state(self._storage, session, _SCOPE)
        session = self._load()
        live = {run.run_id for run in session.runs or [] if run.run_id}
        self._paused &= live
        archived = self._archived_content_ids()
        covered = _covered(session)

        # Compacted runs never reappear in replay.
        assert not live & archived
        # The cached summary is the latest generation's.
        generation = archive.latest_generation(self._storage, session_id=_SESSION, scope_key=_SCOPE.key)
        if generation is not None:
            assert (session.summary.summary if session.summary is not None else None) == generation.summary
        # Redacted content is gone from live runs, the archive, and the replayed summary.
        archived_event_ids = self._archived_event_ids()
        for event_id in self._redacted:
            assert event_id[1:] not in live
            assert event_id[1:] not in covered
            assert event_id not in archived_event_ids
        # Nothing is lost except by redacting that run or an earlier one.
        present = live | archived
        # Tombstones keep a removed run's id without its content.
        replayable = live | {run_id for run_id, stored in archived_content(self._storage, _SESSION).items() if stored}
        lost = self._present - present
        if redacted_event_id is None:
            assert not lost
        elif redacted_event_id[1:] in self._created:
            # Redaction removes the first run that answered or read the event, and every run after it.
            readers = [run_id for run_id, read in self._reads.items() if redacted_event_id[1:] in read]
            sources = [redacted_event_id[1:], *readers]
            first = min(self._created.index(run_id) for run_id in sources)
            assert lost <= self._depending_on(set(self._created[first:]))
            # When one of them still replayed, it and every run after it are gone.
            if remaining := [run_id for run_id in sources if run_id in self._replayable]:
                gone = self._depending_on(set(self._created[min(map(self._created.index, remaining)) :]))
                assert not gone & replayable
        self._present = present
        self._replayable = replayable
        # Seen ids are exactly the events replay represents, so nothing is repeated or dropped; a paused run is
        # not history-visible, so only a summary that read it represents it.
        represented = (live - self._paused) | covered
        expected_seen = {_event(run_id) for run_id in represented} | {
            _event(read) for run_id in represented for read in self._reads.get(run_id, ())
        }
        assert read_scope_seen_event_ids(self._storage, session, _SCOPE) == expected_seen


_ACTIONS = st.builds(
    Action,
    kind=st.sampled_from(
        (
            "add",
            "add",
            "add",
            "pause",
            "approve",
            "compact",
            "midturn",
            "resume_fold",
            "interrupt",
            "snapshot",
            "stale_write",
            "resurrect",
            "redact",
            "edit",
            "reopen",
        ),
    ),
    count=st.integers(1, 3),
    index=st.integers(0, 30),
)


@pytest.mark.timeout(300)
@settings(max_examples=60, deadline=None, print_blob=True, suppress_health_check=[HealthCheck.too_slow])
@given(actions=st.lists(_ACTIONS, min_size=1, max_size=30), legacy=st.booleans())
@example(
    actions=[
        Action("add"),
        Action("add"),
        Action("snapshot"),
        Action("compact"),
        Action("interrupt"),
        Action("redact", index=3),
        Action("stale_write"),
        Action("reopen"),
    ],
    legacy=True,
)
@example(
    actions=[
        Action("add"),
        Action("add"),
        Action("add"),
        Action("snapshot"),
        Action("compact", count=2),
        Action("resurrect"),
        Action("compact"),
        Action("redact", index=1),
        Action("stale_write"),
        Action("add"),
        Action("compact", count=2),
    ],
    legacy=False,
)
@example(
    # Retiring a legacy summary for a live redaction leaves archived runs outside replay.
    actions=[
        Action("add"),
        Action("add"),
        Action("compact"),
        Action("redact", index=3),
        Action("add"),
        Action("compact"),
    ],
    legacy=True,
)
@example(
    # A stale copy of a run that a redaction rolled back out of the archive is saved again.
    actions=[
        Action("add"),
        Action("add"),
        Action("snapshot"),
        Action("compact"),
        Action("redact", index=0),
        Action("resurrect"),
    ],
    legacy=False,
)
@example(
    # A run that compacted mid-turn, then compacted again and finished, is redacted by an event only it carries.
    actions=[
        Action("add"),
        Action("add"),
        Action("midturn", index=1),
        Action("midturn", index=2),
        Action("add"),
        Action("compact", count=2),
        Action("redact", index=1),
    ],
    legacy=False,
)
@example(
    # A fold a crash kept out of its run's record, then a redaction of a run it covered.
    actions=[Action("add"), Action("add"), Action("midturn", index=0), Action("redact", index=0), Action("reopen")],
    legacy=False,
)
@example(
    # A materialized fold, then a later compaction of its run, then a redaction of a run it covered.
    actions=[
        Action("add"),
        Action("add"),
        Action("add"),
        Action("midturn", index=1),
        Action("add"),
        Action("compact", count=2),
        Action("redact", index=1),
        Action("stale_write"),
    ],
    legacy=True,
)
@example(
    # A fold reads a paused run as unseen context, the run completes and is archived with the fold's run, and its
    # event is redacted.
    actions=[
        Action("add"),
        Action("pause"),
        Action("add"),
        Action("midturn", index=1),
        Action("approve"),
        Action("compact", count=3),
        Action("redact", index=1),
    ],
    legacy=False,
)
@example(
    # An edit of a message whose run a later fold covered and a reconcile archived.
    actions=[Action("add"), Action("add"), Action("midturn", index=1), Action("add"), Action("edit", index=0)],
    legacy=False,
)
@example(
    # An approval resumed after later turns folds them, then a newer run it covered is redacted.
    actions=[
        Action("add"),
        Action("pause"),
        Action("add"),
        Action("add"),
        Action("resume_fold", index=1),
        Action("redact", index=3),
    ],
    legacy=False,
)
@example(
    # The same fold archived by a reconcile, then an edit of the resumed run's own message.
    actions=[
        Action("add"),
        Action("pause"),
        Action("add"),
        Action("resume_fold", index=1),
        Action("snapshot"),
        Action("edit", index=1),
    ],
    legacy=False,
)
@example(
    # A fold's own run is archived by a later compaction and redacted; the run after it replayed the fold.
    actions=[Action("add"), Action("midturn", index=1), Action("add"), Action("compact"), Action("redact", index=0)],
    legacy=False,
)
@example(
    # A compaction archives every run, the newest is edited, and later runs follow a redacted archived run.
    actions=[
        Action("add"),
        Action("add"),
        Action("add"),
        Action("compact", count=2),
        Action("edit", index=2),
        Action("add"),
        Action("add"),
        Action("redact", index=1),
    ],
    legacy=False,
)
def test_generated_compaction_histories_keep_the_archive_invariants(actions: list[Action], *, legacy: bool) -> None:
    """Interleaved compaction, interruption, stale writes, and redaction never lose or leak history."""
    with tempfile.TemporaryDirectory() as root:
        runner = _Runner(Path(root), legacy=legacy)
        try:
            runner.run(actions)
        finally:
            runner.close()
