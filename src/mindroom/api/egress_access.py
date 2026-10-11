"""Request gates and agent resolution shared by the route modules of the personal egress API."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, HTTPException, Request, Response

from mindroom.api import config_lifecycle
from mindroom.api.auth import require_connections_user
from mindroom.api.connection_agents import (
    CONNECTIONS_HEADERS,
    build_connection_agent_target,
    require_connections_same_origin,
)
from mindroom.api.egress_status import effective_services, service_oauth_provider
from mindroom.authorization import is_sender_allowed_for_agent_credential_management, is_sender_allowed_for_responder
from mindroom.credentials.manager import get_runtime_credentials_manager
from mindroom.requester_identity import resolve_human_requester_alias

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from mindroom.agent_reply_membership import AgentReplyMembershipIndex
    from mindroom.config.egress_broker import EgressService
    from mindroom.config.main import Config
    from mindroom.constants import RuntimePaths
    from mindroom.tool_system.worker_routing import ResolvedWorkerTarget


def egress_user_accepting(*query_names: str) -> Callable[[Request, Response], Awaitable[str]]:
    """Build the dependency that authenticates the requester and rejects every query parameter but `query_names`.

    It needs no MINDROOM_CONNECTIONS_AGENT and returns the requester ID.
    """

    async def dependency(request: Request, response: Response) -> str:
        response.headers.update(CONNECTIONS_HEADERS)
        auth_user = await require_connections_user(request)
        if set(request.query_params) - set(query_names):
            detail = (
                f"Only the query parameters {', '.join(query_names)} are accepted"
                if query_names
                else "Query parameters are not accepted"
            )
            raise HTTPException(400, detail, headers=CONNECTIONS_HEADERS)
        return str(auth_user["matrix_user_id"])

    return dependency


EgressUser = Annotated[str, Depends(egress_user_accepting())]


def unprocessable(detail: str) -> HTTPException:
    """Build the 422 every refused service or key body ends in."""
    return HTTPException(422, detail, headers=CONNECTIONS_HEADERS)


def require_same_origin(request: Request) -> None:
    """Reject a mutation from another origin before any authorization lookup."""
    require_connections_same_origin(
        request,
        config_lifecycle.bind_current_request_snapshot(request).runtime_paths,
        detail="Egress credential changes require a same-origin request",
    )


def check_agent_eligibility(
    agent_name: str,
    requester_id: str,
    config: Config,
    runtime_paths: RuntimePaths,
    membership_index: AgentReplyMembershipIndex,
) -> tuple[bool, bool] | None:
    """Return ``(is_shared, can_manage)`` for an eligible agent, else ``None``.

    Eligibility requires a ``shell`` or ``python`` tool and permission to use the agent.
    Listing, portal catalog, and mutations all decide through this one rule.
    """
    entity = config.resolve_entity(agent_name)
    if not any(tool in entity.available_tools for tool in ("shell", "python")):
        return None
    if not is_sender_allowed_for_responder(
        requester_id,
        agent_name,
        None,
        config,
        runtime_paths,
        membership_index,
    ):
        return None
    is_shared = entity.execution_scope in {None, "shared"}
    can_manage = not is_shared or is_sender_allowed_for_agent_credential_management(
        requester_id,
        agent_name,
        config,
        runtime_paths,
    )
    return is_shared, can_manage


@dataclass(frozen=True)
class _ResolvedAgent:
    """An agent the requester may use, with the worker target their credentials and services live under."""

    config: Config
    runtime_paths: RuntimePaths
    target: ResolvedWorkerTarget
    can_manage: bool


def resolve_agent(request: Request, requester_id: str, agent_name: str) -> _ResolvedAgent:
    """Resolve one agent for the requester, or 404 when it is unknown or the requester may not use it."""
    snapshot = config_lifecycle.bind_current_request_snapshot(request)
    config = snapshot.runtime_config
    if config is None or agent_name not in config.agents:
        raise HTTPException(404, "Agent is not available", headers=CONNECTIONS_HEADERS)

    runtime_paths = snapshot.runtime_paths
    human_requester = resolve_human_requester_alias(requester_id, config, runtime_paths)
    memberships = config_lifecycle.app_state(request.app).agent_reply_memberships

    # Check eligibility: must have shell/python AND be allowed
    eligibility = check_agent_eligibility(
        agent_name,
        human_requester,
        config,
        runtime_paths,
        memberships,
    )
    if eligibility is None:
        raise HTTPException(404, "Agent is not available", headers=CONNECTIONS_HEADERS)

    # Always build target for the agent scope
    target = build_connection_agent_target(config, runtime_paths, human_requester, agent_name)
    return _ResolvedAgent(config, runtime_paths, target, can_manage=eligibility[1])


def resolve_agent_and_service(
    request: Request,
    requester_id: str,
    agent_name: str,
    service_name: str,
    *,
    require_management: bool,
    requester_owned_oauth: bool = False,
) -> tuple[_ResolvedAgent, EgressService]:
    """Resolve and authorize one agent and one of its services for mutation or query.

    The service is one of the config's or one the requester's scope defines for itself, so a name that exists only
    in another requester's scope is a 404.
    `requester_owned_oauth` is for connecting or disconnecting the service's OAuth account: a requester-scoped
    provider's connection belongs to the requester, so any user of the agent may manage it.
    """
    agent = resolve_agent(request, requester_id, agent_name)
    manager = get_runtime_credentials_manager(agent.runtime_paths)
    service = effective_services(agent.config, manager, agent.target).get(service_name)
    if service is None:
        raise HTTPException(404, "Service is not configured", headers=CONNECTIONS_HEADERS)

    requester_owned = False
    if requester_owned_oauth:
        provider = service_oauth_provider(config_lifecycle.bind_current_request_snapshot(request), service)
        requester_owned = provider is not None and provider.requester_scoped_credentials
    if require_management and not agent.can_manage and not requester_owned:
        raise HTTPException(403, "Credential management is required", headers=CONNECTIONS_HEADERS)

    return agent, service


def resolve_service_editor(request: Request, requester_id: str, agent_name: str) -> _ResolvedAgent:
    """Resolve an agent whose own services the requester may change: their private agent, or a shared one they manage."""
    agent = resolve_agent(request, requester_id, agent_name)
    if not agent.can_manage:
        raise HTTPException(403, "Credential management is required", headers=CONNECTIONS_HEADERS)
    return agent
