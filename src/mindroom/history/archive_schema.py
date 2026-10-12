"""Table layout of the compaction archive, shared by its owner and its legacy migration.

It stays free of storage and runtime imports so ``agent_storage`` can run the
migration when it opens a conversation database.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from mindroom.usage.storage import quote_identifier

if TYPE_CHECKING:
    from sqlalchemy import Connection


def archive_table_names(session_table: str) -> tuple[str, str]:
    """Return the unquoted generation and archived-run table names beside ``session_table``."""
    return f"{session_table}_compactions", f"{session_table}_compacted_runs"


# A positioned generation's running run, the stored runs it summarized, and the events its summary represents.
ADDED_GENERATION_COLUMNS = (
    ("through_run_id", "TEXT"),
    ("covered_run_ids", "TEXT"),
    ("event_ids", "TEXT"),
    ("seen_event_ids", "TEXT"),
)
# The run's index in the live table when it was archived, so a restore puts it back in place.
ADDED_ARCHIVED_RUN_COLUMNS = (("run_index", "INTEGER"),)
_GENERATION_COLUMNS = ", ".join(f"{name} {kind}" for name, kind in ADDED_GENERATION_COLUMNS)
_ARCHIVED_RUN_COLUMNS = ", ".join(f"{name} {kind}" for name, kind in ADDED_ARCHIVED_RUN_COLUMNS)


def archived_run_index_floor(connection: Connection, session_table: str, session_id: str) -> int:
    """Return one past the highest live-table index an archived run of ``session_id`` held, or 0.

    New runs are indexed above it, so one order spans live and archived runs even after
    the runs that held the highest live indexes were archived or removed.
    """
    _, compacted_runs = archive_table_names(session_table)
    created = connection.exec_driver_sql(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        (compacted_runs,),
    ).first()
    if created is None:
        return 0
    (highest,) = connection.exec_driver_sql(
        f"SELECT MAX(run_index) FROM {quote_identifier(compacted_runs)} WHERE session_id = ?",  # noqa: S608
        (session_id,),
    ).one()
    return 0 if highest is None else highest + 1


def archive_schema_sql(session_table: str) -> tuple[str, ...]:
    """Return the idempotent DDL that creates the archive beside ``session_table``."""
    compactions, compacted_runs = (quote_identifier(name) for name in archive_table_names(session_table))
    sessions = quote_identifier(session_table)
    return (
        f"CREATE TABLE IF NOT EXISTS {compactions} (id INTEGER PRIMARY KEY, "
        f"session_id TEXT NOT NULL REFERENCES {sessions}(session_id) ON DELETE CASCADE, "
        "scope_key TEXT NOT NULL, summary TEXT, summary_model TEXT, "
        "legacy INTEGER NOT NULL DEFAULT 0, legacy_event_ids TEXT, created_at INTEGER NOT NULL, "
        f"{_GENERATION_COLUMNS})",
        f"CREATE INDEX IF NOT EXISTS {quote_identifier(session_table + '_compactions_scope')} "
        f"ON {compactions} (session_id, scope_key)",
        # ``event_ids`` (what redaction matches) and ``seen_event_ids`` (what the run counts as
        # seen) precede the large ``run_data`` so event scans skip its overflow pages.
        f"CREATE TABLE IF NOT EXISTS {compacted_runs} (id INTEGER PRIMARY KEY, "
        f"compaction_id INTEGER NOT NULL REFERENCES {compactions}(id) ON DELETE CASCADE, "
        "session_id TEXT NOT NULL, run_id TEXT NOT NULL, run_type TEXT, event_ids TEXT NOT NULL, "
        f"seen_event_ids TEXT NOT NULL DEFAULT '[]', {_ARCHIVED_RUN_COLUMNS}, run_data TEXT, UNIQUE(session_id, run_id))",
        f"CREATE INDEX IF NOT EXISTS {quote_identifier(session_table + '_compacted_runs_generation')} "
        f"ON {compacted_runs} (compaction_id)",
    )
