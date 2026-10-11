"""Personal egress API listing: every agent the user may use with its services, and the preset catalog.

`egress_credentials.py` mounts this router under `/api/connections/egress`, so its paths are relative to that.
"""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import TYPE_CHECKING, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

from mindroom.api import config_lifecycle, oauth
from mindroom.api.connection_agents import build_connection_agent_target
from mindroom.api.egress_access import EgressUser, check_agent_eligibility
from mindroom.api.egress_status import (
    EgressRuleSummary,
    EgressSourceStatus,
    PresetsResponse,
    effective_services,
    egress_oauth_status,
    egress_service_status,
    presets_response,
    rule_summaries,
)
from mindroom.credentials.manager import get_runtime_credentials_manager
from mindroom.egress_broker.user_services import (
    InactiveUserService,
    ServiceSource,
    inactive_user_services,
    service_source,
)
from mindroom.oauth.registry import load_oauth_providers_for_snapshot
from mindroom.requester_identity import resolve_human_requester_alias

if TYPE_CHECKING:
    from mindroom.agent_reply_membership import AgentReplyMembershipIndex
    from mindroom.config.main import Config
    from mindroom.constants import RuntimePaths
    from mindroom.credentials.manager import CredentialsManager

router = APIRouter()


class EgressCredentialService(EgressSourceStatus):
    """One egress service with its management permissions and its key and OAuth sources.

    `source` is `config` for a service the administrator defines and `user` for one defined in the agent's own
    scope through the services routes. `rules` says where the service applies (host, port, path prefix), so a client
    can tell which services overlap; it carries no auth settings. `placeholder_names` lists the variables the
    service sets in the sandbox (a preset's included), names only, so the editor can warn when a service of
    one's own sets the same one. `restrict_only` marks a service that only limits the paths of the other services on
    its hosts and never has a key or account of its own.
    """

    name: str
    display_name: str
    description: str
    is_shared: bool
    can_manage: bool
    source: ServiceSource
    rules: list[EgressRuleSummary]
    placeholder_names: list[str]
    restrict_only: bool


type _AgentScope = Literal["user", "user_agent", "shared", "unscoped"]


class EgressCredentialAgent(BaseModel):
    """One agent with its egress services.

    `shared` is true for a shared or unscoped agent, whose services and keys everyone using it shares, and
    `can_manage` says whether the caller may change them: their own agent, or a shared one they manage. Both are
    known even when the agent has no services yet. `inactive_services` lists the stored entries of the agent's
    scope that the broker ignores, so a user can still remove them: `shadowed` means an administrator's service has
    the same name now, `invalid` that the entry no longer validates as a service. They count toward the scope's
    limits.

    `scope` says whose store the services and keys live in: one `user_agent` agent's own, every `user` agent's
    of the caller, everyone's on a `shared` agent, or the global store of an `unscoped` one. `scope_agents` names
    the caller's agents that share a `user` store, this one included, and is empty for any other scope.
    `managers` is a shared or unscoped agent's credential managers, as Matrix IDs; it is empty for the rest, and
    for an agent with none only administrators manage it.
    """

    agent_name: str
    agent_display_name: str
    shared: bool
    can_manage: bool
    scope: _AgentScope
    scope_agents: list[str]
    managers: list[str]
    services: list[EgressCredentialService]
    inactive_services: list[InactiveUserService]


class EgressCredentialsResponse(BaseModel):
    """List of agents with their egress services."""

    agents: list[EgressCredentialAgent]


async def egress_services_for_agent(
    request: Request,
    agent_name: str,
    requester_id: str,
    config: Config,
    runtime_paths: RuntimePaths,
    membership_index: AgentReplyMembershipIndex,
    manager: CredentialsManager,
    *,
    eligibility: tuple[bool, bool] | None = None,
) -> list[EgressCredentialService] | None:
    """List the brokered services for one agent, or ``None`` when the requester may not use it.

    The services are the config's, then the ones the requester's scope defines for itself.
    ``requester_id`` must already be the resolved human requester alias. A caller that already ran the
    eligibility check passes its ``(is_shared, can_manage)`` result.
    """
    if eligibility is None:
        eligibility = check_agent_eligibility(agent_name, requester_id, config, runtime_paths, membership_index)
    if eligibility is None:
        return None
    is_shared, can_manage = eligibility
    target = build_connection_agent_target(config, runtime_paths, requester_id, agent_name)
    # Reading the scope's own services touches the credential store, so it stays off the event loop.
    services = await asyncio.to_thread(effective_services, config, manager, target)
    rows = []
    for name, service in services.items():
        oauth_part = await egress_oauth_status(
            request,
            name,
            service,
            target,
            config=config,
            runtime_paths=runtime_paths,
            manager=manager,
            can_manage=can_manage,
            connection_status=lambda provider: oauth.agent_connection_status(
                request,
                provider,
                runtime_paths,
                manager,
                target,
                config=config,
                refresh=False,
            ),
        )
        sources = await egress_service_status(manager, target, service, name, oauth_part)
        rows.append(
            EgressCredentialService(
                name=name,
                display_name=service.display_name or name.replace("_", " ").title(),
                description=service.description,
                is_shared=is_shared,
                can_manage=can_manage,
                source=service_source(config.egress_broker, name),
                rules=rule_summaries(service),
                placeholder_names=list(service.placeholder_env),
                restrict_only=service.restrict_only,
                updated_at=sources.key_updated_at,
                **asdict(sources),
            ),
        )
    return rows


def _agent_scope(config: Config, agent_name: str) -> _AgentScope:
    """Return whose store an agent's egress services and keys live in."""
    scope = config.resolve_entity(agent_name).execution_scope
    return "unscoped" if scope is None else scope


async def _load_egress_agents(request: Request, requester_id: str) -> list[EgressCredentialAgent]:
    """List every agent the requester may use, with its egress services, in config declaration order."""
    snapshot = config_lifecycle.bind_current_request_snapshot(request)
    config = snapshot.runtime_config
    if config is None:
        return []

    runtime_paths = snapshot.runtime_paths
    human_requester = resolve_human_requester_alias(requester_id, config, runtime_paths)
    memberships = config_lifecycle.app_state(request.app).agent_reply_memberships
    manager = get_runtime_credentials_manager(runtime_paths)

    eligible: dict[str, tuple[bool, bool]] = {}
    for agent_name in config.agents:
        eligibility = check_agent_eligibility(agent_name, human_requester, config, runtime_paths, memberships)
        if eligibility is not None:
            eligible[agent_name] = eligibility
    # Every `user` agent of the requester reads and writes one store, so each of them names all of them.
    user_store_agents = [
        agent.display_name
        for agent_name, agent in config.agents.items()
        if agent_name in eligible and _agent_scope(config, agent_name) == "user"
    ]

    agents: list[EgressCredentialAgent] = []
    for agent_name, agent in config.agents.items():
        eligibility = eligible.get(agent_name)
        if eligibility is None:
            continue
        is_shared, can_manage = eligibility
        scope = _agent_scope(config, agent_name)
        services = await egress_services_for_agent(
            request,
            agent_name,
            human_requester,
            config,
            runtime_paths,
            memberships,
            manager,
            eligibility=eligibility,
        )
        if services is None:
            continue
        target = build_connection_agent_target(config, runtime_paths, human_requester, agent_name)
        # Reading the scope's own services touches the credential store, so it stays off the event loop.
        inactive = await asyncio.to_thread(inactive_user_services, config.egress_broker, manager, target)
        agents.append(
            EgressCredentialAgent(
                agent_name=agent_name,
                agent_display_name=agent.display_name,
                shared=is_shared,
                can_manage=can_manage,
                scope=scope,
                scope_agents=list(user_store_agents) if scope == "user" else [],
                managers=list(agent.credential_managers) if is_shared else [],
                services=services,
                inactive_services=inactive,
            ),
        )
    return agents


@router.get("", response_model=EgressCredentialsResponse)
async def list_egress_credentials(request: Request, requester_id: EgressUser) -> EgressCredentialsResponse:
    """List egress services for every agent the user may use."""
    agents = await _load_egress_agents(request, requester_id)
    return EgressCredentialsResponse(agents=agents)


@router.get("/presets", response_model=PresetsResponse)
async def get_presets(request: Request, _requester_id: EgressUser) -> PresetsResponse:
    """List the built-in service presets with the rules, login, and placeholders each one sets, and the providers."""
    snapshot = config_lifecycle.bind_current_request_snapshot(request)
    return presets_response(load_oauth_providers_for_snapshot(snapshot))
