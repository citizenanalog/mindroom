"""Raw-socket corpus for request smuggling, framing, and TLS edge cases (spec section 13).

Requests are written as raw bytes, as plain proxy requests and inside an intercepted tunnel, because a client
library would normalize the edge cases away. The fake upstream reads what it receives with its own strict
parser, which refuses anything another HTTP/1.1 parser could frame differently (both framing headers, repeated
framing headers, bare CR or LF, folded lines, trailers). So every case asserts exactly what was forwarded: one
well-framed request per request the broker parsed, or nothing. Each case also checks that the injected secret
reached only the CONNECT host, once per forwarded request and never the client, and that the listener still
serves a fresh request afterwards.
"""

from __future__ import annotations

import asyncio
import json
import re
import ssl
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Literal

import pytest
import pytest_asyncio
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID
from structlog.testing import capture_logs

from mindroom.config.egress_broker import EgressAuth, EgressBrokerConfig, EgressRule, EgressService
from tests.egress_broker.conftest import connect_request, proxy_authorization, read_raw_response

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
    from pathlib import Path

    from tests.egress_broker.conftest import BrokerFactory, UpstreamCA

SECRET = "smuggle-s3cret"  # noqa: S105 - test credential injected for the intercepted host
INJECTED = b"Bearer " + SECRET.encode()
# A complete response an upstream sends where nothing asked for it; relayed, it would answer the next request.
STRAY_RESPONSE = b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nSMUGGLED"
OK = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
SECOND = b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nsecond"
MAX_BODY = 1024

type Action = bytes | float | Literal["close"]
type Script = Callable[[int], Sequence[Action]]


def _config() -> EgressBrokerConfig:
    rule = EgressRule(host="localhost", path_prefix="/", auth=EgressAuth(type="bearer"))
    return EgressBrokerConfig(services={"svc": EgressService(rules=[rule])})


# A strict upstream-side parser: the "different parser" every forwarded byte must read the same way.

_TOKEN = rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+"
_REQUEST_LINE = re.compile(rb"(" + _TOKEN + rb") (\S+) HTTP/1\.1")
_HEADER_LINE = re.compile(rb"(" + _TOKEN + rb"):[ \t]*([^\r\n]*?)[ \t]*")
_CHUNK_SIZE = re.compile(rb"[0-9a-f]+")


@dataclass(frozen=True)
class Forwarded:
    """One request as the upstream read it; `body` is None when the body never fully arrived."""

    method: bytes
    target: bytes
    headers: tuple[tuple[bytes, bytes], ...]
    body: bytes | None

    def header(self, name: bytes) -> list[bytes]:
        """Return every value of the lowercase header `name`, in order."""
        return [value for key, value in self.headers if key == name]


def _strict_head(head: bytes) -> tuple[bytes, bytes, tuple[tuple[bytes, bytes], ...]]:
    lines = head.split(b"\r\n")
    assert not [line for line in lines if b"\r" in line or b"\n" in line], f"bare CR or LF in {head!r}"
    request_line = _REQUEST_LINE.fullmatch(lines[0])
    assert request_line, f"request line {lines[0]!r}"
    headers = []
    for line in lines[1:]:
        # A folded continuation line starts with whitespace, which is not a header name.
        header = _HEADER_LINE.fullmatch(line)
        assert header, f"header line {line!r}"
        headers.append((header[1].lower(), header[2]))
    return request_line[1], request_line[2], tuple(headers)


def _strict_chunked(rest: bytes) -> tuple[bytes | None, bytes]:
    body = bytearray()
    while True:
        line, separator, after = rest.partition(b"\r\n")
        if not separator:
            return None, b""
        assert _CHUNK_SIZE.fullmatch(line), f"chunk size line {line!r}"
        size = int(line, 16)
        if size == 0:
            if len(after) < 2:
                return None, b""
            assert after[:2] == b"\r\n", f"trailer fields forwarded: {after[:80]!r}"
            return bytes(body), after[2:]
        if len(after) < size + 2:
            return None, b""
        assert after[size : size + 2] == b"\r\n", "chunk data not followed by CRLF"
        body += after[:size]
        rest = after[size + 2 :]


def _strict_body(headers: tuple[tuple[bytes, bytes], ...], rest: bytes) -> tuple[bytes | None, bytes]:
    lengths = [value for name, value in headers if name == b"content-length"]
    codings = [value for name, value in headers if name == b"transfer-encoding"]
    assert not (lengths and codings), "Content-Length beside Transfer-Encoding"
    assert len(lengths) <= 1, f"repeated Content-Length {lengths!r}"
    assert len(codings) <= 1, f"repeated Transfer-Encoding {codings!r}"
    if codings:
        assert codings == [b"chunked"], f"Transfer-Encoding {codings!r}"
        return _strict_chunked(rest)
    assert not lengths or lengths[0].isdigit(), f"Content-Length {lengths!r}"
    size = int(lengths[0]) if lengths else 0
    if len(rest) < size:
        return None, b""
    return rest[:size], rest[size:]


def parse_forwarded(raw: bytes, *, final: bool = False) -> list[Forwarded]:
    """Read one connection's bytes as a strict server would; the last request may be partial.

    Bytes after a complete request must start another well-formed head, so the count is exact. Once
    everything has arrived (`final`), bytes that never complete a head are refused too.
    """
    requests: list[Forwarded] = []
    while raw:
        head, separator, rest = raw.partition(b"\r\n\r\n")
        if not separator:
            assert not final, f"bytes that start no complete head: {raw[:80]!r}"
            break
        method, target, headers = _strict_head(head)
        body, raw = _strict_body(headers, rest)
        requests.append(Forwarded(method, target, headers, body))
        if body is None:
            break
    return requests


# A fake upstream that records raw bytes per connection and answers each complete request with a script.


@dataclass
class RawUpstream:
    """A loopback upstream whose `script(n)` gives the actions answering the n-th complete request it reads.

    An action writes bytes, sleeps for a float of seconds, or closes the connection ("close").
    `n` counts across connections, so a redialed connection continues the script. Bytes are recorded
    as they arrive, so a reset that follows them cannot hide them.
    """

    script: Script
    port: int = 0
    connections: list[bytearray] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    requested: int = 0
    answered: int = 0
    transports: list[asyncio.BaseTransport] = field(default_factory=list)

    @property
    def raw(self) -> bytes:
        """Return every byte received, across connections."""
        return b"".join(self.connections)

    @property
    def requests(self) -> list[Forwarded]:
        """Return every request received, across connections, including a partial last one per connection."""
        return [request for received in self.connections for request in parse_forwarded(bytes(received), final=True)]

    @property
    def complete(self) -> list[Forwarded]:
        """Return the requests that arrived whole."""
        return [request for request in self.requests if request.body is not None]

    async def wait_answered(self, count: int) -> None:
        """Wait until the script ran for `count` requests."""
        async with asyncio.timeout(5):
            while self.answered < count:  # noqa: ASYNC110
                await asyncio.sleep(0.01)


class _UpstreamConnection(asyncio.Protocol):
    """One connection to a `RawUpstream`: records each byte as it arrives and runs the script per whole request."""

    def __init__(self, upstream: RawUpstream) -> None:
        self._upstream = upstream
        self._received = bytearray()
        self._handled = 0
        self._pending: asyncio.Queue[int] = asyncio.Queue()
        self._transport: asyncio.Transport | None = None
        self._responder: asyncio.Task[None] | None = None

    def connection_made(self, transport: asyncio.BaseTransport) -> None:
        assert isinstance(transport, asyncio.Transport)
        self._transport = transport
        self._upstream.connections.append(self._received)
        self._upstream.transports.append(transport)
        self._responder = asyncio.get_running_loop().create_task(self._respond(transport))

    def data_received(self, data: bytes) -> None:
        self._received += data
        try:
            complete = sum(request.body is not None for request in parse_forwarded(bytes(self._received)))
        except AssertionError as exc:
            self._upstream.errors.append(str(exc))
            assert self._transport is not None
            self._transport.abort()
            return
        for _ in range(complete - self._handled):
            self._pending.put_nowait(self._upstream.requested)
            self._upstream.requested += 1
        self._handled = complete

    def connection_lost(self, exc: Exception | None) -> None:  # noqa: ARG002 - the Protocol signature
        if self._responder is not None:
            self._responder.cancel()

    async def _respond(self, transport: asyncio.Transport) -> None:
        while True:
            index = await self._pending.get()
            try:
                for action in self._upstream.script(index):
                    if action == "close":
                        transport.close()
                        return
                    if isinstance(action, float):
                        await asyncio.sleep(action)
                    else:
                        assert isinstance(action, bytes)
                        transport.write(action)
            finally:
                self._upstream.answered += 1


type UpstreamFactory = Callable[..., Awaitable[RawUpstream]]


@pytest_asyncio.fixture
async def upstreams(upstream_ca: UpstreamCA, tmp_path: Path) -> AsyncIterator[UpstreamFactory]:
    """Return ``start(script=None, *, tls=False, ssl_context=None)``, starting a `RawUpstream` on 127.0.0.1.

    Without a script every request gets a short 200; ``tls=True`` serves `upstream_ca`'s ``localhost`` certificate.
    """
    started: list[tuple[RawUpstream, asyncio.Server]] = []

    async def start(
        script: Script | None = None,
        *,
        tls: bool = False,
        ssl_context: ssl.SSLContext | None = None,
    ) -> RawUpstream:
        upstream = RawUpstream(script=script or (lambda _index: [OK]))
        context = ssl_context or (upstream_ca.server_context(tmp_path) if tls else None)
        server = await asyncio.get_running_loop().create_server(
            lambda: _UpstreamConnection(upstream),
            "127.0.0.1",
            0,
            ssl=context,
        )
        upstream.port = server.sockets[0].getsockname()[1]
        started.append((upstream, server))
        return upstream

    yield start
    for upstream, server in started:
        server.close()
        for transport in upstream.transports:
            transport.abort()
        await server.wait_closed()


# The worker side: a raw client connection that keeps every byte the broker sent.


@dataclass(frozen=True)
class Reply:
    """One response read off the client socket; `complete` is False when the broker cut it off mid-body."""

    status: int
    headers: dict[str, str]
    body: bytes
    complete: bool = True


@dataclass
class Client:
    """A raw connection to the broker: plain, or switched to TLS inside a CONNECT tunnel."""

    reader: asyncio.StreamReader
    writer: asyncio.StreamWriter
    received: bytearray = field(default_factory=bytearray)

    def send(self, data: bytes) -> None:
        """Write raw bytes to the broker."""
        self.writer.write(data)

    async def _read(self, operation: Awaitable[bytes]) -> bytes:
        data = await operation
        self.received += data
        return data

    async def _body(self, headers: dict[str, str], *, head: bool, status: int) -> bytes:
        if head or status < 200 or status in {204, 304}:
            return b""
        if "content-length" in headers:
            return await self._read(self.reader.readexactly(int(headers["content-length"])))
        if headers.get("transfer-encoding") == "chunked":
            body = bytearray()
            while size := int((await self._read(self.reader.readuntil(b"\r\n"))).strip(), 16):
                body += (await self._read(self.reader.readexactly(size + 2)))[:-2]
            await self._read(self.reader.readuntil(b"\r\n"))
            return bytes(body)
        return await self._read(self.reader.read())

    async def reply(self, *, head: bool = False) -> Reply | None:
        """Read one response; None when the broker closed the connection before sending one."""
        async with asyncio.timeout(10):
            try:
                raw_head = await self._read(self.reader.readuntil(b"\r\n\r\n"))
            except (asyncio.IncompleteReadError, ConnectionResetError, ssl.SSLError) as exc:
                if isinstance(exc, asyncio.IncompleteReadError):
                    self.received += exc.partial
                return None
            lines = raw_head.decode("latin-1").removesuffix("\r\n\r\n").split("\r\n")
            status = int(lines[0].split(" ")[1])
            headers = {
                name.strip().lower(): value.strip() for name, _, value in (line.partition(":") for line in lines[1:])
            }
            try:
                body = await self._body(headers, head=head, status=status)
            except (asyncio.IncompleteReadError, ConnectionResetError, ssl.SSLError) as exc:
                partial = exc.partial if isinstance(exc, asyncio.IncompleteReadError) else b""
                self.received += partial
                return Reply(status, headers, partial, complete=False)
        return Reply(status, headers, body)

    async def closed(self) -> bool:
        """Return whether the broker closes the connection without sending anything more."""
        try:
            async with asyncio.timeout(10):
                rest = await self._read(self.reader.read())
        except (ConnectionResetError, ssl.SSLError):
            rest = b""
        return rest == b""

    def close(self) -> None:
        """Drop the connection without a clean shutdown."""
        self.writer.transport.abort()


async def _connect(port: int) -> Client:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    return Client(reader, writer)


async def _open_tunnel(
    broker: BrokerFactory,
    target_port: int,
    *,
    context: ssl.SSLContext | None = None,
    server_hostname: str | None = "localhost",
) -> Client:
    """CONNECT to ``localhost:<target_port>`` and start TLS inside the tunnel, trusting the broker CA."""
    client = await _connect(broker.latest.port)
    client.send(connect_request(f"localhost:{target_port}", authorization=proxy_authorization(broker.token())))
    assert (await read_raw_response(client.reader)).status == 200
    await client.writer.start_tls(
        context or ssl.create_default_context(cadata=broker.ca.cert_pem),
        server_hostname=server_hostname,
    )
    return client


@dataclass(frozen=True)
class Target:
    """Where a corpus request goes: absolute-form with proxy credentials, or origin-form inside a tunnel."""

    tunnel: bool
    prefix: str
    host: str
    auth: str

    def render(self, template: str) -> bytes:
        """Fill ``{t}`` (the target before the path), ``{h}`` (the Host value), and ``{a}`` (the credential line)."""
        return template.format(t=self.prefix, h=self.host, a=self.auth).encode("latin-1")


async def _client_for(broker: BrokerFactory, upstream: RawUpstream, *, tunnel: bool) -> tuple[Client, Target]:
    """Open a connection whose requests reach `upstream`: through an intercepted tunnel, or as plain HTTP.

    The plain upstream is 127.0.0.1, a host without rules, because a plain request a rule matches is refused.
    """
    if tunnel:
        client = await _open_tunnel(broker, upstream.port)
        return client, Target(tunnel=True, prefix="", host=f"localhost:{upstream.port}", auth="")
    client = await _connect(broker.latest.port)
    authority = f"127.0.0.1:{upstream.port}"
    credential = f"Proxy-Authorization: {proxy_authorization(broker.token())}\r\n"
    return client, Target(tunnel=False, prefix=f"http://{authority}", host=authority, auth=credential)


def _assert_contained(
    *,
    intercepted: RawUpstream | None,
    others: Sequence[RawUpstream],
    client_bytes: bytes,
    host: str,
) -> None:
    """Check what reached each upstream: strictly framed, the secret only on the CONNECT host's own requests.

    Every request the intercepted upstream received, whole or partial, carries the injected value exactly once,
    and the secret appears nowhere else: not at another upstream, not in anything relayed back to the client.
    """
    for upstream in [*others, *([intercepted] if intercepted else [])]:
        assert upstream.errors == []
        for request in upstream.requests:
            assert request.header(b"host") == [host.encode()]
            assert b"smuggled" not in request.target.lower()
            assert not [value for _, value in request.headers if b"evil.example" in value]
    for other in others:
        assert SECRET.encode() not in other.raw
    if intercepted is not None:
        for request in intercepted.requests:
            assert request.header(b"authorization") == [INJECTED]
        assert intercepted.raw.count(SECRET.encode()) == len(intercepted.requests)
    assert SECRET.encode() not in client_bytes


async def _assert_listener_serves(broker: BrokerFactory, probe: RawUpstream) -> None:
    """A fresh connection still gets a valid plain request through, and the probe receives exactly it."""
    before = len(probe.complete)
    client = await _connect(broker.latest.port)
    try:
        client.send(
            (
                f"GET http://127.0.0.1:{probe.port}/probe HTTP/1.1\r\nHost: 127.0.0.1:{probe.port}\r\n"
                f"Proxy-Authorization: {proxy_authorization(broker.token())}\r\nConnection: close\r\n\r\n"
            ).encode(),
        )
        reply = await client.reply()
    finally:
        client.close()
    assert reply is not None
    assert (reply.status, reply.body) == (200, b"ok")
    assert [request.target for request in probe.complete[before:]] == [b"/probe"]


# The request corpus: each case runs as plain HTTP and inside an intercepted tunnel.


def _body(expected: bytes, *, chunked: bool) -> Callable[[Forwarded], None]:
    def check(request: Forwarded) -> None:
        assert request.body == expected
        assert request.header(b"transfer-encoding") == ([b"chunked"] if chunked else [])
        assert request.header(b"content-length") == ([] if chunked else [str(len(expected)).encode()])

    return check


def _single_line(name: bytes, value: bytes) -> Callable[[Forwarded], None]:
    def check(request: Forwarded) -> None:
        assert request.header(name) == [value]

    return check


def _no_upgrade(request: Forwarded) -> None:
    assert not {b"upgrade", b"connection", b"http2-settings"} & {name for name, _ in request.headers}


def _without_expect(check: Callable[[Forwarded], None]) -> Callable[[Forwarded], None]:
    def checked(request: Forwarded) -> None:
        check(request)
        assert request.header(b"expect") == []

    return checked


@dataclass(frozen=True)
class Outcome:
    """The statuses the client reads, in order, and what the upstream receives.

    `forwarded` counts whole requests; `partial` says whether one more head arrived whose body never did.
    `closes` defaults to closing after an error status.
    """

    statuses: tuple[int, ...]
    forwarded: int
    partial: bool = False
    closes: bool | None = None

    @property
    def expect_close(self) -> bool:
        """Return whether the broker must close the connection after the last reply."""
        return self.closes if self.closes is not None else self.statuses[-1] >= 400


@dataclass(frozen=True)
class Case:
    """One raw request (or pipelined requests) and the outcome on each path."""

    id: str
    template: str
    plain: Outcome
    tunnel: Outcome
    check: Callable[[Forwarded], None] | None = None
    rewrite: Callable[[bytes], bytes] | None = None


def _same(statuses: tuple[int, ...], forwarded: int, **kwargs: bool) -> dict[str, Outcome]:
    outcome = Outcome(statuses, forwarded, **kwargs)
    return {"plain": outcome, "tunnel": outcome}


_POST = "POST {t}/a HTTP/1.1\r\nHost: {h}\r\n{a}"
_GET = "GET {t}/a HTTP/1.1\r\nHost: {h}\r\n{a}"
# A request with no credentials and another Host: as plain HTTP it is unauthenticated, in a tunnel it is fronting.
_SMUGGLED = "GET /smuggled HTTP/1.1\r\nHost: evil.example\r\n\r\n"
_AFTER_SMUGGLE = {"plain": Outcome((200, 407), 1), "tunnel": Outcome((200, 403), 1)}
_REJECTED_TE = "Content-Length: 5\r\nTransfer-Encoding: {value}\r\n\r\n0\r\n\r\n"
_ACCEPTED_TE = "Content-Length: 5\r\n{line}\r\n\r\n0\r\n\r\n"

REQUEST_CASES = [
    # Conflicting length headers: the broker frames by Transfer-Encoding and forwards chunked framing only.
    Case(
        "cl-te",
        _POST + "Content-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n" + _SMUGGLED,
        **_AFTER_SMUGGLE,
        check=_body(b"", chunked=True),
    ),
    Case(
        "te-cl",
        _POST + "Transfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n8\r\nSMUGGLED\r\n0\r\n\r\n" + _SMUGGLED,
        **_AFTER_SMUGGLE,
        check=_body(b"SMUGGLED", chunked=True),
    ),
    *(
        Case(f"te-te-{name}", _POST + _REJECTED_TE.format(value=value), **_same((501,), 0))
        for name, value in [
            ("xchunked", "xchunked"),
            ("chunked-identity", "chunked, identity"),
            ("identity-chunked", "identity, chunked"),
            ("repeated", "chunked\r\nTransfer-Encoding: chunked"),
        ]
    ),
    Case(
        "te-te-space-before-colon",
        _POST + "Content-Length: 5\r\nTransfer-Encoding : chunked\r\n\r\n0\r\n\r\n",
        **_same((400,), 0),
    ),
    Case("te-te-vertical-tab", _POST + _REJECTED_TE.format(value="\x0bchunked"), **_same((400,), 0)),
    *(
        Case(
            f"te-te-{name}",
            _POST + _ACCEPTED_TE.format(line=line),
            **_same((200,), 1),
            check=_body(b"", chunked=True),
        )
        for name, line in [
            ("uppercase", "Transfer-Encoding: CHUNKED"),
            ("tab", "Transfer-Encoding:\tchunked"),
            ("obs-fold", "Transfer-Encoding:\r\n chunked"),
        ]
    ),
    Case(
        "cl-repeated-equal",
        _POST + "Content-Length: 3\r\nContent-Length: 3\r\n\r\nabc",
        **_same((200,), 1),
        check=_body(b"abc", chunked=False),
    ),
    Case(
        "cl-list-equal",
        _POST + "Content-Length: 3, 3\r\n\r\nabc",
        **_same((200,), 1),
        check=_body(b"abc", chunked=False),
    ),
    *(
        Case(f"cl-{name}", _POST + f"{lines}\r\n\r\nabc", **_same((400,), 0))
        for name, lines in [
            ("conflicting", "Content-Length: 3\r\nContent-Length: 4"),
            ("list-conflicting", "Content-Length: 3, 4"),
            ("plus-sign", "Content-Length: +3"),
            ("minus-sign", "Content-Length: -3"),
            ("hex", "Content-Length: 0x3"),
            # h11 refuses more than 20 digits.
            ("too-many-digits", "Content-Length: 100000000000000000003"),
        ]
    ),
    # 2**64 + 3 wraps to 3 in a 64-bit parser; the broker reads it whole and refuses it as too large.
    Case("cl-wraps-64-bit", _POST + "Content-Length: 18446744073709551619\r\n\r\nabc", **_same((413,), 0)),
    # Chunk sizes: the head is already upstream when a bad chunk arrives, so the upstream sees one partial request.
    Case(
        "chunk-size-too-long",
        _POST + "Transfer-Encoding: chunked\r\n\r\n" + "1" * 21 + "\r\nabc\r\n0\r\n\r\n",
        **_same((400,), 0, partial=True),
    ),
    Case(
        # 2**64 + 3 wraps to 3 in a 64-bit parser, which would read the rest as a second request.
        "chunk-size-wraps-64-bit",
        _POST + "Transfer-Encoding: chunked\r\n\r\n10000000000000003\r\nabc\r\n0\r\n\r\n" + _SMUGGLED + "x" * MAX_BODY,
        **_same((413,), 0, partial=True),
    ),
    Case(
        "chunk-size-negative",
        _POST + "Transfer-Encoding: chunked\r\n\r\n-3\r\nabc\r\n0\r\n\r\n",
        **_same((400,), 0, partial=True),
    ),
    Case(
        "chunk-bare-lf",
        _POST + "Transfer-Encoding: chunked\r\n\r\n3\nabc\n0\n\n\r\n",
        **_same((400,), 0, partial=True),
    ),
    Case(
        "chunk-bad-terminator",
        _POST + "Transfer-Encoding: chunked\r\n\r\n3\r\nabcXX0\r\n\r\n",
        **_same((400,), 0, partial=True),
    ),
    Case(
        "chunk-extension",
        _POST + "Transfer-Encoding: chunked\r\n\r\n3;ext=1\r\nabc\r\n0\r\n\r\n",
        **_same((200,), 1),
        check=_body(b"abc", chunked=True),
    ),
    Case(
        "chunk-trailer-dropped",
        _POST + "Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nAuthorization: Bearer forged\r\n\r\n",
        **_same((200,), 1),
        check=_body(b"abc", chunked=True),
    ),
    # Line endings and folding: whatever h11 accepts is re-serialized with CRLF and one line per header.
    Case("bare-lf-head", _GET + "\r\n", **_same((200,), 1), rewrite=lambda raw: raw.replace(b"\r\n", b"\n")),
    Case("bare-cr-head", "GET {t}/a HTTP/1.1\rHost: {h}\r\n{a}\r\n", **_same((400,), 0)),
    Case("cr-in-header-value", _GET + "X-Note: a\rb\r\n\r\n", **_same((400,), 0)),
    Case("nul-in-header-value", _GET + "X-Note: a\x00b\r\n\r\n", **_same((400,), 0)),
    Case(
        "obs-fold-value",
        _GET + "X-Folded: one\r\n two\r\n\r\n",
        **_same((200,), 1),
        check=_single_line(b"x-folded", b"one two"),
    ),
    Case("obs-fold-first-line", "GET {t}/a HTTP/1.1\r\n X-Folded: one\r\nHost: {h}\r\n{a}\r\n", **_same((400,), 0)),
    # h11 limits only an incomplete head (16 KiB), so the head never ends; the broker reads it all before answering.
    Case("oversized-head", _GET + "X-Big: " + "a" * 20_000, **_same((431,), 0)),
    Case("repeated-host", _GET + "Host: evil.example\r\n\r\n", **_same((400,), 0)),
    # Pipelined requests that would reach another host.
    Case(
        "pipelined-other-host",
        _GET + "\r\n" + _SMUGGLED,
        plain=Outcome((200, 407), 1),
        tunnel=Outcome((200, 403), 1),
    ),
    Case(
        "pipelined-absolute-form",
        _GET + "\r\nGET http://localhost:1/smuggled HTTP/1.1\r\nHost: localhost:1\r\n{a}\r\n",
        # As plain HTTP it is a request to the rule host, which needs TLS; in a tunnel only origin-form routes.
        plain=Outcome((200, 403), 1),
        tunnel=Outcome((200, 400), 1),
    ),
    Case(
        "pipelined-after-connection-close",
        _GET + "Connection: close\r\n\r\n" + _SMUGGLED,
        **_same((200,), 1, closes=True),
    ),
    Case(
        "host-differs-from-target",
        "GET {t}/a HTTP/1.1\r\nHost: evil.example\r\n{a}\r\n",
        # Plain requests route by URL and get its authority as Host; in a tunnel another Host is fronting.
        plain=Outcome((200,), 1),
        tunnel=Outcome((403,), 0),
    ),
    # A Connection header listing framing headers must not change the framing that reaches the upstream.
    Case(
        "connection-lists-content-length",
        _POST + "Connection: Content-Length\r\nContent-Length: 3\r\n\r\nabc",
        **_same((200,), 1),
        check=_body(b"abc", chunked=False),
    ),
    Case(
        "connection-lists-content-length-over-limit",
        _POST + "Connection: Content-Length\r\nContent-Length: 5000\r\n\r\n",
        **_same((413,), 0),
    ),
    Case(
        "connection-lists-transfer-encoding",
        _POST + "Connection: Transfer-Encoding\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
        **_same((200,), 1),
        check=_body(b"abc", chunked=True),
    ),
    Case(
        "connection-lists-host",
        _GET + "Connection: Host\r\n\r\n",
        **_same((200,), 1),
    ),
    # Upgrades other than websocket are dropped and the request is served as a normal one.
    Case(
        "upgrade-h2c",
        _GET
        + "Connection: Upgrade, HTTP2-Settings\r\nUpgrade: h2c\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n\r\n"
        + _GET
        + "\r\n",
        **_same((200, 200), 2),
        check=_no_upgrade,
    ),
    Case(
        "upgrade-websocket-and-h2c",
        _GET + "Connection: Upgrade\r\nUpgrade: websocket, h2c\r\n\r\n",
        **_same((200,), 1),
        check=_no_upgrade,
    ),
    Case(
        "http10-chunked",
        "POST {t}/a HTTP/1.0\r\nHost: {h}\r\n{a}Transfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n",
        **_same((200,), 1, closes=True),
        check=_body(b"abc", chunked=True),
    ),
    # Expect: the broker answers 100 itself and never forwards the header; an oversized body is refused first.
    Case(
        "expect-continue-body-sent-early",
        _POST + "Content-Length: 5\r\nExpect: 100-continue\r\n\r\nhello",
        **_same((100, 200), 1),
        check=_without_expect(_body(b"hello", chunked=False)),
    ),
    Case(
        "expect-continue-over-limit",
        _POST + "Content-Length: 5000\r\nExpect: 100-continue\r\n\r\n",
        **_same((413,), 0),
    ),
    Case(
        # The HTTP/2 prior-knowledge preface: no credentials as plain HTTP, and not origin-form in a tunnel.
        "h2-preface",
        "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
        plain=Outcome((407,), 0),
        tunnel=Outcome((400,), 0),
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("tunnel", [False, True], ids=["plain", "tunnel"])
@pytest.mark.parametrize("case", REQUEST_CASES, ids=[case.id for case in REQUEST_CASES])
async def test_request_corpus(broker: BrokerFactory, upstreams: UpstreamFactory, case: Case, tunnel: bool) -> None:
    """Each malformed or ambiguous request is refused or forwarded as exactly the requests the broker parsed."""
    await broker(_config(), secrets={"svc": SECRET}, max_body_bytes=MAX_BODY)
    upstream = await upstreams(tls=tunnel)
    probe = await upstreams()
    outcome = case.tunnel if tunnel else case.plain
    client, target = await _client_for(broker, upstream, tunnel=tunnel)
    try:
        raw = target.render(case.template)
        client.send(case.rewrite(raw) if case.rewrite else raw)
        replies = [await client.reply() for _ in outcome.statuses]
        closed = await client.closed() if outcome.expect_close else None
    finally:
        client.close()

    assert [reply.status if reply else None for reply in replies] == list(outcome.statuses)
    assert all(reply.complete for reply in replies if reply)
    assert closed is (True if outcome.expect_close else None)
    assert len(upstream.complete) == outcome.forwarded
    assert len(upstream.requests) == outcome.forwarded + outcome.partial
    if case.check is not None:
        for request in upstream.complete:
            case.check(request)
    _assert_contained(
        intercepted=upstream if tunnel else None,
        others=[probe] if tunnel else [upstream, probe],
        client_bytes=bytes(client.received),
        host=target.host,
    )
    await _assert_listener_serves(broker, probe)


# Upstream anomalies: each runs over a fresh upstream connection per request (plain) and a reused one (tunnel).


@dataclass(frozen=True)
class Anomaly:
    """A misbehaving upstream script, the requests sent one after another, and the replies the client must read.

    A reply is (status, body), with body None when only the status is checked. `truncated` marks a last reply
    cut off mid-body.
    """

    id: str
    script: Script
    replies: tuple[tuple[int, bytes | None], ...]
    forwarded: int
    methods: tuple[str, ...] = ("GET", "GET")
    truncated: bool = False


def _first_then_second(*first: Action) -> Script:
    return lambda index: first if index == 0 else [SECOND]


_HEAD_WITH_BODY = b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s" % (len(STRAY_RESPONSE), STRAY_RESPONSE)

UPSTREAM_ANOMALIES = [
    Anomaly("stray-response-same-write", _first_then_second(OK + STRAY_RESPONSE), ((200, b"ok"), (200, b"second")), 2),
    Anomaly("stray-response-later", _first_then_second(OK, 0.05, STRAY_RESPONSE), ((200, b"ok"), (200, b"second")), 2),
    Anomaly(
        "head-response-with-body",
        _first_then_second(_HEAD_WITH_BODY),
        ((200, b""), (200, b"second")),
        2,
        methods=("HEAD", "GET"),
    ),
    Anomaly(
        "no-content-response-with-body",
        _first_then_second(b"HTTP/1.1 204 No Content\r\n\r\n" + STRAY_RESPONSE),
        ((204, b""), (200, b"second")),
        2,
    ),
    Anomaly(
        "both-framings",
        _first_then_second(
            b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n",
        ),
        ((200, b"hello"), (200, b"second")),
        2,
    ),
    Anomaly(
        "read-until-close",
        _first_then_second(b"HTTP/1.1 200 OK\r\n\r\nuntil-close", "close"),
        ((200, b"until-close"), (200, b"second")),
        2,
    ),
    Anomaly(
        "head-split-across-writes",
        _first_then_second(b"HTTP/1.1 200 OK\r\nCont", 0.05, b"ent-Length: 2\r\n\r", 0.05, b"\nok"),
        ((200, b"ok"), (200, b"second")),
        2,
    ),
    Anomaly(
        "informational-before-final",
        _first_then_second(b"HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n" + OK),
        ((200, b"ok"), (200, b"second")),
        2,
    ),
    Anomaly("close-before-response", lambda _index: ["close"], ((502, None),), 1, methods=("GET",)),
    Anomaly(
        "close-mid-head",
        lambda _index: [b"HTTP/1.1 200 OK\r\nContent-Le", "close"],
        ((502, None),),
        1,
        methods=("GET",),
    ),
    Anomaly(
        "close-mid-body",
        lambda _index: [b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc", "close"],
        ((200, b"abc"),),
        1,
        methods=("GET",),
        truncated=True,
    ),
    # The second request is not retried on another connection: the upstream may already have acted on it.
    Anomaly("close-on-second-request", lambda index: [OK] if index == 0 else ["close"], ((200, b"ok"), (502, None)), 2),
    Anomaly(
        "unrequested-protocol-switch",
        lambda _index: [b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\nSMUGGLED"],
        ((502, None),),
        1,
        methods=("GET",),
    ),
    Anomaly(
        "conflicting-response-lengths",
        lambda _index: [b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\nok"],
        ((502, None),),
        1,
        methods=("GET",),
    ),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("tunnel", [False, True], ids=["plain", "tunnel"])
@pytest.mark.parametrize("anomaly", UPSTREAM_ANOMALIES, ids=[anomaly.id for anomaly in UPSTREAM_ANOMALIES])
async def test_upstream_anomaly(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    anomaly: Anomaly,
    tunnel: bool,
) -> None:
    """Upstream bytes outside a framed response never answer another request, and failures end the connection."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(anomaly.script, tls=tunnel)
    probe = await upstreams()
    client, target = await _client_for(broker, upstream, tunnel=tunnel)
    replies: list[Reply | None] = []
    try:
        for index, method in enumerate(anomaly.methods):
            client.send(target.render(f"{method} {{t}}/r{index} HTTP/1.1\r\nHost: {{h}}\r\n{{a}}\r\n"))
            replies.append(await client.reply(head=method == "HEAD"))
            # Let any late bytes from the upstream reach the broker before the next request.
            await upstream.wait_answered(index + 1)
            await asyncio.sleep(0.1)
        closes = anomaly.truncated or anomaly.replies[-1][0] >= 500
        closed = await client.closed() if closes else None
    finally:
        client.close()

    assert [reply.status if reply else None for reply in replies] == [status for status, _ in anomaly.replies]
    unreachable = {"error": "upstream_unreachable", "message": f"{target.host.partition(':')[0]} could not be reached."}
    for index, (reply, (_, body)) in enumerate(zip(replies, anomaly.replies, strict=True)):
        assert reply is not None
        assert reply.complete is not (anomaly.truncated and index == len(replies) - 1)
        if body is not None:
            assert reply.body == body
        if reply.status == 502:
            assert json.loads(reply.body) == unreachable
    assert closed is (True if closes else None)
    assert b"SMUGGLED" not in client.received
    assert [request.target for request in upstream.complete] == [
        f"/r{index}".encode() for index in range(anomaly.forwarded)
    ]
    _assert_contained(
        intercepted=upstream if tunnel else None,
        others=[probe] if tunnel else [upstream, probe],
        client_bytes=bytes(client.received),
        host=target.host,
    )
    await _assert_listener_serves(broker, probe)


# Expect: 100-continue and pipelining across hosts, which need more than one write or upstream.


@pytest.mark.asyncio
@pytest.mark.parametrize("tunnel", [False, True], ids=["plain", "tunnel"])
async def test_expect_continue_forwards_one_request_after_the_body(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    tunnel: bool,
) -> None:
    """A client waiting for 100 Continue gets it, then its body travels in the same single forwarded request."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(tls=tunnel)
    probe = await upstreams()
    client, target = await _client_for(broker, upstream, tunnel=tunnel)
    try:
        client.send(target.render(_POST + "Content-Length: 5\r\nExpect: 100-continue\r\n\r\n"))
        interim = await client.reply()
        client.send(b"hello")
        final = await client.reply()
    finally:
        client.close()

    assert interim is not None
    assert interim.status == 100
    assert final is not None
    assert (final.status, final.body) == (200, b"ok")
    [request] = upstream.complete
    assert request.body == b"hello"
    assert request.header(b"expect") == []
    _assert_contained(
        intercepted=upstream if tunnel else None,
        others=[probe] if tunnel else [upstream, probe],
        client_bytes=bytes(client.received),
        host=target.host,
    )
    await _assert_listener_serves(broker, probe)


@pytest.mark.asyncio
async def test_pipelined_plain_requests_reach_only_their_own_hosts(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
) -> None:
    """Pipelined plain requests to different upstreams each reach only the host their own URL names."""
    await broker(_config(), secrets={"svc": SECRET})
    first = await upstreams()
    second = await upstreams(lambda _index: [SECOND])
    client, _target = await _client_for(broker, first, tunnel=False)
    credential = proxy_authorization(broker.token())
    try:
        client.send(
            b"".join(
                (
                    f"GET http://127.0.0.1:{upstream.port}/{name} HTTP/1.1\r\nHost: 127.0.0.1:{upstream.port}\r\n"
                    f"Proxy-Authorization: {credential}\r\n\r\n"
                ).encode()
                for name, upstream in [("first", first), ("second", second)]
            ),
        )
        replies = [await client.reply(), await client.reply()]
    finally:
        client.close()

    assert [(reply.status, reply.body) for reply in replies if reply] == [(200, b"ok"), (200, b"second")]
    assert [(request.target, request.header(b"host")) for request in first.complete] == [
        (b"/first", [f"127.0.0.1:{first.port}".encode()]),
    ]
    assert [(request.target, request.header(b"host")) for request in second.complete] == [
        (b"/second", [f"127.0.0.1:{second.port}".encode()]),
    ]
    assert first.errors == second.errors == []
    assert SECRET.encode() not in first.raw + second.raw


# TLS edge cases inside the tunnel.


def _client_context(broker: BrokerFactory) -> ssl.SSLContext:
    """Return a context trusting the broker CA that, like a hostile worker, skips hostname checks."""
    context = ssl.create_default_context(cadata=broker.ca.cert_pem)
    context.check_hostname = False
    return context


@pytest.mark.asyncio
async def test_sni_differing_from_connect_host_is_refused(broker: BrokerFactory, upstreams: UpstreamFactory) -> None:
    """A client naming another host in SNI than in CONNECT gets no tunnel to send requests through, so no secret."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(tls=True)
    probe = await upstreams()
    client = await _connect(broker.latest.port)
    try:
        client.send(connect_request(f"localhost:{upstream.port}", authorization=proxy_authorization(broker.token())))
        assert (await read_raw_response(client.reader)).status == 200
        # The broker aborts with an unrecognized_name alert; the client may see the alert or just the reset after it.
        with capture_logs() as logs, pytest.raises((ssl.SSLError, ConnectionResetError)):
            await client.writer.start_tls(_client_context(broker), server_hostname="evil.example")
    finally:
        client.close()

    assert {"event": "egress_broker_client_tls_failed", "error_type": "SSLError", "log_level": "debug"} in logs
    assert broker.resolved == []
    assert upstream.raw == b""
    await _assert_listener_serves(broker, probe)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "server_hostname",
    ["localhost", "localhost.", None],
    ids=["sni", "sni-trailing-dot", "no-sni"],
)
async def test_sni_matching_or_absent_routes_by_connect_host(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    server_hostname: str | None,
) -> None:
    """A matching SNI (trailing dot or not) or none gets the CONNECT host's leaf; Host still has to match it."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(tls=True)
    probe = await upstreams()
    client = await _open_tunnel(broker, upstream.port, context=_client_context(broker), server_hostname=server_hostname)
    try:
        peer = client.writer.get_extra_info("ssl_object").getpeercert()
        client.send(f"GET /a HTTP/1.1\r\nHost: localhost:{upstream.port}\r\n\r\n".encode())
        served = await client.reply()
        client.send(f"GET /b HTTP/1.1\r\nHost: evil.example:{upstream.port}\r\n\r\n".encode())
        fronted = await client.reply()
    finally:
        client.close()

    assert ("DNS", "localhost") in peer["subjectAltName"]
    assert served is not None
    assert fronted is not None
    assert (served.status, fronted.status) == (200, 403)
    assert [request.target for request in upstream.complete] == [b"/a"]
    _assert_contained(
        intercepted=upstream,
        others=[probe],
        client_bytes=bytes(client.received),
        host=f"localhost:{upstream.port}",
    )
    await _assert_listener_serves(broker, probe)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("offered", "selected"),
    [(["h2"], None), (["h2", "http/1.1"], "http/1.1"), (["http/1.1"], "http/1.1")],
    ids=["h2-only", "h2-and-http11", "http11"],
)
async def test_alpn_selects_only_http11(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    offered: list[str],
    selected: str | None,
) -> None:
    """The broker only speaks HTTP/1.1: it selects it when offered, and an HTTP/2 preface is refused cleanly."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(tls=True)
    probe = await upstreams()
    context = ssl.create_default_context(cadata=broker.ca.cert_pem)
    context.set_alpn_protocols(offered)
    client = await _open_tunnel(broker, upstream.port, context=context)
    try:
        negotiated = client.writer.get_extra_info("ssl_object").selected_alpn_protocol()
        if selected is None:
            # An h2-only client that goes ahead anyway sends the HTTP/2 connection preface.
            client.send(b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n")
        else:
            client.send(f"GET /a HTTP/1.1\r\nHost: localhost:{upstream.port}\r\n\r\n".encode())
        reply = await client.reply()
        closed = await client.closed() if selected is None else None
    finally:
        client.close()

    assert negotiated == selected
    assert reply is not None
    if selected is None:
        assert (reply.status, closed) == (400, True)
        assert upstream.raw == b""
    else:
        assert reply.status == 200
        assert len(upstream.complete) == 1
    _assert_contained(
        intercepted=upstream,
        others=[probe],
        client_bytes=bytes(client.received),
        host=f"localhost:{upstream.port}",
    )
    await _assert_listener_serves(broker, probe)


def _context_for_other_name(upstream_ca: UpstreamCA, directory: Path) -> ssl.SSLContext:
    """Return a server context with a certificate the test CA issued for ``other.example`` only."""
    key = ec.generate_private_key(ec.SECP256R1())
    now = datetime.now(UTC)
    cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "other.example")]))
        .issuer_name(upstream_ca.cert.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - timedelta(hours=1))
        .not_valid_after(now + timedelta(days=1))
        .add_extension(x509.SubjectAlternativeName([x509.DNSName("other.example")]), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(upstream_ca.key.public_key()), critical=False)
        .sign(upstream_ca.key, hashes.SHA256())
    )
    path = directory / "other-example.pem"
    path.write_bytes(
        cert.public_bytes(serialization.Encoding.PEM)
        + key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.load_cert_chain(path)
    return context


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["untrusted-ca", "wrong-name", "plaintext"])
async def test_upstream_tls_failure_gets_502_without_fallback(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    upstream_ca: UpstreamCA,
    tmp_path: Path,
    failure: str,
) -> None:
    """An upstream the broker cannot verify gets a 502, and the broker never retries without TLS."""
    await broker(_config(), secrets={"svc": SECRET})
    probe = await upstreams()
    received: list[bytes] = []
    plaintext: asyncio.Server | None = None
    if failure == "plaintext":

        async def answer_in_plaintext(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            received.append(await reader.read(65536))
            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            writer.close()

        plaintext = await asyncio.start_server(answer_in_plaintext, "127.0.0.1", 0)
        port = plaintext.sockets[0].getsockname()[1]
        upstream = None
    else:
        context = (
            broker.ca.server_context("localhost")
            if failure == "untrusted-ca"
            else _context_for_other_name(upstream_ca, tmp_path)
        )
        upstream = await upstreams(ssl_context=context)
        port = upstream.port
    try:
        client = await _open_tunnel(broker, port)
        try:
            client.send(f"GET /a HTTP/1.1\r\nHost: localhost:{port}\r\n\r\n".encode())
            reply = await client.reply()
            closed = await client.closed()
        finally:
            client.close()
    finally:
        if plaintext is not None:
            plaintext.close()
            await plaintext.wait_closed()

    assert reply is not None
    assert reply.status == 502
    assert json.loads(reply.body) == {"error": "upstream_unreachable", "message": "localhost could not be reached."}
    assert closed is True
    if upstream is not None:
        # The handshake failed before the upstream read anything.
        assert upstream.raw == b""
    else:
        # Only TLS records reached the plaintext server: a ClientHello, never the request or the secret.
        assert received
        assert all(data.startswith(b"\x16\x03") for data in received)
        assert not [data for data in received if b"HTTP/1.1" in data or SECRET.encode() in data]
    assert SECRET.encode() not in client.received
    await _assert_listener_serves(broker, probe)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "after_head",
    ["Content-Length: 5\r\n\r\nhello", "\r\nGET /a HTTP/1.1\r\nHost: localhost\r\n\r\n"],
    ids=["connect-with-body", "request-pipelined-after-connect"],
)
async def test_connect_carrying_more_than_its_head_is_refused(
    broker: BrokerFactory,
    upstreams: UpstreamFactory,
    after_head: str,
) -> None:
    """A CONNECT to an intercepted host with a body, or plaintext bytes behind it, is refused before any TLS."""
    await broker(_config(), secrets={"svc": SECRET})
    upstream = await upstreams(tls=True)
    probe = await upstreams()
    client = await _connect(broker.latest.port)
    try:
        head = connect_request(f"localhost:{upstream.port}", authorization=proxy_authorization(broker.token()))
        client.send(head.removesuffix(b"\r\n") + after_head.encode())
        reply = await client.reply()
        closed = await client.closed()
    finally:
        client.close()

    assert reply is not None
    assert (reply.status, closed) == (400, True)
    assert upstream.raw == b""
    assert broker.resolved == []
    await _assert_listener_serves(broker, probe)
