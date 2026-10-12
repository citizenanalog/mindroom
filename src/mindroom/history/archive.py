"""Durable archive of compacted runs and the summary generations that replaced them.

Compaction moves runs out of Agno's live runs table instead of deleting them.
Replay still sees only live runs plus ``session.summary``, while every folded
run stays readable here, together with the chain of summaries that covered it.

Two tables live beside ``<session_table>_usage`` in the conversation database:

- ``<session_table>_compactions``: one generation per persisted compaction chunk,
  holding the cumulative summary after that chunk.
- ``<session_table>_compacted_runs``: the archived run JSON in archive order, with
  the Matrix event ids each run represents.

Both cascade from the session row. Every write that moves runs between the live
table and the archive happens in one transaction with the matching run-row change.
The archive only grows: redaction replaces removed runs with content-free
tombstones, and only session deletion removes rows.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from agno.db.sqlite import SqliteDb
from agno.db.utils import deserialize_run, get_run_type
from sqlalchemy import select

from mindroom.history.archive_schema import archive_schema_sql, archive_table_names
from mindroom.session_storage import agno_compat_sqlite
from mindroom.session_storage.agent_storage import delete_run_subtrees, runs_without
from mindroom.usage.storage import quote_identifier

if TYPE_CHECKING:
    from collections.abc import Collection, Mapping, Sequence

    from agno.db.base import BaseDb
    from agno.run.agent import RunOutput
    from agno.run.team import TeamRunOutput
    from sqlalchemy import Connection, Table
    from sqlalchemy.orm import Session

_ID_CHUNK_SIZE = 500


@dataclass(frozen=True)
class _ArchivedGeneration:
    """The newest persisted compaction generation of a scope."""

    summary: str | None


@dataclass(frozen=True)
class PositionedGeneration:
    """A generation a mid-turn compaction wrote: it covers stored runs and the folded part of one running run."""

    id: int
    through_run_id: str
    covered_run_ids: tuple[str, ...]


@dataclass(frozen=True)
class _ArchiveHit:
    """The first archived run of a scope that represents one Matrix event, or a fold that depends on a run."""

    generation_id: int
    archived_row_id: int
    run_id: str


def archive_runs(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    summary: str,
    summary_model: str,
    runs: Sequence[RunOutput | TeamRunOutput],
    event_ids: Mapping[str, Collection[str]],
    seen_event_ids: Mapping[str, Collection[str]],
) -> None:
    """Record one generation and move ``runs`` from the live table into the archive atomically.

    ``runs`` is the complete removed subtree in stored order, member runs included.
    ``event_ids`` names every event redaction matches a run by; ``seen_event_ids`` the
    events it counts as seen while the summary covers it.
    A run that is already archived keeps its original generation: that earliest
    summary is the one that first folded it, so redaction must roll back to it.
    """
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with agno_compat_sqlite.run_deletion_transaction(db) as (transaction, runs_table, sessions_table):
        connection = transaction.connection()
        _ensure_tables(connection, db)
        compaction_id = connection.exec_driver_sql(
            f"INSERT INTO {compactions} (session_id, scope_key, summary, summary_model, created_at) "  # noqa: S608
            "VALUES (?, ?, ?, ?, ?)",
            (session_id, scope_key, summary, summary_model, int(time.time())),
        ).lastrowid
        _move_runs(
            transaction,
            db,
            runs_table,
            sessions_table,
            compaction_id,
            session_id,
            runs,
            event_ids,
            seen_event_ids,
        )


def add_runs_to_generation(
    storage: BaseDb,
    *,
    session_id: str,
    generation_id: int,
    runs: Sequence[RunOutput | TeamRunOutput],
    event_ids: Mapping[str, Collection[str]],
    seen_event_ids: Mapping[str, Collection[str]],
) -> None:
    """Move ``runs`` into an existing generation, which is how a positioned generation receives its covered runs."""
    db = _sqlite(storage)
    with agno_compat_sqlite.run_deletion_transaction(db) as (transaction, runs_table, sessions_table):
        _ensure_tables(transaction.connection(), db)
        _move_runs(
            transaction,
            db,
            runs_table,
            sessions_table,
            generation_id,
            session_id,
            runs,
            event_ids,
            seen_event_ids,
        )


def _move_runs(
    transaction: Session,
    db: SqliteDb,
    runs_table: Table | None,
    sessions_table: Table | None,
    compaction_id: int,
    session_id: str,
    runs: Sequence[RunOutput | TeamRunOutput],
    event_ids: Mapping[str, Collection[str]],
    seen_event_ids: Mapping[str, Collection[str]],
) -> None:
    """Archive ``runs`` under ``compaction_id`` with their live-table indexes, then delete their live rows."""
    _, compacted_runs = _table_names(db)
    archived = [(run.run_id, run) for run in runs if run.run_id]
    if archived:
        indexes = (
            agno_compat_sqlite.stored_run_indexes(
                transaction,
                runs_table,
                [run_id for run_id, _ in archived],
                session_id=session_id,
            )
            if runs_table is not None
            else {}
        )
        transaction.connection().exec_driver_sql(
            f"INSERT INTO {compacted_runs} "  # noqa: S608
            "(compaction_id, session_id, run_id, run_type, event_ids, seen_event_ids, run_index, run_data) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, run_id) DO NOTHING",
            [
                (
                    compaction_id,
                    session_id,
                    run_id,
                    get_run_type(run),
                    json.dumps(sorted(event_ids.get(run_id, ()))),
                    json.dumps(sorted(seen_event_ids.get(run_id, ()))),
                    indexes.get(run_id),
                    json.dumps(run.to_dict()),
                )
                for run_id, run in archived
            ],
        )
    delete_run_subtrees(transaction, runs_table, sessions_table, [run_id for run_id, _ in archived])


def record_positioned_generation(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    summary: str,
    summary_model: str,
    through_run_id: str,
    covered_run_ids: Sequence[str],
    event_ids: Collection[str],
    seen_event_ids: Collection[str],
) -> int:
    """Record a generation whose summary covers ``covered_run_ids`` and the folded part of a running run.

    No run moves: the covered runs join it when reconcile materializes it, and its event ids count as
    compacted history meanwhile.
    """
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        return connection.exec_driver_sql(
            f"INSERT INTO {compactions} (session_id, scope_key, summary, summary_model, created_at, "  # noqa: S608
            "through_run_id, covered_run_ids, event_ids, seen_event_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                session_id,
                scope_key,
                summary,
                summary_model,
                int(time.time()),
                through_run_id,
                json.dumps(list(covered_run_ids)),
                json.dumps(sorted(event_ids)),
                json.dumps(sorted(seen_event_ids)),
            ),
        ).lastrowid


def positioned_generations(storage: BaseDb, *, session_id: str, scope_key: str) -> list[PositionedGeneration]:
    """Return the scope's positioned generations, oldest first."""
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        rows = connection.exec_driver_sql(
            f"SELECT id, through_run_id, covered_run_ids FROM {compactions} "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? AND through_run_id IS NOT NULL ORDER BY id",
            (session_id, scope_key),
        ).fetchall()
    return [
        PositionedGeneration(
            id=row[0],
            through_run_id=row[1],
            covered_run_ids=tuple(json.loads(row[2] or "[]")),
        )
        for row in rows
    ]


def delete_generations(storage: BaseDb, *, session_id: str, generation_ids: Collection[int]) -> None:
    """Delete generations that never took effect, such as a fold a crash kept out of its run's record."""
    if not generation_ids:
        return
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        connection.exec_driver_sql(
            f"DELETE FROM {compactions} WHERE session_id = ? AND id IN ({', '.join('?' for _ in generation_ids)})",  # noqa: S608
            (session_id, *generation_ids),
        )


# LEGACY_COMPAT: Content-free generations for history compacted before the archive existed.
# Legacy format: A scope whose runs the destructive compactor deleted, leaving only a
# ``session.summary``, tombstoned run ids, and preserved Matrix seen ids (see
# ``history/legacy_compaction_state.py`` for provenance and the one-time migration).
# Last legacy release: v2026.9.314; replacement: the next release archives compacted runs.
# Handling: The migration records a ``legacy`` generation holding that summary, the seen ids it
# may contain, and ``run_data``-free tombstone rows. ``compacted_event_ids`` counts those seen ids
# while the summary replays; ``has_legacy_summary``, ``legacy_event_ids``, ``clear_to_legacy``, and
# ``retire_summaries`` let redaction retire it as a whole, because it cannot be split by run.
# Coverage: tests/test_legacy_compaction_state.py and tests/test_compaction_redaction.py.
def has_legacy_summary(storage: BaseDb, *, session_id: str, scope_key: str) -> bool:
    """Return whether the scope still replays a summary written before the archive existed."""
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        row = connection.exec_driver_sql(
            f"SELECT 1 FROM {compactions} "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? AND legacy = 1 AND summary IS NOT NULL LIMIT 1",
            (session_id, scope_key),
        ).first()
    return row is not None


def legacy_event_ids(storage: BaseDb, *, session_id: str, scope_key: str) -> set[str]:
    """Return the Matrix event ids that summaries written before the archive may contain."""
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        rows = connection.exec_driver_sql(
            f"SELECT value FROM {compactions} AS generation, json_each(generation.legacy_event_ids) "  # noqa: S608
            "WHERE generation.session_id = ? AND generation.scope_key = ? AND generation.legacy = 1",
            (session_id, scope_key),
        ).fetchall()
    return {row[0] for row in rows}


def clear_to_legacy(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    live_run_ids: Collection[str],
) -> None:
    """Drop every archived generation and live run that may depend on content-free legacy history.

    The dropped generations' runs stay as tombstones.
    """
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with agno_compat_sqlite.run_deletion_transaction(db) as (transaction, runs_table, sessions_table):
        connection = transaction.connection()
        _ensure_tables(connection, db)
        delete_run_subtrees(transaction, runs_table, sessions_table, live_run_ids)
        archive_era = [
            generation_id
            for (generation_id,) in connection.exec_driver_sql(
                f"SELECT id FROM {compactions} WHERE session_id = ? AND scope_key = ? AND legacy = 0",  # noqa: S608
                (session_id, scope_key),
            )
        ]
        _retire_generations(connection, db, session_id=session_id, scope_key=scope_key, generation_ids=archive_era)
        _clear_summaries(connection, db, session_id=session_id, scope_key=scope_key)


def retire_summaries(storage: BaseDb, *, session_id: str, scope_key: str) -> None:
    """Stop replaying every summary of the scope while its live and archived runs stay stored.

    Archived runs of retired generations no longer count as compacted history. A mid-turn fold's position run is
    the exception: its record lacks the messages the retired summary replaced, so it is deleted when live and
    turned into a tombstone when archived.
    """
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with agno_compat_sqlite.run_deletion_transaction(db) as (transaction, runs_table, sessions_table):
        connection = transaction.connection()
        _ensure_tables(connection, db)
        # A retired fold's position run lacks the messages its summary replaced, live or archived.
        position_run_ids = _position_run_ids(connection, compactions, session_id, scope_key, 0)
        delete_run_subtrees(transaction, runs_table, sessions_table, position_run_ids)
        _tombstone_archived_subtrees(connection, db, session_id=session_id, run_ids=position_run_ids)
        _clear_summaries(connection, db, session_id=session_id, scope_key=scope_key)


_END_OF_GENERATION = 2**63 - 1


def _position_run_ids(
    connection: Connection,
    compactions: str,
    session_id: str,
    scope_key: str,
    from_generation_id: int,
) -> list[str]:
    return [
        run_id
        for (run_id,) in connection.exec_driver_sql(
            f"SELECT DISTINCT through_run_id FROM {compactions} "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? AND id >= ? AND through_run_id IS NOT NULL",
            (session_id, scope_key, from_generation_id),
        )
    ]


def _tombstone_archived_subtrees(
    connection: Connection,
    db: SqliteDb,
    *,
    session_id: str,
    run_ids: Collection[str],
) -> None:
    """Clear the content of archived runs and their archived member runs, keeping them as tombstones."""
    _, compacted_runs = _table_names(db)
    parents: dict[str, object] = {
        row[0]: row[1]
        for row in connection.exec_driver_sql(
            f"SELECT run_id, json_extract(run_data, '$.parent_run_id') FROM {compacted_runs} "  # noqa: S608
            "WHERE session_id = ? AND run_data IS NOT NULL",
            (session_id,),
        )
    }
    doomed = {run_id for run_id in run_ids if run_id in parents}
    while added := {run_id for run_id, parent in parents.items() if parent in doomed and run_id not in doomed}:
        doomed |= added
    if doomed:
        connection.exec_driver_sql(
            f"UPDATE {compacted_runs} SET run_type = NULL, run_data = NULL "  # noqa: S608
            f"WHERE session_id = ? AND run_id IN ({', '.join('?' for _ in doomed)})",
            (session_id, *doomed),
        )


def _clear_summaries(connection: Connection, db: SqliteDb, *, session_id: str, scope_key: str) -> None:
    compactions, _ = _table_names(db)
    connection.exec_driver_sql(
        f"UPDATE {compactions} SET summary = NULL, legacy_event_ids = '[]', through_run_id = NULL, "  # noqa: S608
        "covered_run_ids = NULL, event_ids = NULL, seen_event_ids = NULL WHERE session_id = ? AND scope_key = ?",
        (session_id, scope_key),
    )


def latest_generation(storage: BaseDb, *, session_id: str, scope_key: str) -> _ArchivedGeneration | None:
    """Return the scope's newest generation, whose summary is the one in force."""
    db = _sqlite(storage)
    compactions, _ = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        row = connection.exec_driver_sql(
            f"SELECT summary FROM {compactions} "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? ORDER BY id DESC LIMIT 1",
            (session_id, scope_key),
        ).first()
    return None if row is None else _ArchivedGeneration(summary=row[0])


def archived_run_ids(
    storage: BaseDb,
    *,
    session_id: str,
    run_ids: Collection[str],
    with_content: bool = False,
) -> set[str]:
    """Return which of ``run_ids`` are archived in this session, or only those still holding content."""
    candidates = sorted({run_id for run_id in run_ids if run_id})
    if not candidates:
        return set()
    db = _sqlite(storage)
    _, compacted_runs = _table_names(db)
    found: set[str] = set()
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        for start in range(0, len(candidates), _ID_CHUNK_SIZE):
            chunk = candidates[start : start + _ID_CHUNK_SIZE]
            placeholders = ", ".join("?" for _ in chunk)
            found.update(
                row[0]
                for row in connection.exec_driver_sql(
                    f"SELECT run_id FROM {compacted_runs} "  # noqa: S608
                    f"WHERE session_id = ? AND run_id IN ({placeholders})"
                    + (" AND run_data IS NOT NULL" if with_content else ""),
                    (session_id, *chunk),
                )
            )
    return found


def compacted_event_ids(storage: BaseDb, *, session_id: str, scope_key: str) -> set[str]:
    """Return the Matrix event ids the scope's replayed summary represents.

    Summaries are cumulative until a generation without one, so archived runs count
    from the scope's latest summary-less generation onward. A legacy generation adds
    the seen ids captured with its summary, which are cleared when that summary is.
    """
    return _replayed_archive_event_ids(storage, session_id=session_id, scope_key=scope_key, column="seen_event_ids")


def redactable_compacted_event_ids(storage: BaseDb, *, session_id: str, scope_key: str) -> set[str]:
    """Return every Matrix event id the scope's replayed summary derives from, as redaction matches them."""
    return _replayed_archive_event_ids(storage, session_id=session_id, scope_key=scope_key, column="event_ids")


def _replayed_archive_event_ids(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    column: Literal["seen_event_ids", "event_ids"],
) -> set[str]:
    db = _sqlite(storage)
    compactions, compacted_runs = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        rows = connection.exec_driver_sql(
            f"SELECT value FROM {compacted_runs} AS archived, json_each(archived.{column}) "  # noqa: S608
            f"JOIN {compactions} AS generation ON generation.id = archived.compaction_id "
            "WHERE generation.session_id = ? AND generation.scope_key = ? AND generation.id > COALESCE("
            f"(SELECT MAX(id) FROM {compactions} WHERE session_id = ? AND scope_key = ? AND summary IS NULL), 0) "
            f"UNION SELECT value FROM {compactions} AS generation, json_each(generation.{column}) "
            "WHERE generation.session_id = ? AND generation.scope_key = ? AND generation.through_run_id IS NOT NULL "
            "AND generation.summary IS NOT NULL AND generation.id > COALESCE("
            f"(SELECT MAX(id) FROM {compactions} WHERE session_id = ? AND scope_key = ? AND summary IS NULL), 0) "
            f"UNION SELECT value FROM {compactions} AS generation, json_each(generation.legacy_event_ids) "
            "WHERE generation.session_id = ? AND generation.scope_key = ? AND generation.legacy = 1",
            (
                session_id,
                scope_key,
                session_id,
                scope_key,
                session_id,
                scope_key,
                session_id,
                scope_key,
                session_id,
                scope_key,
            ),
        ).fetchall()
    return {row[0] for row in rows}


def run_indexes(storage: BaseDb, *, session_id: str) -> dict[str, int]:
    """Return the index of each live and archived run, so a removal can bound its rollback by where they stood."""
    db = _sqlite(storage)
    _, compacted_runs = _table_names(db)
    runs = agno_compat_sqlite.owned_table(db, "runs")
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        archived = connection.exec_driver_sql(
            f"SELECT run_id, run_index FROM {compacted_runs} WHERE session_id = ?",  # noqa: S608
            (session_id,),
        )
        live = connection.execute(select(runs.c.run_id, runs.c.run_index).where(runs.c.session_id == session_id))
        return {run_id: run_index for run_id, run_index in [*archived, *live] if run_index is not None}


def find_archived_event(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    event_id: str,
) -> _ArchiveHit | None:
    """Return the first archived run of the scope that represents ``event_id``.

    A positioned generation that represents the event, such as one whose running run read it as unseen context,
    is a hit at the end of that generation, so the rollback undoes its fold.
    """
    db = _sqlite(storage)
    compactions, compacted_runs = _table_names(db)
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        row = connection.exec_driver_sql(
            f"SELECT archived.compaction_id, archived.id, archived.run_id FROM {compacted_runs} AS archived "  # noqa: S608
            f"JOIN {compactions} AS generation ON generation.id = archived.compaction_id "
            "WHERE generation.session_id = ? AND generation.scope_key = ? "
            "AND EXISTS (SELECT 1 FROM json_each(archived.event_ids) WHERE json_each.value = ?) "
            "ORDER BY archived.id LIMIT 1",
            (session_id, scope_key, event_id),
        ).first()
        positioned = connection.exec_driver_sql(
            f"SELECT id, through_run_id FROM {compactions} AS generation "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? AND through_run_id IS NOT NULL "
            "AND EXISTS (SELECT 1 FROM json_each(generation.event_ids) WHERE json_each.value = ?) ORDER BY id LIMIT 1",
            (session_id, scope_key, event_id),
        ).first()
    hits = [
        *([_ArchiveHit(generation_id=row[0], archived_row_id=row[1], run_id=row[2])] if row is not None else []),
        *(
            [_ArchiveHit(generation_id=positioned[0], archived_row_id=_END_OF_GENERATION, run_id=positioned[1])]
            if positioned is not None
            else []
        ),
    ]
    return min(hits, key=lambda hit: (hit.generation_id, hit.archived_row_id), default=None)


def earliest_dependent_generation(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    run_ids: Collection[str],
) -> _ArchiveHit | None:
    """Return the scope's earliest generation that archived, covers, or is positioned on one of ``run_ids``.

    The hit row is the earliest matching archived row of that generation, or the end of the generation when
    only its coverage or position matches, so a rollback restores the runs archived before the removed one.
    """
    wanted = {run_id for run_id in run_ids if run_id}
    if not wanted:
        return None
    db = _sqlite(storage)
    compactions, compacted_runs = _table_names(db)
    candidates: list[_ArchiveHit] = []
    with db.db_engine.begin() as connection:
        _ensure_tables(connection, db)
        rows = connection.exec_driver_sql(
            f"SELECT archived.compaction_id, archived.id, archived.run_id FROM {compacted_runs} AS archived "  # noqa: S608
            f"JOIN {compactions} AS generation ON generation.id = archived.compaction_id "
            "WHERE generation.session_id = ? AND generation.scope_key = ? AND archived.run_data IS NOT NULL "
            "ORDER BY archived.id",
            (session_id, scope_key),
        ).fetchall()
        candidates.extend(
            _ArchiveHit(generation_id=row[0], archived_row_id=row[1], run_id=row[2]) for row in rows if row[2] in wanted
        )
        for generation_id, through_run_id, covered in connection.exec_driver_sql(
            f"SELECT id, through_run_id, covered_run_ids FROM {compactions} "  # noqa: S608
            "WHERE session_id = ? AND scope_key = ? AND through_run_id IS NOT NULL",
            (session_id, scope_key),
        ):
            # The fold's position run when it depends on it, which takes the runs after it if it is archived.
            if through_run_id in wanted or (matched := wanted & set(json.loads(covered or "[]"))):
                candidates.append(
                    _ArchiveHit(
                        generation_id=generation_id,
                        archived_row_id=_END_OF_GENERATION,
                        run_id=through_run_id if through_run_id in wanted else min(matched),
                    ),
                )
    return min(candidates, key=lambda hit: (hit.generation_id, hit.archived_row_id), default=None)


def roll_back_to(
    storage: BaseDb,
    *,
    session_id: str,
    scope_key: str,
    hit: _ArchiveHit,
    live_run_ids: Collection[str],
    before_index: int | None = None,
) -> None:
    """Undo compaction from the hit's generation onward, keeping everything before the hit run.

    The hit run and everything after it (later archived runs and the given live runs)
    is removed; the hit generation's runs archived before it, and stored before
    ``before_index`` when given, return to the live table in their original order.
    Removed archived runs stay as tombstones.
    """
    db = _sqlite(storage)
    compactions, compacted_runs = _table_names(db)
    runs = agno_compat_sqlite.owned_table(db, "runs")
    with agno_compat_sqlite.run_deletion_transaction(db) as (transaction, runs_table, sessions_table):
        connection = transaction.connection()
        _ensure_tables(connection, db)
        indexes: dict[str, int | None] = {}
        earlier = []
        for run_type, run_data, run_index in connection.exec_driver_sql(
            # A row without an index, or a removal without a bound, compares as NULL, which keeps the row.
            f"SELECT run_type, run_data, run_index FROM {compacted_runs} "  # noqa: S608
            "WHERE compaction_id = ? AND id < ? AND run_data IS NOT NULL AND COALESCE(run_index < ?, 1) ORDER BY id",
            (hit.generation_id, hit.archived_row_id, before_index),
        ):
            run = deserialize_run(run_type, run_data)
            indexes[run.run_id or ""] = run_index
            earlier.append(run)
        # Member runs are archived with their team run and may precede it; the hit's own
        # members go with the hit.
        # A rolled-back fold's position run lacks the messages its summary replaced, so it goes wherever it is.
        position_run_ids = _position_run_ids(connection, compactions, session_id, scope_key, hit.generation_id)
        restored = runs_without(earlier, [hit.run_id, *position_run_ids])
        delete_run_subtrees(transaction, runs_table, sessions_table, [*live_run_ids, *position_run_ids])
        rolled_back = [
            generation_id
            for (generation_id,) in connection.exec_driver_sql(
                f"SELECT id FROM {compactions} WHERE session_id = ? AND scope_key = ? AND id >= ?",  # noqa: S608
                (session_id, scope_key, hit.generation_id),
            )
        ]
        _retire_generations(
            connection,
            db,
            session_id=session_id,
            scope_key=scope_key,
            generation_ids=rolled_back,
            restored_run_ids=[run.run_id for run in restored if run.run_id],
        )
        for run in restored:
            # LEGACY_COMPAT: Archived runs without their live-table index.
            # Legacy format: A ``compacted_runs`` row with a NULL ``run_index``, written before archived rows recorded
            # the run's index in the live table.
            # Last legacy release: v2026.10.258; replacement: the next release records ``run_index`` on every row.
            # Handling: The run is appended after the live runs in archive order, as before, so it can follow an
            # older live run that compaction skipped; rows with an index return to it. Removing such a run also
            # removes every live run, as before, since none can be placed after it (``storage.py``'s rollback cut).
            # Coverage: tests/test_history_archive.py::test_runs_archived_without_an_index_are_appended_in_archive_order;
            # tests/test_compaction_redaction.py::test_removing_an_archived_run_keeps_an_older_pending_approval.
            agno_compat_sqlite.insert_run_row(
                transaction,
                runs,
                run,
                session_table=db.session_table_name,
                session_id=session_id,
                user_id=run.user_id,
                run_index=indexes.get(run.run_id or ""),
            )


def _retire_generations(
    connection: Connection,
    db: SqliteDb,
    *,
    session_id: str,
    scope_key: str,
    generation_ids: Sequence[int],
    restored_run_ids: Sequence[str] = (),
) -> None:
    """Delete generations while their removed runs stay as content-free tombstones.

    A tombstone keeps a stale save of a removed run from replaying again, because
    reconcile prunes live runs the archive names. Restored runs leave the archive.
    Tombstones move to the newest surviving generation, or to a new empty one whose
    ``NULL`` summary keeps the scope archive-managed, so reconcile also clears a stale
    ``session.summary`` written back later instead of replaying it.
    """
    if not generation_ids:
        return
    compactions, compacted_runs = _table_names(db)
    retired = ", ".join("?" for _ in generation_ids)
    keeper = connection.exec_driver_sql(
        f"SELECT MAX(id) FROM {compactions} "  # noqa: S608
        f"WHERE session_id = ? AND scope_key = ? AND id NOT IN ({retired})",
        (session_id, scope_key, *generation_ids),
    ).scalar()
    if keeper is None:
        keeper = connection.exec_driver_sql(
            f"INSERT INTO {compactions} (session_id, scope_key, created_at) VALUES (?, ?, ?)",  # noqa: S608
            (session_id, scope_key, int(time.time())),
        ).lastrowid
    if restored_run_ids:
        connection.exec_driver_sql(
            f"DELETE FROM {compacted_runs} WHERE compaction_id IN ({retired}) "  # noqa: S608
            f"AND run_id IN ({', '.join('?' for _ in restored_run_ids)})",
            (*generation_ids, *restored_run_ids),
        )
    connection.exec_driver_sql(
        f"UPDATE {compacted_runs} SET compaction_id = ?, run_type = NULL, run_data = NULL, "  # noqa: S608
        f"event_ids = '[]', seen_event_ids = '[]' WHERE compaction_id IN ({retired})",
        (keeper, *generation_ids),
    )
    connection.exec_driver_sql(f"DELETE FROM {compactions} WHERE id IN ({retired})", tuple(generation_ids))  # noqa: S608


def _sqlite(storage: BaseDb) -> SqliteDb:
    if not isinstance(storage, SqliteDb):
        msg = "The compaction archive requires SQLite session storage"
        raise TypeError(msg)
    return storage


def _table_names(db: SqliteDb) -> tuple[str, str]:
    compactions, compacted_runs = archive_table_names(db.session_table_name)
    return quote_identifier(compactions), quote_identifier(compacted_runs)


def _ensure_tables(connection: Connection, db: SqliteDb) -> None:
    for statement in archive_schema_sql(db.session_table_name):
        connection.exec_driver_sql(statement)
