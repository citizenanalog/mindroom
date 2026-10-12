"""Tests for the plain sentence every broker refusal carries for the agent to relay."""

from __future__ import annotations

import pytest

from mindroom.egress_broker.messages import refusal_body

_CONNECT_URL = "https://m.test/api/oauth/github/authorize?connect_token=one-time-token"


@pytest.mark.parametrize(
    ("code", "values", "message"),
    [
        (
            "credential_not_configured",
            {"service": "github", "provider": "github", "connectable": True},
            "No github credential is set for this agent. "
            "Ask the user to connect it at connect_url or add a key at manage_url, then retry.",
        ),
        (
            "credential_not_configured",
            {"service": "openai"},
            "No openai key is set for this agent. Ask the user to add one at manage_url, then retry.",
        ),
        (
            "credential_not_configured",
            {"service": "openai", "shared": True, "managers": ["@alice:example.org"]},
            "No openai key is set for this shared agent. "
            "Only its credential managers (@alice:example.org) can add one, at manage_url.",
        ),
        (
            "oauth_connection_required",
            {"service": "github", "provider": "github"},
            "The github account for github must be connected again. "
            "Ask the user to reconnect at connect_url or manage_url.",
        ),
        (
            "oauth_refresh_failed",
            {"service": "drive", "provider": "google_drive"},
            "google_drive did not refresh the account token. "
            "Retry in a minute; if it keeps failing, ask the user to reconnect at manage_url.",
        ),
        (
            "path_not_allowed",
            {"host": "api.github.com", "path": "/repos/o/b", "service": "github-limited"},
            "api.github.com/repos/o/b is outside the paths github-limited allows for this agent. "
            "Ask the user to add it at manage_url if the agent needs it.",
        ),
        (
            "bad_request",
            {"path": "/repos/o/a/../b"},
            "The request path is ambiguous (dot segments, //, backslashes, or encoded forms of them) and was refused. "
            "Use a plain path.",
        ),
        (
            "method_not_allowed",
            {},
            "TRACE and TRACK requests are refused because the server would echo the request, "
            "injected credential included, back to the agent.",
        ),
        (
            "tls_required",
            {"host": "api.github.com", "service": "github"},
            "Credentials are only added over HTTPS. Use https:// for api.github.com.",
        ),
        ("host_mismatch", {}, "The Host header does not match the host this connection was opened for."),
        (
            "host_not_allowed",
            {"host": "evil.example"},
            "evil.example is not allowed by the administrator's egress policy.",
        ),
        (
            "destination_blocked",
            {"host": "metadata.internal"},
            "metadata.internal resolves to a private or internal address, which agents may not reach.",
        ),
        ("request_body_too_large", {}, "The request body is larger than the broker accepts."),
        ("upstream_unreachable", {"host": "api.github.com"}, "api.github.com could not be reached."),
        ("upstream_timeout", {"host": "api.github.com"}, "api.github.com did not answer in time."),
        (
            "broker_error",
            {},
            "The credential broker hit an internal error. Retry; if it keeps failing, tell an administrator.",
        ),
        (
            "proxy_authentication_required",
            {},
            "The sandbox's proxy credentials are missing or expired. Start a new tool call.",
        ),
    ],
)
def test_each_refusal_code_has_its_spec_text(code: str, values: dict[str, object], message: str) -> None:
    """Every code the broker answers with carries the spec's sentence, with only the given values filled in."""
    body = refusal_body(code, **values)

    assert body["error"] == code
    assert body["message"] == message


def test_shared_agent_names_every_manager() -> None:
    """A shared agent without a connect link names its managers, joined with ", "."""
    body = refusal_body(
        "credential_not_configured",
        service="openai",
        shared=True,
        managers=("@alice:example.org", "@bob:example.org"),
    )

    assert body["message"] == (
        "No openai key is set for this shared agent. "
        "Only its credential managers (@alice:example.org, @bob:example.org) can add one, at manage_url."
    )


def test_shared_agent_with_a_connect_link_gets_the_connectable_text() -> None:
    """A refusal that carries a connect link says so, even on a shared agent whose managers could be named."""
    body = refusal_body(
        "credential_not_configured",
        service="github",
        provider="github",
        shared=True,
        connectable=True,
        managers=("@alice:example.org",),
    )

    assert body["message"] == (
        "No github credential is set for this agent. "
        "Ask the user to connect it at connect_url or add a key at manage_url, then retry."
    )
    assert "@alice:example.org" not in str(body)


def test_shared_agent_without_managers_points_at_an_administrator() -> None:
    """With no credential managers, only an administrator can add the key."""
    for managers in (None, ()):
        body = refusal_body("credential_not_configured", service="openai", shared=True, managers=managers)

        assert body["message"] == (
            "No openai key is set for this shared agent. Only an administrator can add one, at manage_url."
        )


def test_path_not_allowed_names_the_display_name_and_on_shared_agents_who_can_change_it() -> None:
    """The limit's display name names it; a shared agent's refusal names its managers, or an administrator."""
    values = {"host": "api.github.com", "path": "/repos/o/b", "service": "github-limited"}
    outside = "api.github.com/repos/o/b is outside the paths GitHub (o/a) allows for this agent. "

    personal = refusal_body("path_not_allowed", service_label="GitHub (o/a)", **values)
    shared = refusal_body(
        "path_not_allowed",
        service_label="GitHub (o/a)",
        shared=True,
        managers=("@alice:example.org", "@bob:example.org"),
        **values,
    )
    unmanaged = refusal_body("path_not_allowed", service_label="GitHub (o/a)", shared=True, **values)

    assert personal["message"] == outside + "Ask the user to add it at manage_url if the agent needs it."
    assert shared["message"] == (
        outside + "Only its credential managers (@alice:example.org, @bob:example.org) can change this, at manage_url."
    )
    assert unmanaged["message"] == outside + "Only an administrator can change this, at manage_url."
    # The machine-readable field keeps the service name.
    assert {personal["service"], shared["service"], unmanaged["service"]} == {"github-limited"}


@pytest.mark.parametrize(
    ("shared", "managers"),
    [(False, ()), (True, ("@alice:example.org",)), (True, ())],
    ids=["personal", "shared-with-managers", "shared-without-managers"],
)
def test_path_not_allowed_by_the_operator_names_an_administrator_whatever_the_scope(
    shared: bool,
    managers: tuple[str, ...],
) -> None:
    """Only an administrator edits the operator's services, so neither the user nor the managers are sent to do it."""
    body = refusal_body(
        "path_not_allowed",
        host="api.github.com",
        path="/user",
        service="github",
        service_label="GitHub",
        shared=shared,
        managers=managers,
        by_operator=True,
    )

    assert body["message"] == (
        "api.github.com/user is outside the paths GitHub allows for this agent. "
        "Only an administrator can change this, at manage_url."
    )
    assert set(body) == {"error", "service", "message"}


def test_path_in_a_message_never_includes_the_query() -> None:
    """A query can hold a secret the client sent, so the message names the path without it."""
    body = refusal_body(
        "path_not_allowed",
        host="api.github.com",
        path="/repos/o/b?access_token=leaked&page=2",
        service="github",
    )

    assert body["message"] == (
        "api.github.com/repos/o/b is outside the paths github allows for this agent. "
        "Ask the user to add it at manage_url if the agent needs it."
    )
    assert "leaked" not in str(body)


def test_body_keeps_its_fields_and_adds_only_service_and_provider() -> None:
    """Service and provider join the body when given; other fields pass through, and the text inputs stay out."""
    body = refusal_body(
        "credential_not_configured",
        service="github",
        provider="github",
        connectable=True,
        manage_url="https://m.test/connections/egress",
        connect_url=_CONNECT_URL,
    )

    assert body == {
        "error": "credential_not_configured",
        "service": "github",
        "provider": "github",
        "manage_url": "https://m.test/connections/egress",
        "connect_url": _CONNECT_URL,
        "message": "No github credential is set for this agent. "
        "Ask the user to connect it at connect_url or add a key at manage_url, then retry.",
    }
    assert "connect_token" not in str(body["message"])
    assert refusal_body("host_not_allowed", host="evil.example", services=["github"]) == {
        "error": "host_not_allowed",
        "services": ["github"],
        "message": "evil.example is not allowed by the administrator's egress policy.",
    }


def test_malformed_request_without_a_path_gets_its_own_text() -> None:
    """A `bad_request` without a path is a request the broker could not read, not an ambiguous path."""
    assert refusal_body("bad_request") == {
        "error": "bad_request",
        "message": "The request is malformed and was refused.",
    }


def test_unknown_code_or_missing_value_is_a_programming_error() -> None:
    """A code without a text, or a text missing a value it names, raises instead of writing a broken sentence."""
    with pytest.raises(ValueError, match="no_such_code"):
        refusal_body("no_such_code")
    with pytest.raises(KeyError, match="host"):
        refusal_body("upstream_unreachable")
