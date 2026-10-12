"""Compatibility for Agno 2 session payloads retained beside current run rows."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Any, cast

from agno.db.utils import build_single_run_row
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert

from mindroom.usage.storage import quote_identifier

if TYPE_CHECKING:
    from sqlalchemy import Connection, Table


# LEGACY_COMPAT: Agno 2 session history stored in JSON run blobs.
# Legacy format: Agno 2 sessions stored run history in single- or double-encoded JSON `runs` blobs,
# which Agno 3 merges into every read ahead of run rows.
# Last legacy release: v2026.9.11; replacement: v2026.9.12 wrote first-class Agno 3 run rows.
# Handling: The open-time summary-row migration turns every blob entry with a string run id that has
# no row yet into a run row, renumbers the session's rows in the order Agno's merge read them, and
# clears the blob, so every run has a position in the conversation log and no read merges a blob.
# Coverage: tests/test_agent_storage_runs.py::test_agno_2_blob_runs_become_rows_once,
# tests/test_agent_storage_runs.py::test_blob_runs_keep_the_order_agno_read_them_in, and
# tests/test_agent_storage_runs.py::test_blob_entries_without_a_string_run_id_are_dropped.
def materialize_legacy_run_blobs(connection: Connection, runs: Table, session_table: str) -> None:
    """Turn the runs Agno 2 blobs still hold into run rows, in the caller's write transaction."""
    sessions = quote_identifier(session_table)
    columns = {row[1] for row in connection.exec_driver_sql(f"PRAGMA table_info({sessions})")}
    if "runs" not in columns:
        return
    blobs = connection.exec_driver_sql(
        f"SELECT session_id, runs FROM {sessions} WHERE runs IS NOT NULL",  # noqa: S608
    ).fetchall()
    for session_id, blob in blobs:
        stored = list(
            connection.execute(
                select(runs.c.run_id)
                .where(runs.c.session_id == session_id)
                .order_by(runs.c.run_index, runs.c.created_at, runs.c.run_id),
            ).scalars(),
        )
        legacy = _legacy_entries(blob)
        for run_id, entry in legacy.items():
            if run_id not in stored:
                row = build_single_run_row(entry, session_id=session_id, user_id=entry.get("user_id"), run_index=None)
                connection.execute(insert(runs).values(**row).on_conflict_do_nothing(index_elements=["run_id"]))
        # Agno's merge read blob entries first, table copies substituted, then table-only rows.
        merged = [*legacy, *(run_id for run_id in stored if run_id not in legacy)]
        for run_index, run_id in enumerate(merged):
            connection.execute(
                runs.update()
                .where(runs.c.session_id == session_id, runs.c.run_id == run_id)
                .values(run_index=run_index),
            )
        connection.exec_driver_sql(
            f"UPDATE {sessions} SET runs = NULL WHERE session_id = ?",  # noqa: S608
            (session_id,),
        )


def _legacy_entries(blob: object) -> dict[str, dict[str, Any]]:
    """Return the blob's run entries a read could address by id, keyed by run id in stored order."""
    try:
        decoded = decode_persisted_session_json(blob)
    except (TypeError, ValueError):
        return {}
    entries: dict[str, dict[str, Any]] = {}
    for entry in decoded if isinstance(decoded, list) else []:
        if not isinstance(entry, dict):
            continue
        run = cast("dict[str, Any]", entry)
        run_id = run.get("run_id")
        if isinstance(run_id, str) and run_id:
            entries.setdefault(run_id, run)
    return entries


def decode_persisted_session_json(raw_value: object) -> object:
    """Strictly decode the single- or double-encoded JSON used by retained session payloads."""
    if raw_value is None:
        return None
    if not isinstance(raw_value, (str, bytes, bytearray)):
        raise TypeError
    decoded = json.loads(raw_value)
    return json.loads(decoded) if isinstance(decoded, str) else decoded
