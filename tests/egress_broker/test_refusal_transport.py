"""Tests for how every broker refusal reaches its client: the code header, the reason phrase, and git's ERR line."""

from __future__ import annotations

import asyncio
import os
import shutil
from typing import TYPE_CHECKING

import pytest

from mindroom.config.egress_broker import EgressAuth, EgressBrokerConfig, EgressRule, EgressService
from mindroom.egress_broker.ca import materialize_ca_bundle
from mindroom.egress_broker.rules import EgressRules
from tests.egress_broker.conftest import audit_records, proxy_authorization

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable
    from pathlib import Path

    import httpx

    from mindroom.egress_broker.audit import AuditLog
    from tests.egress_broker.conftest import BrokerFactory, RawResponse, Upstream

    ProxyClient = Callable[..., httpx.AsyncClient]
    RawProxy = Callable[[int, bytes], Awaitable[RawResponse]]

MISSING_KEY = "No svc key is set for this agent. Ask the user to add one at manage_url, then retry."
TLS_REQUIRED = "Credentials are only added over HTTPS. Use https:// for localhost."
_PROXY_ENV = {"http_proxy", "https_proxy", "all_proxy", "no_proxy", "git_askpass", "ssh_askpass"}


def _config(*, unmatched_hosts: str = "passthrough") -> EgressBrokerConfig:
    rule = EgressRule(host="localhost", auth=EgressAuth(type="basic", username="x-access-token"))
    return EgressBrokerConfig.model_validate(
        {"unmatched_hosts": unmatched_hosts, "services": {"svc": EgressService(rules=[rule])}},
    )


def _plain_get(target: str, *, token: str | None, method: str = "GET") -> bytes:
    lines = [f"{method} {target} HTTP/1.1", "Host: localhost"]
    if token is not None:
        lines.append(f"Proxy-Authorization: {proxy_authorization(token)}")
    return ("\r\n".join(lines) + "\r\n\r\n").encode()


def _pkt_line(text: str) -> bytes:
    """Frame one pkt-line the way git reads it: the length, prefix included, as four lowercase hex digits."""
    data = text.encode()
    return f"{len(data) + 4:04x}".encode() + data


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target", "with_token", "status", "code"),
    [
        ("http://localhost:1/echo", False, 407, "proxy_authentication_required"),
        ("http://localhost:1/echo", True, 403, "tls_required"),
        ("http://elsewhere.example/x", True, 403, "host_not_allowed"),
        ("ftp://localhost/x", True, 400, "bad_request"),
    ],
)
async def test_plain_refusals_carry_the_code_header_and_the_message_as_reason(
    broker: BrokerFactory,
    raw_proxy: RawProxy,
    target: str,
    with_token: bool,
    status: int,
    code: str,
) -> None:
    """Clients that print only the status line show the message; scripts read the code from X-MindRoom-Error."""
    started = await broker(_config(unmatched_hosts="deny"))

    response = await raw_proxy(started.port, _plain_get(target, token=broker.token() if with_token else None))

    assert response.status == status
    assert response.headers["x-mindroom-error"] == code
    assert response.json()["error"] == code
    assert response.reason == response.json()["message"]
    assert response.headers["content-type"] == "application/json"
    if status == 407:
        assert response.headers["proxy-authenticate"] == 'Basic realm="mindroom-egress-broker"'


@pytest.mark.asyncio
async def test_tunnel_refusal_carries_the_code_header_and_the_message_as_reason(
    broker: BrokerFactory,
    tls_upstream: Upstream,
    proxy_client: ProxyClient,
) -> None:
    """A refusal inside an intercepted tunnel has the same header and reason phrase as a plain one."""
    await broker(_config())

    response = await proxy_client(broker.token()).get(tls_upstream.url("/echo"))

    assert response.status_code == 403
    assert response.headers["x-mindroom-error"] == "credential_not_configured"
    assert response.reason_phrase == MISSING_KEY
    assert response.json()["message"] == MISSING_KEY
    assert tls_upstream.hits == []


@pytest.mark.asyncio
async def test_reason_phrase_is_printable_ascii_without_line_breaks_and_at_most_200_characters(
    broker: BrokerFactory,
    tls_upstream: Upstream,
    proxy_client: ProxyClient,
) -> None:
    """A display name with CR, LF, or non-ASCII text never splits the status line; a long message is cut at 200."""
    operator = _config()
    limit = EgressService(
        restrict_only=True,
        display_name="Evil\r\nX-Injected: yes café",
        rules=[EgressRule(host="localhost", path_prefix="/echo")],
    )
    effective = operator.model_copy(update={"services": {**operator.services, "limit": limit}})
    await broker(rules_provider=lambda _claims: EgressRules(operator=operator, effective=effective))
    long_path = "/other/" + "a" * 300

    response = await proxy_client(broker.token()).get(tls_upstream.url(long_path))

    assert response.status_code == 403
    assert "x-injected" not in response.headers
    message = response.json()["message"]
    assert message.startswith(f"localhost{long_path} is outside the paths Evil\r\nX-Injected: yes café allows")
    expected = message.replace("\r", "").replace("\n", "").replace("é", "?")[:200]
    assert response.reason_phrase == expected
    assert len(response.reason_phrase) == 200


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("service", "first_line"),
    [
        ("git-upload-pack", b"001e# service=git-upload-pack\n"),
        ("git-receive-pack", b"001f# service=git-receive-pack\n"),
    ],
)
async def test_git_discovery_refusal_in_a_tunnel_is_an_advertisement_ending_in_err(
    broker: BrokerFactory,
    tls_upstream: Upstream,
    proxy_client: ProxyClient,
    audit: AuditLog,
    service: str,
    first_line: bytes,
) -> None:
    """Git reads `ERR <message>` from a 200 advertisement and prints it; the audit row keeps the refusal code."""
    await broker(_config())

    response = await proxy_client(broker.token()).get(tls_upstream.url(f"/repo.git/info/refs?service={service}"))

    assert response.status_code == 200
    assert response.headers["content-type"] == f"application/x-{service}-advertisement"
    assert response.headers["x-mindroom-error"] == "credential_not_configured"
    assert response.reason_phrase == MISSING_KEY
    assert response.content == first_line + b"0000" + _pkt_line(f"ERR {MISSING_KEY}\n")
    assert tls_upstream.hits == []
    [record] = await audit_records(audit, 1)
    assert (record.kind, record.status, record.code, record.path) == (
        "denied",
        403,
        "credential_not_configured",
        "/repo.git/info/refs",
    )


@pytest.mark.asyncio
async def test_plain_git_discovery_refusal_is_an_advertisement_but_the_proxy_challenge_stays_a_407(
    broker: BrokerFactory,
    raw_proxy: RawProxy,
) -> None:
    """Over plain HTTP the refusal takes git's form too, but git's curl must still see the 407 to send credentials."""
    started = await broker(_config())
    target = "http://localhost:1/repo.git/info/refs?service=git-upload-pack"

    refused = await raw_proxy(started.port, _plain_get(target, token=broker.token()))
    challenge = await raw_proxy(started.port, _plain_get(target, token=None))

    assert refused.status == 200
    assert refused.headers["content-type"] == "application/x-git-upload-pack-advertisement"
    assert refused.headers["x-mindroom-error"] == "tls_required"
    assert refused.body == b"001e# service=git-upload-pack\n0000" + _pkt_line(f"ERR {TLS_REQUIRED}\n")
    assert challenge.status == 407
    assert challenge.headers["content-type"] == "application/json"
    assert challenge.headers["proxy-authenticate"] == 'Basic realm="mindroom-egress-broker"'


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/repo.git/info/refs"),
        ("GET", "/repo.git/info/refs?service=git-upload-archive"),
        ("GET", "/repo.git/info/refs?service=git-upload-pack&service=git-receive-pack"),
        ("POST", "/repo.git/info/refs?service=git-upload-pack"),
        ("GET", "/repo.git/git-upload-pack?service=git-upload-pack"),
    ],
)
async def test_other_requests_keep_the_json_refusal(
    broker: BrokerFactory,
    raw_proxy: RawProxy,
    method: str,
    path: str,
) -> None:
    """Only a GET for one smart-HTTP discovery service gets git's form; everything else keeps the JSON body."""
    started = await broker(_config())

    response = await raw_proxy(
        started.port,
        _plain_get(f"http://localhost:1{path}", token=broker.token(), method=method),
    )

    assert response.status == 403
    assert response.headers["content-type"] == "application/json"
    assert response.json()["error"] == "tls_required"


@pytest.mark.asyncio
async def test_a_target_that_does_not_parse_as_a_url_keeps_the_json_refusal(
    broker: BrokerFactory,
    raw_proxy: RawProxy,
) -> None:
    """Choosing the refusal's form never fails on a malformed target: it gets the plain 400, not a broker error."""
    started = await broker(_config())

    response = await raw_proxy(
        started.port,
        _plain_get("http://[::1]localhost/repo.git/info/refs?service=git-upload-pack", token=broker.token()),
    )

    assert response.status == 400
    assert response.headers["x-mindroom-error"] == "bad_request"
    assert response.json() == {"error": "bad_request", "message": "The request is malformed and was refused."}


async def _run(*command: str, env: dict[str, str]) -> tuple[int, str, str]:
    """Run a command line tool while the broker keeps serving on this event loop."""
    process = await asyncio.create_subprocess_exec(
        *command,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    async with asyncio.timeout(30):
        stdout, stderr = await process.communicate()
    assert process.returncode is not None
    return process.returncode, stdout.decode(), stderr.decode()


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("git") is None, reason="git not installed")
async def test_git_ls_remote_prints_the_refusal_message(
    broker: BrokerFactory,
    tls_upstream: Upstream,
    tmp_path: Path,
    audit: AuditLog,
) -> None:
    """A real git client shows `remote error: <message>` instead of a bare 403 when the broker refuses."""
    started = await broker(_config())
    bundle, _ca_only = materialize_ca_bundle(broker.ca.cert_pem, tmp_path / "trust")
    env = {name: value for name, value in os.environ.items() if name.lower() not in _PROXY_ENV}

    returncode, _stdout, stderr = await _run(
        "git",
        "-c",
        f"http.proxy=http://{broker.token()}:@127.0.0.1:{started.port}",
        "-c",
        f"http.sslCAInfo={bundle}",
        "-c",
        "credential.helper=",
        "ls-remote",
        tls_upstream.url("/repo.git"),
        env=env
        | {
            "HOME": str(tmp_path),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
        },
    )

    assert returncode != 0
    assert f"remote error: {MISSING_KEY}" in stderr
    assert tls_upstream.hits == []
    [record] = await audit_records(audit, 1)
    assert (record.status, record.code, record.path) == (403, "credential_not_configured", "/repo.git/info/refs")
