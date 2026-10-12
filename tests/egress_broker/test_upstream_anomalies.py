"""Upstream anomalies: extra bytes, early closes, and split heads never answer another request.

Each anomaly runs over a fresh upstream connection per request (plain) and a reused one (tunnel); see `raw_http`.
"""

from __future__ import annotations

import asyncio
import json
import socket
from dataclasses import dataclass
from typing import TYPE_CHECKING

import h11
import pytest

from mindroom.egress_broker._relay import Peer
from tests.egress_broker.conftest import single_rule_config
from tests.egress_broker.raw_http import (
    OK,
    SECOND,
    SECRET,
    STRAY_RESPONSE,
    Reply,
    assert_contained,
    assert_listener_serves,
    client_for,
)

if TYPE_CHECKING:
    from tests.egress_broker.conftest import BrokerFactory
    from tests.egress_broker.raw_http import Action, Script, UpstreamFactory


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
    # An upstream that closes an idle connection after a full response is redialed for the next request.
    Anomaly(
        "close-after-complete-response",
        _first_then_second(OK, "close"),
        ((200, b"ok"), (200, b"second")),
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
    await broker(single_rule_config(), secrets={"svc": SECRET})
    upstream = await upstreams(anomaly.script, tls=tunnel)
    probe = await upstreams()
    client, target = await client_for(broker, upstream, tunnel=tunnel)
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
    assert_contained(
        intercepted=upstream if tunnel else None,
        others=[] if tunnel else [upstream],
        client_bytes=bytes(client.received),
        host=target.host,
    )
    await assert_listener_serves(broker, probe)


@pytest.mark.asyncio
async def test_bytes_already_in_the_socket_count_as_sent_unprompted() -> None:
    """Stray bytes that reached the socket but not yet the stream are found before the upstream is reused."""
    ours, theirs = socket.socketpair()
    reader, writer = await asyncio.open_connection(sock=ours)
    try:
        upstream = Peer(h11.Connection(h11.CLIENT), reader, writer)
        assert await upstream.sent_unprompted() is False
        # Written synchronously, so the bytes sit in the socket until the loop next polls it.
        theirs.sendall(STRAY_RESPONSE)
        assert await upstream.sent_unprompted() is True
    finally:
        writer.transport.abort()
        theirs.close()
