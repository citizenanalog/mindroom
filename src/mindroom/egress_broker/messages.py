"""The plain sentence each broker refusal carries, so an agent can tell its user what went wrong and where to fix it."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = ["ScopeInfo", "refusal_body"]

# Texts from the design spec (sections 12.5 and 14). They name only a service, provider, host, path without its
# query, or manager IDs, never a secret, token, or connect link: the links travel in their own fields, which the texts
# name.
_MESSAGES = {
    "credential_not_configured": "No {service} key is set for this agent. Ask the user to add one at manage_url, then retry.",
    "oauth_connection_required": (
        "The {provider} account for {service} must be connected again. "
        "Ask the user to reconnect at connect_url or manage_url."
    ),
    "oauth_refresh_failed": (
        "{provider} did not refresh the account token. "
        "Retry in a minute; if it keeps failing, ask the user to reconnect at manage_url."
    ),
    "path_not_allowed": (
        "{host}{path} is outside the paths {service} allows for this agent. "
        "Ask the user to add it at manage_url if the agent needs it."
    ),
    "bad_request": (
        "The request path is ambiguous (dot segments, //, backslashes, or encoded forms of them) and was refused. "
        "Use a plain path."
    ),
    "tls_required": "Credentials are only added over HTTPS. Use https:// for {host}.",
    "host_mismatch": "The Host header does not match the host this connection was opened for.",
    "host_not_allowed": "{host} is not allowed by the administrator's egress policy.",
    "destination_blocked": "{host} resolves to a private or internal address, which agents may not reach.",
    "request_body_too_large": "The request body is larger than the broker accepts.",
    "upstream_unreachable": "{host} could not be reached.",
    "upstream_timeout": "{host} did not answer in time.",
    "broker_error": "The credential broker hit an internal error. Retry; if it keeps failing, tell an administrator.",
    "proxy_authentication_required": "The sandbox's proxy credentials are missing or expired. Start a new tool call.",
}
_CONNECTABLE = (
    "No {service} credential is set for this agent. "
    "Ask the user to connect it at connect_url or add a key at manage_url, then retry."
)
_SHARED = (
    "No {service} key is set for this shared agent. "
    "Only its credential managers ({managers}) can add one, at manage_url."
)
_SHARED_WITHOUT_MANAGERS = (
    "No {service} key is set for this shared agent. Only an administrator can add one, at manage_url."
)
_PATH_OUTSIDE = "{host}{path} is outside the paths {service} allows for this agent. "
_PATH_SHARED = _PATH_OUTSIDE + "Only its credential managers ({managers}) can change this, at manage_url."
_PATH_SHARED_WITHOUT_MANAGERS = _PATH_OUTSIDE + "Only an administrator can change this, at manage_url."
# The spec words `bad_request` for the ambiguous-path refusal; a request the broker cannot read at all has no path.
_MALFORMED = "The request is malformed and was refused."


@dataclass(frozen=True)
class ScopeInfo:
    """Who can fix a missing key for one requester's scope.

    `shared` is true for a `shared` or unscoped agent, whose keys only its credential managers (`managers`, Matrix
    IDs) and administrators may set; a personal (`user` or `user_agent`) scope's user sets their own.
    """

    shared: bool
    managers: tuple[str, ...]


def _template(code: str, *, path: str | None, managers: Sequence[str], shared: bool, connectable: bool) -> str:
    if code == "credential_not_configured" and connectable:
        return _CONNECTABLE
    if code == "credential_not_configured" and shared:
        return _SHARED if managers else _SHARED_WITHOUT_MANAGERS
    if code == "path_not_allowed" and shared:
        return _PATH_SHARED if managers else _PATH_SHARED_WITHOUT_MANAGERS
    if code == "bad_request" and path is None:
        return _MALFORMED
    try:
        return _MESSAGES[code]
    except KeyError:
        msg = f"No refusal message for {code}."
        raise ValueError(msg) from None


def refusal_body(
    code: str,
    *,
    host: str | None = None,
    path: str | None = None,
    service: str | None = None,
    service_label: str | None = None,
    provider: str | None = None,
    managers: Sequence[str] | None = None,
    shared: bool = False,
    connectable: bool = False,
    **extra: object,
) -> dict[str, object]:
    """Return the JSON body for a refusal: its `error` code, `message`, `service` and `provider` when given, and `extra`.

    `host`, `path`, `service_label`, and `managers` only fill in the message; `path` is cut at its query, which could
    hold a secret, and `service_label` (a display name) names the service there instead of `service`.
    For `credential_not_configured`, `connectable` offers connecting an account as well as adding a key, and
    otherwise a `shared` scope names its `managers` (or an administrator when there are none); a `shared`
    `path_not_allowed` names them as the ones who can change the limit. A `bad_request` with a `path` is the
    ambiguous-path refusal; without one, the request itself was malformed. Raises ValueError for a code without a
    text and KeyError when the text needs a value that was not given.
    """
    template = _template(code, path=path, managers=managers or (), shared=shared, connectable=connectable)
    values = {
        "host": host,
        "path": None if path is None else path.split("?", 1)[0],
        "service": service_label or service,
        "provider": provider,
        "managers": ", ".join(managers or ()),
    }
    message = template.format_map({name: value for name, value in values.items() if value is not None})
    body: dict[str, object] = {"error": code}
    if service is not None:
        body["service"] = service
    if provider is not None:
        body["provider"] = provider
    return {**body, **extra, "message": message}
