"""Personal egress API services: read, save, and delete the services an agent's scope defines for itself."""

from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from pydantic import ValidationError

from mindroom.api.connection_agents import CONNECTIONS_HEADERS
from mindroom.api.egress_access import (
    EgressUser,
    require_same_origin,
    resolve_agent,
    resolve_service_editor,
    unprocessable,
)
from mindroom.api.egress_status import effective_services
from mindroom.config.egress_broker import EgressService
from mindroom.credentials.manager import get_runtime_credentials_manager
from mindroom.egress_broker.user_services import (
    MAX_SERVICE_BYTES,
    UserServiceConflictError,
    delete_user_service,
    save_user_service,
    user_service_hosts_not_allowed,
)
from mindroom.oauth.registry import load_oauth_providers

if TYPE_CHECKING:
    from mindroom.config.egress_broker import EgressBrokerConfig

router = APIRouter()


async def _limit_service_body(request: Request) -> None:
    """Refuse a service body over 16 KiB with 413 before its fields are validated, so a huge rules list never is.

    FastAPI has already read the body, so this reads Starlette's cached bytes.
    """
    if len(await request.body()) > MAX_SERVICE_BYTES:
        msg = f"A service can take at most {MAX_SERVICE_BYTES // 1024} KiB"
        raise HTTPException(413, msg, headers=CONNECTIONS_HEADERS)


def _parse_user_service(body: object) -> EgressService:
    """Validate a service body like a config service; the operator-only `oauth_on_shared_workers` is not accepted.

    Every refusal is a 422 with a string detail, a body that is not a JSON object included.
    """
    if not isinstance(body, dict):
        msg = "A service must be a JSON object"
        raise unprocessable(msg)
    if "oauth_on_shared_workers" in body:
        msg = "oauth_on_shared_workers can only be set by an administrator in config.yaml"
        raise unprocessable(msg)
    try:
        return EgressService.model_validate(body)
    except ValidationError as exc:
        messages = []
        for error in exc.errors(include_url=False, include_context=False, include_input=False):
            where = ".".join(str(part) for part in error["loc"])
            message = error["msg"].removeprefix("Value error, ")
            messages.append(f"{where}: {message}" if where else message)
        raise unprocessable("; ".join(messages)) from exc


def _require_hosts_within_operator_policy(operator: EgressBrokerConfig, service: EgressService) -> None:
    """Refuse a service whose rules would apply on hosts that `unmatched_hosts: deny` keeps closed."""
    hosts = user_service_hosts_not_allowed(operator, service)
    if hosts:
        msg = (
            "Your administrator only allows requests to hosts that one of its own services covers, "
            f"so these hosts cannot be used: {', '.join(hosts)}"
        )
        raise unprocessable(msg)


@router.get("/agents/{agent_name}/services/{name}")
def get_user_service(
    request: Request,
    agent_name: str,
    name: str,
    requester_id: EgressUser,
) -> dict[str, Any]:
    """Return one of the scope's own services as authored, so a preset stays a preset."""
    agent = resolve_agent(request, requester_id, agent_name)
    operator = agent.config.egress_broker
    manager = get_runtime_credentials_manager(agent.runtime_paths)
    service = None if name in operator.services else effective_services(agent.config, manager, agent.target).get(name)
    if service is None:
        raise HTTPException(404, "Service is not a service of your own", headers=CONNECTIONS_HEADERS)
    return service.authored_model_dump()


@router.put("/agents/{agent_name}/services/{name}", status_code=204)
def put_user_service(
    request: Request,
    agent_name: str,
    name: str,
    requester_id: EgressUser,
    _size: Annotated[None, Depends(_limit_service_body)],
    body: Annotated[object, Body()] = None,
) -> None:
    """Create or replace one of the scope's own services.

    The body has the fields of a config service except `oauth_on_shared_workers`. Returns 413 for a body over 16 KiB,
    409 for the name of a config service, and 422, always with a string detail, for a body that is not a JSON object,
    an invalid service, a limit (count or size), a placeholder user services may not set, an unknown OAuth provider
    or one on a shared or unscoped agent, or rules on hosts that `unmatched_hosts: deny` keeps closed.
    """
    require_same_origin(request)
    agent = resolve_service_editor(request, requester_id, agent_name)
    operator = agent.config.egress_broker
    if name in operator.services:
        raise HTTPException(409, str(UserServiceConflictError(name)), headers=CONNECTIONS_HEADERS)
    service = _parse_user_service(body)
    _require_hosts_within_operator_policy(operator, service)
    manager = get_runtime_credentials_manager(agent.runtime_paths)
    try:
        save_user_service(
            manager,
            agent.target,
            name,
            service,
            config_services=operator.services,
            oauth_providers=load_oauth_providers(agent.config, agent.runtime_paths).keys(),
        )
    except ValueError as exc:
        raise unprocessable(str(exc)) from exc


@router.delete("/agents/{agent_name}/services/{name}", status_code=204)
def delete_user_service_route(
    request: Request,
    agent_name: str,
    name: str,
    requester_id: EgressUser,
) -> None:
    """Delete one of the scope's own services together with its stored key.

    Returns 404 when the scope has no such service. A config service cannot be deleted, so its name is a 409. An
    inactive entry (see `EgressInactiveService`) can still be removed: one stored under a name that a config service
    has since taken keeps the key, which the config service uses, and one that no longer validates takes its key
    with it.
    """
    require_same_origin(request)
    agent = resolve_service_editor(request, requester_id, agent_name)
    operator = agent.config.egress_broker
    manager = get_runtime_credentials_manager(agent.runtime_paths)
    if delete_user_service(manager, agent.target, name, config_services=operator.services):
        return
    if name in operator.services:
        detail = f"Service '{name}' is configured by your administrator and cannot be deleted here"
        raise HTTPException(409, detail, headers=CONNECTIONS_HEADERS)
    raise HTTPException(404, "Service is not a service of your own", headers=CONNECTIONS_HEADERS)
