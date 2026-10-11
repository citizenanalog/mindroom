"""Personal egress API request log: the caller's own brokered requests.

`egress_credentials.py` mounts this router under `/api/connections/egress`, so its paths are relative to that.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from mindroom.api import config_lifecycle
from mindroom.api.connection_agents import CONNECTIONS_HEADERS
from mindroom.api.egress_access import egress_user_accepting
from mindroom.api.egress_status import AuditLogsResponse, audit_logs_response
from mindroom.egress_broker.service import active_audit_log
from mindroom.requester_identity import resolve_human_requester_alias

router = APIRouter()

_MAX_PERSONAL_LOG_ROWS = 200

_EgressLogUser = Annotated[str, Depends(egress_user_accepting("agent_name", "limit"))]


@router.get("/logs", response_model=AuditLogsResponse)
def get_personal_logs(
    request: Request,
    requester_id: _EgressLogUser,
    agent_name: Annotated[str | None, Query()] = None,
    limit: Annotated[int, Query()] = _MAX_PERSONAL_LOG_ROWS,
) -> AuditLogsResponse:
    """Return the caller's own recent brokered requests, newest first, optionally for one agent.

    The log is filtered by the canonical requester, the identity the worker tokens carry, whatever else the query
    says, so no filter can show another user's rows, not even on an agent several users share. Returns 409 if the
    broker is not running.
    """
    audit = active_audit_log()
    if audit is None:
        raise HTTPException(409, "Egress broker is not running", headers=CONNECTIONS_HEADERS)
    snapshot = config_lifecycle.bind_current_request_snapshot(request)
    if snapshot.runtime_config is None:
        raise HTTPException(503, "Egress logs are unavailable", headers=CONNECTIONS_HEADERS)
    records = audit.query(
        requester_id=resolve_human_requester_alias(requester_id, snapshot.runtime_config, snapshot.runtime_paths),
        agent_name=agent_name or None,
        limit=max(1, min(limit, _MAX_PERSONAL_LOG_ROWS)),
    )
    return audit_logs_response(records)
