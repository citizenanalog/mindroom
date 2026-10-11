# Audience-bound Matrix OpenID tokens

## Intent

Matrix OpenID tokens prove "this is @user:server" to anyone holding them.
MindRoom Chat hands them to the MindRoom backend the user chose (Connections portal, Computers).
On a public homeserver with many deployments, a backend operator could replay a user's token to another deployment and act as that user there (see mindroom-ai/mindroom#2775 comment).
Goal: a token Chat requests for one backend proves identity to that backend only, without breaking other OpenID users (Element Call, LiveKit, the hosted provisioning service, stock homeservers).
Bas approved: audience binding in the Tuwunel fork plus MindRoom and Chat, after shortening `openid_token_ttl` to 120 s (done in dotfiles `b21a822`).

## Protocol (`io.mindroom.openid_audience`)

- Request: `POST /_matrix/client/v3/user/{userId}/openid/request_token` with body `{"io.mindroom.audience": "<origin>"}`.
  The audience is a non-empty string of at most 255 characters without control characters; Tuwunel stores it with the token and otherwise answers exactly as today.
  An empty body `{}` issues an unbound token, as today.
- Verify: `GET /_matrix/federation/v1/openid/userinfo?access_token=<t>&io.mindroom.audience=<origin>`.

  | Token | Query audience | Result |
  |---|---|---|
  | bound to A | A | 200 `{sub}` |
  | bound to A | B | 401 |
  | bound to A | absent | 401 (no stripping) |
  | unbound | present | 401 (the verifier demands binding) |
  | unbound | absent | 200 (legacy: Element Call, LiveKit, provisioning) |

- Capability: `/_matrix/client/versions` lists `io.mindroom.openid_audience: true` in `unstable_features`.
- Storage: the `openidtoken_expiresatuserid` value becomes `expires_at (8 bytes BE ms) + user_id + 0xFF + audience`; `0xFF` never occurs in UTF-8, so old rows (no `0xFF`) parse as unbound.

## Components

1. **Tuwunel fork** (`mindroom-ai/mindroom-tuwunel`, base `main`): read `io.mindroom.audience` from `json_body` in `create_openid_token_route`; extend the users service (`create_openid_token(user, token, audience: Option<&str>)`, `find_from_openid_token(token, audience: Option<&str>)` applying the table); read the query audience in `get_openid_userinfo_route` with an `http::Uri` extractor (axum has no `Query` feature); advertise the flag in `versions.rs`; tests in `src/mindroom-tests`; `FORK_CHANGES.md` numbered feature entry plus a Compatibility Notes bullet.
2. **MindRoom** (`mindroom/matrix_openid.py`, PR #2775): `verify_matrix_openid(token, paths)`.
   It checks the homeserver's `/versions` (cached for 10 minutes with a 5 s timeout; a failed refresh keeps the last known answer, or counts as unbound when there is none) and, when the flag is present, sends `io.mindroom.audience=<audience>` to userinfo.
   The audience comes only from `MINDROOM_PUBLIC_URL`, normalized like a browser `URL.origin` (lowercase scheme and host, no path, default port dropped); it is never derived from the request, whose `Host` header a replaying backend controls.
   With binding active and no valid `MINDROOM_PUBLIC_URL`, Connections sign-in and Computers answer 503; without binding nothing changes and the docs say tokens are then not bound.
   Rollout: upgrade MindRoom backends before the homeserver starts binding.
3. **MindRoom Chat** (PR #442): one helper `requestAudienceOpenIdToken(mx, audience)` posting `{"io.mindroom.audience": audience}` through `mx.http.authedRequest`, used by the Connections card (audience = backend origin) and the Computers panel (audience = computer service origin).
   Stock homeservers ignore the field and return an unbound token, which the backend accepts only in legacy mode.

## Not in scope

- The Synapse fork (SaaS tenants each have their own homeserver).
- The hosted provisioning service and Element Call keep unbound tokens.

## Testing

- Tuwunel: every row of the table, the 0xFF encoding with an old-format row, invalid audiences rejected at request time, the `/versions` flag.
- MindRoom: verifier sends the audience only when the flag is present, rejects a 401 from userinfo, caches the capability, falls back when `/versions` fails; Connections and Computers pass their origins (fake homeserver in `tests/computer_helpers.py`).
- Chat: the helper posts the body to the right path; the card and the Computers panel pass the right audience.
- Live after the Tuwunel release is deployed: a token bound to `https://mindroom.lab.mindroom.chat` signs in there and is refused when replayed with another audience.
