"""Egress broker configuration models."""

from __future__ import annotations

import copy
import re
from typing import TYPE_CHECKING, Literal, cast

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from mindroom.credential_policy import is_oauth_client_config_service, is_oauth_token_service
from mindroom.egress_broker.presets import EGRESS_PRESETS

if TYPE_CHECKING:
    from pydantic import ModelWrapValidatorHandler

_AuthType = Literal["bearer", "basic", "header", "query"]

# RFC 7230 token: the characters allowed in an HTTP header field name.
_HEADER_NAME_PATTERN = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+")
# Headers that frame the message, route it, or authenticate to the proxy belong to the broker.
_RESERVED_AUTH_HEADERS = frozenset(
    {
        "host",
        "content-length",
        "transfer-encoding",
        "connection",
        "upgrade",
        "te",
        "trailer",
        "proxy-authorization",
        "proxy-connection",
        "keep-alive",
    },
)

# Reserved env names that cannot be used as placeholder names
_RESERVED_EXACT = {"PATH", "HOME"}
_RESERVED_PREFIXES = {"MINDROOM_", "GIT_CONFIG_"}
_RESERVED_PROXY_VARS = {
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "NODE_USE_ENV_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
}
_RESERVED_CA_VARS = {
    "SSL_CERT_FILE",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "GIT_SSL_CAINFO",
    "NODE_EXTRA_CA_CERTS",
}


class EgressAuth(BaseModel):
    """Authentication configuration for an egress rule."""

    model_config = ConfigDict(extra="forbid")

    type: _AuthType = Field(description="Authentication type")
    username: str | None = Field(
        default=None,
        description="Username for basic auth; required when type=basic",
    )
    name: str | None = Field(
        default=None,
        description="Header or query param name; required for header/query types",
    )
    template: str = Field(
        default="{secret}",
        description="Template for header/query value; must contain {secret} exactly once",
    )

    @field_validator("template")
    @classmethod
    def validate_template(cls, value: str) -> str:
        """Ensure template contains {secret} exactly once."""
        count = value.count("{secret}")
        if count != 1:
            msg = "template must contain {secret} exactly once"
            raise ValueError(msg)
        return value

    @model_validator(mode="after")
    def validate_type_requirements(self) -> EgressAuth:
        """Validate type-specific field requirements."""
        if self.type == "basic" and self.username is None:
            msg = "basic auth requires username"
            raise ValueError(msg)
        if self.type in ("header", "query") and self.name is None:
            msg = f"{self.type} auth requires name"
            raise ValueError(msg)
        if self.type == "header" and self.name is not None:
            if not _HEADER_NAME_PATTERN.fullmatch(self.name):
                msg = "header auth name must be a valid HTTP header name"
                raise ValueError(msg)
            if self.name.lower() in _RESERVED_AUTH_HEADERS:
                msg = f"header auth name '{self.name}' is reserved for the broker"
                raise ValueError(msg)
        if self.type == "query" and not self.name:
            msg = "query auth requires a non-empty name"
            raise ValueError(msg)
        return self


class EgressRule(BaseModel):
    """One egress routing rule."""

    model_config = ConfigDict(extra="forbid")

    host: str = Field(description="Host to match (exact, IP, or *.domain.com)")
    port: int | None = Field(
        default=None,
        ge=1,
        le=65535,
        description="Port to match; None matches any port",
    )
    path_prefix: str = Field(
        default="/",
        description=(
            "Path prefix to match by segment: one ending in / matches every path under it; "
            "otherwise the exact path or that path followed by / (/repos/o/r never matches /repos/o/r-old)"
        ),
    )
    auth: EgressAuth | None = Field(
        default=None,
        description="Authentication config for this rule; required unless the service is restrict_only, which ignores it",
    )

    @field_validator("host")
    @classmethod
    def validate_host(cls, value: str) -> str:
        """Validate and normalize host."""
        # Lowercase the host
        value = value.lower()

        # Strip one trailing dot (FQDN notation)
        if value.endswith(".") and not value.endswith(".."):
            value = value[:-1]

        # Check for invalid patterns
        if "://" in value:
            msg = "host must not contain scheme"
            raise ValueError(msg)
        if ":" in value:
            msg = "host must not contain port"
            raise ValueError(msg)
        if "/" in value:
            msg = "host must not contain path"
            raise ValueError(msg)

        # Wildcard validation: only single leading *.
        if value.startswith("*."):
            parts = value.split(".")
            if parts.count("*") > 1:
                msg = "host can only have one wildcard label"
                raise ValueError(msg)
            # Ensure there's a base domain after *.
            if len(parts) < 3:  # Must be *.domain.tld minimum
                msg = "wildcard host must have at least one domain part after *."
                raise ValueError(msg)
        elif "*" in value:
            msg = "wildcard must be a single leading *. label"
            raise ValueError(msg)

        return value

    @field_validator("path_prefix")
    @classmethod
    def validate_path_prefix(cls, value: str) -> str:
        """Ensure path_prefix starts with /."""
        if not value.startswith("/"):
            msg = "path_prefix must start with /"
            raise ValueError(msg)
        return value


class EgressService(BaseModel):
    """One egress service configuration."""

    model_config = ConfigDict(extra="forbid")

    preset: str | None = Field(
        default=None,
        description=(
            "Built-in service preset that supplies display_name, description, rules, placeholder_env, "
            "and oauth_provider; fields set explicitly here replace the preset's values"
        ),
    )
    display_name: str | None = Field(
        default=None,
        description="Human-readable service name",
    )
    description: str = Field(
        default="",
        description="Service description",
    )
    rules: list[EgressRule] = Field(
        default_factory=list,
        description="Routing rules for this service; at least one is required unless a preset supplies them",
    )
    placeholder_env: dict[str, str] = Field(
        default_factory=dict,
        description="Placeholder environment variables",
    )
    oauth_provider: str | None = Field(
        default=None,
        pattern=r"^[a-z0-9][a-z0-9_-]*$",
        description=(
            "MindRoom OAuth provider id whose connection supplies the secret when no API key is stored; "
            "checked against the provider registry at runtime"
        ),
    )
    oauth_on_shared_workers: bool = Field(
        default=False,
        description=(
            "Use a requester's own connected account (GitHub, Atlassian) in shared sandboxes too: shared and "
            "unscoped agents, and any agent on the static runner. Every user of such a sandbox can act with "
            "another user's connected account until that user's proxy token expires; presets never set this"
        ),
    )
    restrict_to_rules: bool = Field(
        default=False,
        description=(
            "Refuse requests to this service's hosts whose path matches no rule of any service (403 "
            "path_not_allowed) instead of forwarding them without credentials. GraphQL (/graphql) is then "
            "refused unless a rule lists it; a listed GraphQL endpoint reaches everything the credential can. "
            "Presets never set this"
        ),
    )
    # Strict, so a string such as "true" is refused instead of silently changing what the service does.
    restrict_only: StrictBool = Field(
        default=False,
        description=(
            "Only limit paths, for a service a user adds; a config service is refused with it and uses "
            "restrict_to_rules. The rules take part in the path check like restrict_to_rules (which this implies), "
            "but never choose a credential, so an allowed path still uses the credential of the most specific other "
            "service on the host. Such a service has no key, OAuth login, or placeholders, its rules need no auth, "
            "and a preset contributes only its display_name, description, and rules. Presets never set this"
        ),
    )

    @property
    def restricts_paths(self) -> bool:
        """Return whether the service's party refuses paths none of its rules match on the service's hosts."""
        return self.restrict_to_rules or self.restrict_only

    @model_validator(mode="wrap")
    @classmethod
    def expand_preset(cls, data: object, handler: ModelWrapValidatorHandler[EgressService]) -> EgressService:
        """Resolve the selected preset without marking its values as authored.

        Preset values are merged under the authored fields before field validation,
        so every existing validator runs on the resolved service.
        Afterwards only the authored fields stay in `model_fields_set`,
        so `Config.authored_model_dump()` keeps `{preset: github}` as written and later preset updates still apply.
        A `restrict_only` service takes no login or placeholders from its preset, since it never sends a credential.
        """
        if not isinstance(data, dict):
            return cls._check_resolved(handler(data))
        authored = cast("dict[str, object]", data)
        name = authored.get("preset")
        if not isinstance(name, str):
            return cls._check_resolved(handler(data))
        preset = EGRESS_PRESETS.get(name)
        if preset is None:
            known = ", ".join(sorted(EGRESS_PRESETS))
            msg = f"unknown egress preset '{name}' (known presets: {known})"
            raise ValueError(msg)
        # Deep copy so validated models never alias the shared built-in table.
        defaults = copy.deepcopy(preset)
        if authored.get("restrict_only") is True:
            for credential_field in ("oauth_provider", "placeholder_env"):
                defaults.pop(credential_field, None)
        service = handler({**defaults, **authored})
        service.model_fields_set.difference_update(set(preset) - set(authored))
        return cls._check_resolved(service)

    def authored_model_dump(self) -> dict[str, object]:
        """Serialize the service as authored: a preset stays `{preset: github}`, so later preset updates still apply."""
        return self.model_dump(mode="json", exclude_unset=True)

    @classmethod
    def _check_resolved(cls, service: EgressService) -> EgressService:
        """Reject a resolved service without rules, or with credential settings that do not fit `restrict_only`.

        A service that sends a credential needs `auth` on every rule. A `restrict_only` service never sends one, so it
        may not set an OAuth login, placeholders, or `oauth_on_shared_workers`. The error path carries the service name.
        """
        if not service.rules:
            msg = "service must define at least one rule (set `rules` or choose a `preset`)"
            raise ValueError(msg)
        if service.restrict_only:
            if service.oauth_provider is not None:
                msg = "a restrict_only service never sends a credential, so it cannot set oauth_provider"
                raise ValueError(msg)
            if service.placeholder_env:
                msg = "a restrict_only service never sends a credential, so it cannot set placeholder_env"
                raise ValueError(msg)
            if service.oauth_on_shared_workers:
                msg = "a restrict_only service never sends a credential, so it cannot set oauth_on_shared_workers"
                raise ValueError(msg)
        elif any(rule.auth is None for rule in service.rules):
            msg = "every rule needs auth unless the service is restrict_only"
            raise ValueError(msg)
        return service

    @field_validator("placeholder_env")
    @classmethod
    def validate_placeholder_env(cls, value: dict[str, str]) -> dict[str, str]:
        """Validate placeholder env names."""
        pattern = re.compile(r"^[A-Z_][A-Z0-9_]*$")
        reserved_all = _RESERVED_EXACT | _RESERVED_PROXY_VARS | _RESERVED_CA_VARS

        for name in value:
            # Must match pattern
            if not pattern.fullmatch(name):
                msg = f"placeholder_env name '{name}' must match ^[A-Z_][A-Z0-9_]*$"
                raise ValueError(msg)

            # Check exact reserved names
            if name in reserved_all:
                msg = f"placeholder_env name '{name}' is reserved"
                raise ValueError(msg)

            # Check reserved prefixes
            for prefix in _RESERVED_PREFIXES:
                if name.startswith(prefix):
                    msg = f"placeholder_env name '{name}' starts with reserved prefix {prefix}"
                    raise ValueError(msg)

        return value


_SERVICE_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{0,62}$")


def validate_egress_service_name(name: str) -> None:
    """Raise ValueError unless `name` is a valid egress service name, for config and user services alike.

    A name starts with `[a-z0-9]`, so no service's secret can take a reserved `egress__*` store name.
    """
    if not _SERVICE_NAME_PATTERN.fullmatch(name):
        msg = f"service name '{name}' must match ^[a-z0-9][a-z0-9_-]{{0,62}}$"
        raise ValueError(msg)
    # Secrets are stored as `egress_<name>`; OAuth suffixes there would read as OAuth services.
    credential_service = f"egress_{name}"
    if is_oauth_token_service(credential_service) or is_oauth_client_config_service(credential_service):
        msg = f"service name '{name}' must not end in '_oauth' or '_oauth_client' (reserved for OAuth)"
        raise ValueError(msg)


class EgressBrokerConfig(BaseModel):
    """Top-level egress broker configuration."""

    model_config = ConfigDict(extra="forbid")

    unmatched_hosts: Literal["passthrough", "deny"] = Field(
        default="passthrough",
        description="Action for hosts with no matching rules",
    )
    services: dict[str, EgressService] = Field(
        default_factory=dict,
        description="Service configurations by name",
    )

    @field_validator("services")
    @classmethod
    def validate_services(cls, value: dict[str, EgressService]) -> dict[str, EgressService]:
        """Validate service names, and refuse `restrict_only`, which only services users add may set.

        A user's limit narrows the administrator's service in place; in the config, the service that holds the
        credential limits its own paths with `restrict_to_rules`. The broker merges a scope's user services into a
        copy of this config without validating it again (`user_services.effective_config`).
        """
        for name, service in value.items():
            validate_egress_service_name(name)
            if service.restrict_only:
                msg = f"service '{name}': restrict_only is only for services users add; use restrict_to_rules in config"
                raise ValueError(msg)
        return value
