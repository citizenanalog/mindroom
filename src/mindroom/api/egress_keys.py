"""Personal egress API keys: set or delete the key of one service for one agent's credential scope."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from mindroom.api.connection_agents import CONNECTIONS_HEADERS
from mindroom.api.egress_access import EgressUser, require_same_origin, resolve_agent_and_service, unprocessable
from mindroom.api.egress_status import RESTRICT_ONLY_KEY_REFUSAL
from mindroom.credentials.manager import get_runtime_credentials_manager
from mindroom.egress_broker.secrets import delete_secret, save_secret

router = APIRouter()


class PutSecretRequest(BaseModel):
    """Request body for setting a secret (write-only)."""

    model_config = ConfigDict(extra="forbid")

    secret: str


@router.put("/agents/{agent_name}/{service}", status_code=204)
def put_egress_secret(
    request: Request,
    agent_name: str,
    service: str,
    body: PutSecretRequest,
    requester_id: EgressUser,
) -> None:
    """Set or replace an egress service secret for one agent; a `restrict_only` service takes no key (422)."""
    require_same_origin(request)

    agent, egress_service = resolve_agent_and_service(
        request,
        requester_id,
        agent_name,
        service,
        require_management=True,
    )
    if egress_service.restrict_only:
        raise unprocessable(RESTRICT_ONLY_KEY_REFUSAL)

    manager = get_runtime_credentials_manager(agent.runtime_paths)
    try:
        save_secret(manager, agent.target, service, body.secret)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc), headers=CONNECTIONS_HEADERS) from exc


@router.delete("/agents/{agent_name}/{service}", status_code=204)
def delete_egress_secret(
    request: Request,
    agent_name: str,
    service: str,
    requester_id: EgressUser,
) -> None:
    """Delete an egress service secret for one agent."""
    require_same_origin(request)

    agent, _service = resolve_agent_and_service(
        request,
        requester_id,
        agent_name,
        service,
        require_management=True,
    )

    manager = get_runtime_credentials_manager(agent.runtime_paths)
    delete_secret(manager, agent.target, service)
