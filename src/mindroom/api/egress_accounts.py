"""Personal egress API accounts: connect or disconnect the OAuth account of a service's provider for one agent.

`egress_credentials.py` mounts this router under `/api/connections/egress`, so its paths are relative to that.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict

from mindroom.api import oauth
from mindroom.api.connection_agents import CONNECTIONS_HEADERS
from mindroom.api.egress_access import EgressUser, require_egress_same_origin, resolve_agent_and_service
from mindroom.api.egress_status import oauth_provider_of_service

router = APIRouter()


class _EmptyMutation(BaseModel):
    model_config = ConfigDict(extra="forbid")


@router.post("/agents/{agent_name}/{service}/connect")
async def connect_egress_account(
    request: Request,
    agent_name: str,
    service: str,
    requester_id: EgressUser,
    _body: _EmptyMutation,
) -> oauth.OAuthConnectResponse:
    """Start the OAuth flow of a service's provider for one agent's credential scope."""
    require_egress_same_origin(request)
    agent, egress_service = await asyncio.to_thread(
        resolve_agent_and_service,
        request,
        requester_id,
        agent_name,
        service,
        requester_owned_oauth=True,
    )
    provider = oauth_provider_of_service(
        request,
        egress_service,
        agent.target,
        connecting=True,
        headers=CONNECTIONS_HEADERS,
    )
    try:
        return await oauth.connect(provider.id, request, agent_name=agent_name)
    except HTTPException as exc:
        raise HTTPException(
            exc.status_code,
            "Could not start account connection",
            headers=CONNECTIONS_HEADERS,
        ) from exc


@router.post("/agents/{agent_name}/{service}/disconnect")
async def disconnect_egress_account(
    request: Request,
    agent_name: str,
    service: str,
    requester_id: EgressUser,
    _body: _EmptyMutation,
) -> dict[str, str]:
    """Reset the OAuth connection of a service's provider for one agent's credential scope."""
    require_egress_same_origin(request)
    agent, egress_service = await asyncio.to_thread(
        resolve_agent_and_service,
        request,
        requester_id,
        agent_name,
        service,
        requester_owned_oauth=True,
    )
    provider = oauth_provider_of_service(
        request,
        egress_service,
        agent.target,
        connecting=False,
        headers=CONNECTIONS_HEADERS,
    )
    try:
        return await oauth.disconnect(provider.id, request, agent_name=agent_name)
    except HTTPException as exc:
        raise HTTPException(
            exc.status_code,
            "Could not disconnect account",
            headers=CONNECTIONS_HEADERS,
        ) from exc
