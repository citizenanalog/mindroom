"""The compaction archive moves runs between the live table and durable history atomically."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING

import pytest
from agno.db.sqlite import SqliteDb
from agno.models.message import Message
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.session.agent import AgentSession
from agno.session.summary import SessionSummary

from mindroom.constants import MINDROOM_COMPACTION_METADATA_KEY, MINDROOM_MATRIX_HISTORY_METADATA_KEY
from mindroom.history import archive
from mindroom.history.archive_schema import archive_table_names
from mindroom.session_storage.agent_storage import create_state_storage, get_agent_session
from tests.conftest import seed_session
from tests.history_helpers import StoredGeneration, archived_content, compaction_generations

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

_SCOPE = "agent:code"


def _open(state_root: Path) -> SqliteDb:
    db = create_state_storage("code", state_root, subdir="sessions", session_table="code_sessions")
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


def _run(run_id: str, *, parent_run_id: str | None = None) -> RunOutput:
    return RunOutput(
        run_id=run_id,
        session_id="session",
        agent_id="code",
        parent_run_id=parent_run_id,
        user_id="@alice:example.test",
        content=f"answer {run_id}",
        messages=[Message(role="user", content=f"question {run_id}"), Message(role="assistant", content=run_id)],
    )


def _seed(storage: SqliteDb, run_ids: list[str], *, children: dict[str, str] | None = None) -> AgentSession:
    runs = [_run(run_id) for run_id in run_ids]
    runs.extend(_run(child, parent_run_id=parent) for child, parent in (children or {}).items())
    return seed_session(storage, AgentSession(session_id="session", agent_id="code", runs=runs))


def _live_run_ids(storage: SqliteDb) -> list[str]:
    session = get_agent_session(storage, "session")
    assert session is not None
    return [run.run_id for run in session.runs or [] if run.run_id]


def _archive(storage: SqliteDb, session: AgentSession, run_ids: list[str], summary: str) -> None:
    runs = [run for run in session.runs or [] if run.run_id in run_ids]
    archive.archive_runs(
        storage,
        session_id="session",
        scope_key=_SCOPE,
        summary=summary,
        summary_model="summary-model",
        runs=runs,
        event_ids={run_id: {f"${run_id}"} for run_id in run_ids},
        seen_event_ids={run_id: {f"${run_id}"} for run_id in run_ids},
    )


def test_archiving_moves_runs_and_member_runs_out_of_the_live_table(storage: SqliteDb) -> None:
    """Archived runs leave replay but stay readable with their summary generation."""
    session = _seed(storage, ["r1", "r2", "r3"], children={"r1-member": "r1"})

    _archive(storage, session, ["r1-member", "r1", "r2"], "summary one")

    assert _live_run_ids(storage) == ["r3"]
    assert archive.archived_run_ids(storage, session_id="session", run_ids=["r1", "r1-member", "r2", "r3"]) == {
        "r1",
        "r1-member",
        "r2",
    }
    assert compaction_generations(storage, _SCOPE, "session") == [
        StoredGeneration(summary="summary one", summary_model="summary-model", legacy=False),
    ]


def test_compacted_event_ids_are_scoped(storage: SqliteDb) -> None:
    """Seen ids come from the scope's own archive only."""
    session = _seed(storage, ["r1", "r2"])
    _archive(storage, session, ["r1"], "summary")
    archive.archive_runs(
        storage,
        session_id="session",
        scope_key="team:other",
        summary="other",
        summary_model="summary-model",
        runs=[run for run in session.runs or [] if run.run_id == "r2"],
        event_ids={"r2": {"$other"}},
        seen_event_ids={"r2": {"$other"}},
    )

    assert archive.compacted_event_ids(storage, session_id="session", scope_key=_SCOPE) == {"$r1"}
    assert archive.latest_generation(storage, session_id="session", scope_key="missing") is None


def test_roll_back_restores_earlier_runs_of_the_hit_generation_in_order(storage: SqliteDb) -> None:
    """Rolling back keeps the prior generation and restores the runs archived before the hit."""
    session = _seed(storage, ["r1", "r2", "r3", "r4", "r5", "r6"], children={"r4-member": "r4"})
    _archive(storage, session, ["r1"], "generation one")
    _archive(storage, session, ["r2", "r3", "r4-member", "r4"], "generation two")
    _archive(storage, session, ["r5"], "generation three")

    hit = archive.find_archived_event(storage, session_id="session", scope_key=_SCOPE, event_id="$r4")
    assert hit is not None
    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=["r6"])

    assert _live_run_ids(storage) == ["r2", "r3"]
    restored = get_agent_session(storage, "session")
    assert restored is not None
    assert [message.content for message in restored.runs[0].messages or []] == ["question r2", "r2"]
    generation = archive.latest_generation(storage, session_id="session", scope_key=_SCOPE)
    assert generation is not None
    assert generation.summary == "generation one"
    # Restored runs leave the archive; removed ones stay as content-free tombstones.
    assert archived_content(storage, "session") == {"r1": True, "r4": False, "r4-member": False, "r5": False}


def test_roll_back_restores_runs_at_their_original_indexes_after_reopening(tmp_path: Path) -> None:
    """A restored run returns before a later run that compaction skipped, such as a pending approval."""
    storage = _open(tmp_path)
    paused = _run("p")
    paused.status = RunStatus.paused
    session = seed_session(
        storage,
        AgentSession(session_id="session", agent_id="code", runs=[_run("r1"), paused, _run("x")]),
    )
    _archive(storage, session, ["r1", "x"], "r1 and x")
    hit = archive.find_archived_event(storage, session_id="session", scope_key=_SCOPE, event_id="$x")
    assert hit is not None

    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=())
    storage.close()
    reopened = _open(tmp_path)
    try:
        assert _live_run_ids(reopened) == ["r1", "p"]
    finally:
        reopened.close()


def test_runs_archived_without_an_index_are_appended_in_archive_order(storage: SqliteDb) -> None:
    """Rows archived before runs kept their index return after the live runs, as they always did."""
    paused = _run("p")
    paused.status = RunStatus.paused
    session = seed_session(
        storage,
        AgentSession(session_id="session", agent_id="code", runs=[_run("r1"), _run("r2"), paused, _run("x")]),
    )
    _archive(storage, session, ["r1", "r2", "x"], "r1, r2, and x")
    _, compacted_runs = archive_table_names("code_sessions")
    with storage.db_engine.begin() as connection:
        connection.exec_driver_sql(f"UPDATE {compacted_runs} SET run_index = NULL")  # noqa: S608
    hit = archive.find_archived_event(storage, session_id="session", scope_key=_SCOPE, event_id="$x")
    assert hit is not None

    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=())

    assert _live_run_ids(storage) == ["p", "r1", "r2"]


def _with_previous_archive(tmp_path: Path) -> AgentSession:
    """Seed two runs beside an archive as the previous release created it, holding one generation."""
    storage = _open(tmp_path)
    session = _seed(storage, ["r1", "r2"])
    compactions, compacted_runs = archive_table_names("code_sessions")
    with storage.db_engine.begin() as connection:
        for statement in _PREVIOUS_ARCHIVE_DDL:
            connection.exec_driver_sql(statement.format(compactions=compactions, compacted_runs=compacted_runs))
        connection.exec_driver_sql(
            f"INSERT INTO {compactions} (session_id, scope_key, summary, created_at) VALUES ('session', ?, 'old', 0)",  # noqa: S608
            (_SCOPE,),
        )
    storage.close()
    return session


def test_an_existing_archive_gains_the_new_columns(tmp_path: Path) -> None:
    """Archives created before positioned generations read as unpositioned and accept the new fields."""
    session = _with_previous_archive(tmp_path)
    compactions, compacted_runs = archive_table_names("code_sessions")
    storage = _open(tmp_path)

    _archive(storage, session, ["r1"], "new")

    with storage.db_engine.begin() as connection:
        generation_columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({compactions})")}
        run_columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({compacted_runs})")}
        positions = [row[0] for row in connection.exec_driver_sql(f"SELECT through_run_id FROM {compactions}")]  # noqa: S608
    assert {"through_run_id", "covered_run_ids", "event_ids", "seen_event_ids"} <= generation_columns
    assert "run_index" in run_columns
    assert positions == [None, None]
    storage.close()


def test_opening_the_database_upgrades_an_existing_archive_before_any_reply_uses_it(tmp_path: Path) -> None:
    """Rooms then use the archive concurrently without altering it, so none races another on the new columns."""
    _with_previous_archive(tmp_path)
    compactions, compacted_runs = archive_table_names("code_sessions")

    storage = _open(tmp_path)

    with storage.db_engine.connect() as connection:
        generation_columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({compactions})")}
        run_columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({compacted_runs})")}
    assert {"through_run_id", "covered_run_ids", "event_ids", "seen_event_ids"} <= generation_columns
    assert "run_index" in run_columns
    storage.close()


def test_concurrent_opens_of_an_existing_archive_all_succeed(tmp_path: Path) -> None:
    """The upgrade runs once under the database's write lock, and every other opener finds it done."""
    _with_previous_archive(tmp_path)
    ready = threading.Barrier(8)
    failures: list[BaseException] = []

    def open_and_read() -> None:
        ready.wait()
        try:
            storage = _open(tmp_path)
            try:
                assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE) == []
            finally:
                storage.close()
        except BaseException as error:
            failures.append(error)

    threads = [threading.Thread(target=open_and_read) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert failures == []


_PREVIOUS_ARCHIVE_DDL = (
    "CREATE TABLE {compactions} (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, scope_key TEXT NOT NULL, "
    "summary TEXT, summary_model TEXT, legacy INTEGER NOT NULL DEFAULT 0, legacy_event_ids TEXT, "
    "created_at INTEGER NOT NULL)",
    "CREATE TABLE {compacted_runs} (id INTEGER PRIMARY KEY, compaction_id INTEGER NOT NULL, session_id TEXT NOT NULL, "
    "run_id TEXT NOT NULL, run_type TEXT, event_ids TEXT NOT NULL, seen_event_ids TEXT NOT NULL DEFAULT '[]', "
    "run_data TEXT, UNIQUE(session_id, run_id))",
)


def _position(storage: SqliteDb, through_run_id: str, covered: list[str], summary: str = "positioned") -> int:
    return archive.record_positioned_generation(
        storage,
        session_id="session",
        scope_key=_SCOPE,
        summary=summary,
        summary_model="summary-model",
        through_run_id=through_run_id,
        covered_run_ids=covered,
        event_ids={f"${run_id}" for run_id in [*covered, through_run_id]},
        seen_event_ids={f"${run_id}" for run_id in [*covered, through_run_id]},
    )


def _materialize(storage: SqliteDb, generation_id: int, run_ids: list[str]) -> None:
    session = get_agent_session(storage, "session")
    assert session is not None
    archive.add_runs_to_generation(
        storage,
        session_id="session",
        generation_id=generation_id,
        runs=[run for run in session.runs or [] if run.run_id in run_ids],
        event_ids={run_id: {f"${run_id}"} for run_id in run_ids},
        seen_event_ids={run_id: {f"${run_id}"} for run_id in run_ids},
    )


def test_positioned_generation_counts_its_events_as_compacted(storage: SqliteDb) -> None:
    """A summary covering a running run's folded input represents those events before any run is archived."""
    _seed(storage, ["r1", "x"])
    _position(storage, "x", ["r1"])

    assert archive.compacted_event_ids(storage, session_id="session", scope_key=_SCOPE) == {"$r1", "$x"}
    positioned = archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE)
    assert [(generation.through_run_id, generation.covered_run_ids) for generation in positioned] == [("x", ("r1",))]


def test_earliest_dependent_generation_finds_covering_and_positioned_generations(storage: SqliteDb) -> None:
    """A covered run, the position run, and an archived run all lead back to the generation that first used them."""
    session = _seed(storage, ["r1", "r2", "x", "y"])
    _archive(storage, session, ["r1"], "r1")
    generation_id = _position(storage, "x", ["r2"])
    _materialize(storage, generation_id, ["r2"])

    def hit_for(run_id: str) -> int | None:
        hit = archive.earliest_dependent_generation(
            storage,
            session_id="session",
            scope_key=_SCOPE,
            run_ids=[run_id],
        )
        return hit.generation_id if hit is not None else None

    assert hit_for("r2") == generation_id
    assert hit_for("x") == generation_id
    assert hit_for("r1") == generation_id - 1
    assert hit_for("y") is None


def test_rolling_back_a_positioned_generation_removes_its_position_run(storage: SqliteDb) -> None:
    """Undoing a fold drops the shortened run it produced and returns the runs it covered."""
    _seed(storage, ["r1", "x"], children={"x-member": "x"})
    generation_id = _position(storage, "x", ["r1"])
    _materialize(storage, generation_id, ["r1"])
    hit = archive.earliest_dependent_generation(storage, session_id="session", scope_key=_SCOPE, run_ids=["x"])
    assert hit is not None

    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=())

    assert _live_run_ids(storage) == ["r1"]
    assert archive.compacted_event_ids(storage, session_id="session", scope_key=_SCOPE) == set()
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE) == []


def test_retiring_summaries_removes_shortened_position_runs(storage: SqliteDb) -> None:
    """A retired fold leaves no shortened run behind, live or archived, for a later rollback to restore."""
    session = _seed(storage, ["r1", "x", "q", "w"])
    generation_id = _position(storage, "x", ["r1"])
    _materialize(storage, generation_id, ["r1"])
    _archive(storage, session, ["x", "q"], "x and q")
    _position(storage, "w", [])

    archive.retire_summaries(storage, session_id="session", scope_key=_SCOPE)
    hit = archive.find_archived_event(storage, session_id="session", scope_key=_SCOPE, event_id="$q")
    assert hit is not None
    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=())

    assert "x" not in _live_run_ids(storage)
    assert "w" not in _live_run_ids(storage)
    assert archive.positioned_generations(storage, session_id="session", scope_key=_SCOPE) == []


def test_roll_back_drops_member_runs_archived_before_their_hit_team_run(storage: SqliteDb) -> None:
    """A member run stored ahead of the redacted run leaves with it instead of being restored."""
    session = seed_session(
        storage,
        AgentSession(
            session_id="session",
            agent_id="code",
            runs=[_run("r1"), _run("r2-member", parent_run_id="r2"), _run("r2")],
        ),
    )
    _archive(storage, session, ["r1", "r2-member", "r2"], "generation one")

    hit = archive.find_archived_event(storage, session_id="session", scope_key=_SCOPE, event_id="$r2")
    assert hit is not None
    archive.roll_back_to(storage, session_id="session", scope_key=_SCOPE, hit=hit, live_run_ids=[])

    assert _live_run_ids(storage) == ["r1"]


def test_clear_to_legacy_keeps_only_content_free_tombstones(tmp_path: Path) -> None:
    """Legacy invalidation drops archived content and live runs but keeps legacy tombstones."""
    seeding = _open(tmp_path / "legacy")
    seed_session(
        seeding,
        AgentSession(
            session_id="session",
            agent_id="code",
            runs=[_run("r2"), _run("r3")],
            summary=SessionSummary(summary="legacy summary"),
            metadata={
                MINDROOM_COMPACTION_METADATA_KEY: {"version": 2, "states": {_SCOPE: {"compacted_run_ids": ["gone"]}}},
                MINDROOM_MATRIX_HISTORY_METADATA_KEY: {
                    "version": 1,
                    "states": {_SCOPE: {"seen_event_ids": ["$legacy"]}},
                },
            },
        ),
    )
    seeding.close()
    storage = _open(tmp_path / "legacy")
    try:
        session = get_agent_session(storage, "session")
        assert session is not None
        _archive(storage, session, ["r2"], "generation one")

        archive.clear_to_legacy(storage, session_id="session", scope_key=_SCOPE, live_run_ids=["r3"])

        assert _live_run_ids(storage) == []
        assert compaction_generations(storage, _SCOPE, "session") == [
            StoredGeneration(summary=None, summary_model=None, legacy=True),
        ]
        assert archive.legacy_event_ids(storage, session_id="session", scope_key=_SCOPE) == set()
        assert archived_content(storage, "session") == {"gone": False, "r2": False}
    finally:
        storage.close()


def test_session_deletion_cascades_to_the_archive(storage: SqliteDb) -> None:
    """Deleting a conversation also erases its archived history."""
    session = _seed(storage, ["r1"])
    _archive(storage, session, ["r1"], "summary")

    storage.delete_session("session")
    _seed(storage, ["fresh"])

    assert archive.latest_generation(storage, session_id="session", scope_key=_SCOPE) is None
    assert archive.archived_run_ids(storage, session_id="session", run_ids=["r1"]) == set()


def test_failed_run_deletion_rolls_back_the_archive_write(storage: SqliteDb, monkeypatch: pytest.MonkeyPatch) -> None:
    """The archive insert and the live-row deletion commit together or not at all."""
    session = _seed(storage, ["r1"])

    def fail_deletion(*_args: object) -> None:
        msg = "process stopped"
        raise RuntimeError(msg)

    monkeypatch.setattr(archive, "delete_run_subtrees", fail_deletion)
    with pytest.raises(RuntimeError, match="process stopped"):
        _archive(storage, session, ["r1"], "summary")

    assert _live_run_ids(storage) == ["r1"]
    assert archive.latest_generation(storage, session_id="session", scope_key=_SCOPE) is None
    assert archive.archived_run_ids(storage, session_id="session", run_ids=["r1"]) == set()


def test_archive_requires_sqlite_storage() -> None:
    """Other storage types cannot hold the archive."""
    with pytest.raises(TypeError, match="SQLite"):
        archive.latest_generation(object(), session_id="session", scope_key=_SCOPE)  # type: ignore[arg-type]
