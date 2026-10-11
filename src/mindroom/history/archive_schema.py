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
_ADDED_GENERATION_COLUMNS = (
    ("through_run_id", "TEXT"),
    ("covered_run_ids", "TEXT"),
    ("event_ids", "TEXT"),
    ("seen_event_ids", "TEXT"),
)
# The run's index in the live table when it was archived, so a restore puts it back in place.
_ADDED_ARCHIVED_RUN_COLUMNS = (("run_index", "INTEGER"),)
_GENERATION_COLUMNS = ", ".join(f"{name} {kind}" for name, kind in _ADDED_GENERATION_COLUMNS)
_ARCHIVED_RUN_COLUMNS = ", ".join(f"{name} {kind}" for name, kind in _ADDED_ARCHIVED_RUN_COLUMNS)


# LEGACY_COMPAT: Compaction archives without positioned-generation and run-index columns.
# Legacy format: ``<session_table>_compactions`` without ``through_run_id``, ``covered_run_ids``, ``event_ids``, and
# ``seen_event_ids``, and ``<session_table>_compacted_runs`` without ``run_index``, as every earlier archive was created.
# Last legacy release: v2026.10.253; replacement: the next release creates and upgrades archives with those columns.
# Handling: Missing columns are added in place as nullable columns whenever the archive is ensured, so earlier
# generations read as unpositioned and earlier archived runs as having no recorded index.
# Coverage: tests/test_history_archive.py::test_an_existing_archive_gains_the_new_columns.
def upgrade_archive_schema(connection: Connection, session_table: str) -> None:
    """Add the columns an archive created by an earlier release lacks; their NULLs mean what the release meant."""
    for table, columns in zip(
        archive_table_names(session_table),
        (_ADDED_GENERATION_COLUMNS, _ADDED_ARCHIVED_RUN_COLUMNS),
        strict=True,
    ):
        quoted = quote_identifier(table)
        existing = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({quoted})")}
        for name, kind in columns:
            if name not in existing:
                connection.exec_driver_sql(f"ALTER TABLE {quoted} ADD COLUMN {name} {kind}")


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
