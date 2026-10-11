"""Egress service status and request-log responses shared by the personal and the admin egress APIs."""

from __future__ import annotations

import asyncio
from dataclasses import asdict
from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException
from pydantic import BaseModel

from mindroom.api import config_lifecycle, oauth
from mindroom.config.egress_broker import RESERVED_PLACEHOLDER_NAMES, RESERVED_PLACEHOLDER_PREFIXES, EgressService
from mindroom.egress_broker.oauth_source import shared_worker_oauth
from mindroom.egress_broker.presets import EGRESS_PRESETS
from mindroom.egress_broker.secrets import EgressServiceStatus, OAuthStatus, service_status
from mindroom.egress_broker.user_services import (
    MAX_DOCUMENT_BYTES,
    MAX_RULES_PER_SERVICE,
    MAX_SERVICE_BYTES,
    MAX_USER_SERVICES,
    PLACEHOLDER_NAME,
    PLACEHOLDER_NAME_WORDS,
    PLACEHOLDER_REFUSED_PREFIX,
    PLACEHOLDER_REFUSED_WORDS,
    PLACEHOLDER_VALUE,
    ServiceSource,
    effective_config,
)
from mindroom.egress_broker.user_services import service_source as config_service_source
from mindroom.oauth.registry import load_oauth_providers_for_snapshot
from mindroom.oauth.service import oauth_provider_service_account_configured
from mindroom.workers.backend import WorkerBackendError

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Mapping

    from fastapi import Request

    from mindroom.api.config_lifecycle import ApiSnapshot
    from mindroom.config.egress_broker import EgressAuth
    from mindroom.config.main import Config
    from mindroom.credentials.manager import CredentialsManager
    from mindroom.egress_broker.audit import AuditRecord
    from mindroom.oauth import OAuthProvider
    from mindroom.tool_system.worker_routing import ResolvedWorkerTarget


type EgressServiceSource = ServiceSource

RESTRICT_ONLY_KEY_REFUSAL = "This service only limits paths and never sends a key, so it cannot store one"


def effective_services(
    config: Config,
    manager: CredentialsManager,
    target: ResolvedWorkerTarget | None,
) -> dict[str, EgressService]:
    """Return the services one scope uses, by name: the config's first, then the scope's own.

    Both egress APIs look services up here, so what they list and accept is what the broker matches. A cache miss
    reads the credential store, so async callers run this in a thread.
    """
    return effective_config(config.egress_broker, manager, target).services


def service_source(config: Config, name: str) -> EgressServiceSource:
    """Say whether a service of an effective config is the administrator's (`config`) or the scope's own (`user`)."""
    return config_service_source(config.egress_broker, name)


class EgressRuleLocation(BaseModel):
    """Where one rule applies: its host, port, and path prefix."""

    host: str
    port: int | None
    path_prefix: str


type _EgressAuthKind = Literal["bearer", "basic", "header", "query", "template"]


class EgressRuleSummary(EgressRuleLocation):
    """Where one rule applies and how it sends the key, for a client that shows what a service covers.

    `auth_type` is `bearer`, `basic`, `header`, `query`, or `template` (a header whose value is a template other than
    the bare key), and `auth_name` the header or query parameter name (null for `bearer` and `basic`). Both are null
    for a `restrict_only` service, which sends nothing. Never the key, a template's text, or a basic username.
    """

    auth_type: _EgressAuthKind | None
    auth_name: str | None


def _auth_summary(service: EgressService, auth: EgressAuth | None) -> tuple[_EgressAuthKind | None, str | None]:
    if service.restrict_only or auth is None:
        return None, None
    if auth.type in {"bearer", "basic"}:
        return auth.type, None
    if auth.type == "header" and auth.template != "{secret}":
        return "template", auth.name
    return auth.type, auth.name


def rule_summaries(service: EgressService) -> list[EgressRuleSummary]:
    """Describe where a service's rules apply and how each sends the key, in rule order."""
    summaries = []
    for rule in service.rules:
        auth_type, auth_name = _auth_summary(service, rule.auth)
        summaries.append(
            EgressRuleSummary(
                host=rule.host,
                port=rule.port,
                path_prefix=rule.path_prefix,
                auth_type=auth_type,
                auth_name=auth_name,
            ),
        )
    return summaries


class EgressPresetResponse(BaseModel):
    """One built-in service preset as the editor shows it."""

    id: str
    display_name: str
    description: str
    oauth_provider: str | None
    rules: list[EgressRuleLocation]
    placeholder_env: dict[str, str]


class EgressOAuthProviderOption(BaseModel):
    """One OAuth provider a service's account login can name."""

    id: str
    display_name: str


class PlaceholderLimits(BaseModel):
    """The placeholder rules of a service a user defines, as the server checks them on save.

    A name must match `name_pattern` completely, needs one of the `credential_words` as an underscore-separated word
    and none of the `refused_words`, must not start with `refused_prefix`, and may be none of the `reserved_names` or
    start with a `reserved_prefixes` entry, which the config model reserves for every service. A value must match
    `value_pattern` completely. Both word lists keep the order the server's error messages list them in; the other
    lists are sorted.
    """

    name_pattern: str
    credential_words: list[str]
    refused_words: list[str]
    refused_prefix: str
    reserved_names: list[str]
    reserved_prefixes: list[str]
    value_pattern: str


class EgressLimits(BaseModel):
    """What a service a user defines may hold, so the editor can refuse a service the server would refuse.

    `max_services` counts the services of one scope, `max_rules_per_service` the rules of one service,
    `max_service_bytes` one service's authored JSON, and `max_document_bytes` the scope's whole stored document.
    """

    max_services: int
    max_rules_per_service: int
    max_service_bytes: int
    max_document_bytes: int
    placeholder: PlaceholderLimits


class PresetsResponse(BaseModel):
    """The built-in service presets, the OAuth providers an account login can name, and the limits of user services."""

    presets: list[EgressPresetResponse]
    oauth_providers: list[EgressOAuthProviderOption]
    limits: EgressLimits


def _egress_limits() -> EgressLimits:
    """Describe the limits of a user's service from the constants the broker and the config model enforce."""
    return EgressLimits(
        max_services=MAX_USER_SERVICES,
        max_rules_per_service=MAX_RULES_PER_SERVICE,
        max_service_bytes=MAX_SERVICE_BYTES,
        max_document_bytes=MAX_DOCUMENT_BYTES,
        placeholder=PlaceholderLimits(
            name_pattern=PLACEHOLDER_NAME.pattern,
            credential_words=list(PLACEHOLDER_NAME_WORDS),
            refused_words=list(PLACEHOLDER_REFUSED_WORDS),
            refused_prefix=PLACEHOLDER_REFUSED_PREFIX,
            reserved_names=sorted(RESERVED_PLACEHOLDER_NAMES),
            reserved_prefixes=sorted(RESERVED_PLACEHOLDER_PREFIXES),
            value_pattern=PLACEHOLDER_VALUE.pattern,
        ),
    )


def presets_response(oauth_providers: Mapping[str, OAuthProvider]) -> PresetsResponse:
    """List the presets as the config model expands them, so the editor shows what a `preset:` entry resolves to.

    `oauth_providers` is the registry (`oauth.registry`), the same one a saved service's `oauth_provider` is checked
    against, listed in registry order. `limits` is the same for every caller.
    """
    presets = []
    for preset_id in EGRESS_PRESETS:
        service = EgressService.model_validate({"preset": preset_id})
        presets.append(
            EgressPresetResponse(
                id=preset_id,
                display_name=service.display_name or preset_id,
                description=service.description,
                oauth_provider=service.oauth_provider,
                rules=[
                    EgressRuleLocation(host=rule.host, port=rule.port, path_prefix=rule.path_prefix)
                    for rule in service.rules
                ],
                placeholder_env=service.placeholder_env,
            ),
        )
    providers = [
        EgressOAuthProviderOption(id=provider_id, display_name=provider.display_name)
        for provider_id, provider in oauth_providers.items()
    ]
    return PresetsResponse(presets=presets, oauth_providers=providers, limits=_egress_limits())


class AuditRecordResponse(BaseModel):
    """One audit log record for API responses."""

    at: str
    kind: str
    scope: str
    agent_name: str | None
    requester_id: str | None
    method: str
    host: str
    path: str
    service: str | None
    status: int
    bytes_up: int
    bytes_down: int
    duration_ms: int
    code: str | None


class AuditLogsResponse(BaseModel):
    """Audit log query response."""

    records: list[AuditRecordResponse]


def audit_logs_response(records: Iterable[AuditRecord]) -> AuditLogsResponse:
    """Describe audit records, already in the order the log returned them, for an API response."""
    return AuditLogsResponse(
        records=[
            AuditRecordResponse(
                at=rec.at.isoformat(),
                kind=rec.kind,
                scope=rec.scope,
                agent_name=rec.agent_name,
                requester_id=rec.requester_id,
                method=rec.method,
                host=rec.host,
                path=rec.path,
                service=rec.service,
                status=rec.status,
                bytes_up=rec.bytes_up,
                bytes_down=rec.bytes_down,
                duration_ms=rec.duration_ms,
                code=rec.code,
            )
            for rec in records
        ],
    )


class EgressOAuthStatus(BaseModel):
    """Connection state of the OAuth account a service can use instead of an API key.

    `connected` means the broker would inject a personal access token. `service_account` marks a provider that a
    shared service account serves instead: the broker cannot inject that, and personal accounts are not connectable.
    `unavailable_reason` is `shared_sandbox` where the broker never uses a requester's own account (GitHub,
    Atlassian) because several requesters share the sandbox; nothing is connected or connectable then.
    `shared_worker_opt_in` marks such a sandbox whose service allows it anyway (`oauth_on_shared_workers`), so every
    user of the agent can act with the connected account.
    """

    provider: str
    display_name: str
    connected: bool
    account_label: str | None
    can_connect: bool
    reset_required: bool
    service_account: bool
    unavailable_reason: Literal["shared_sandbox"] | None
    shared_worker_opt_in: bool


class EgressSourceStatus(BaseModel):
    """Which secret sources a service has in one scope.

    `configured` is true when either source is available and `updated_at` is the API key's timestamp, both kept for
    older clients. `active_source` says which source the broker uses: an explicit key wins over OAuth.
    """

    configured: bool
    updated_at: str | None
    active_source: Literal["key", "oauth"] | None
    key_configured: bool
    key_updated_at: str | None
    oauth: EgressOAuthStatus | None

    @classmethod
    def from_status(cls, status: EgressServiceStatus) -> EgressSourceStatus:
        """Describe the sources of one service for an API response."""
        return cls(
            configured=status.configured,
            updated_at=status.key_updated_at,
            active_source=status.active_source,
            key_configured=status.key_configured,
            key_updated_at=status.key_updated_at,
            oauth=EgressOAuthStatus(**asdict(status.oauth)) if status.oauth is not None else None,
        )


async def egress_oauth_status(
    result: oauth.OAuthStatusResponse,
    *,
    can_manage: bool,
    stored_connection: Callable[[], OAuthStatus | None],
) -> OAuthStatus:
    """Return a service's OAuth status as the broker sees it.

    Without a service account this is what the Connections portal shows the same viewer. A service account is not
    a token the broker can inject, so with one `connected` only reflects a stored personal connection that the
    broker would still use (`stored_connection` reads it like the broker does), and nothing is connectable.
    """
    if not result.has_service_account_config:
        view: oauth.PersonalConnectionView = oauth.personal_connection_view(result, can_manage=can_manage)
        return OAuthStatus(
            provider=result.provider,
            display_name=result.display_name,
            connected=view.connected,
            account_label=view.account_label,
            can_connect=view.can_connect,
            reset_required=view.reset_required,
        )
    stored = await asyncio.to_thread(stored_connection)
    return OAuthStatus(
        provider=result.provider,
        display_name=result.display_name,
        connected=stored is not None and stored.connected,
        account_label=None,
        can_connect=False,
        reset_required=result.reset_required,
        service_account=True,
    )


def unavailable_egress_oauth_status(provider: OAuthProvider) -> OAuthStatus:
    """Return the status shown while a provider's connection state cannot be loaded, so one failure spares the page."""
    return OAuthStatus(
        provider=provider.id,
        display_name=provider.display_name,
        connected=False,
        account_label=None,
        can_connect=False,
        reset_required=False,
    )


async def egress_service_status(
    manager: CredentialsManager,
    target: ResolvedWorkerTarget | None,
    service: EgressService,
    name: str,
    oauth_part: OAuthStatus | None,
) -> EgressSourceStatus:
    """Combine a service's key status with its already loaded OAuth status; an explicit key wins.

    The key status reads and decrypts a credential file, so it runs in a thread.
    """
    status = await asyncio.to_thread(
        service_status,
        manager,
        target,
        service,
        name,
        oauth_status=lambda _provider_id, _target: oauth_part,
    )
    return EgressSourceStatus.from_status(status)


def service_oauth_provider(snapshot: ApiSnapshot, service: EgressService | None) -> OAuthProvider | None:
    """Return the registry's provider for an egress service, or None without a service or a known provider."""
    if service is None or service.oauth_provider is None:
        return None
    return load_oauth_providers_for_snapshot(snapshot).get(service.oauth_provider)


def egress_oauth_provider(
    request: Request,
    service_name: str,
    worker_target: ResolvedWorkerTarget | None,
    *,
    connecting: bool,
    headers: Mapping[str, str] | None = None,
) -> OAuthProvider:
    """Return the OAuth provider of a configured egress service for the admin connect and disconnect routes.

    A service the config does not define is a 404; see `oauth_provider_of_service` for the rest.
    """
    config = config_lifecycle.bind_current_request_snapshot(request).runtime_config
    service = config.egress_broker.services.get(service_name) if config is not None else None
    if service is None:
        raise HTTPException(404, "Service is not configured", headers=headers)
    return oauth_provider_of_service(request, service, worker_target, connecting=connecting, headers=headers)


def oauth_provider_of_service(
    request: Request,
    service: EgressService,
    worker_target: ResolvedWorkerTarget | None,
    *,
    connecting: bool,
    headers: Mapping[str, str] | None = None,
) -> OAuthProvider:
    """Return the OAuth provider of an egress service for the connect and disconnect routes.

    A service without a provider, or whose provider the registry does not know, is a 404. A provider that the broker
    refuses for `worker_target` (a requester's account in a sandbox several requesters share, see
    `shared_worker_oauth`) is a 409 for both actions, as the status reports nothing connectable there. Connecting is
    also a 409 while a shared service account is configured for the provider, since personal accounts are not
    managed then. Disconnecting stays possible there, so a personal connection stored earlier can still be revoked.
    A worker backend that cannot be read is a 503 for both actions.
    """
    snapshot = config_lifecycle.bind_current_request_snapshot(request)
    provider = service_oauth_provider(snapshot, service)
    if provider is None:
        raise HTTPException(404, "Service has no account connection", headers=headers)
    try:
        access = shared_worker_oauth(
            provider,
            worker_target,
            opted_in=service.oauth_on_shared_workers,
            runtime_paths=snapshot.runtime_paths,
        )
    except WorkerBackendError as exc:
        # An unreadable worker backend leaves the sandbox kind unknown, so neither action can be judged safe.
        raise HTTPException(503, "Account connection is unavailable right now", headers=headers) from exc
    if access == "refused":
        detail = "Account connection is unavailable here because several users share this agent's sandbox"
        raise HTTPException(409, detail, headers=headers)
    if connecting and oauth_provider_service_account_configured(provider, snapshot.runtime_paths):
        raise HTTPException(409, "Personal account linking is unavailable for this service", headers=headers)
    return provider
