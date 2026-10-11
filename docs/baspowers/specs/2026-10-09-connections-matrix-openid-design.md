# Connections portal: Matrix sign-in from MindRoom Chat

## Intent

Bas wants the Connections portal (`/connections`) on his own deployment, so people who talk to his agents (Paul, Marcella, and others) can connect their own OAuth accounts without dashboard access.
Today the portal only accepts trusted-upstream strict JWT auth, which needs an identity gateway in front of the whole API and disables API-key dashboard auth.
Success: a user signed in to MindRoom Chat clicks "Open Connections" and lands in the portal of the configured MindRoom backend, signed in as their Matrix user, with no extra login and no change to dashboard auth.

Said by Bas: use the upstream route (Matrix OpenID from MindRoom Chat), not a gateway.
Assumptions: the backend origin comes from Chat's existing Computers service setting; native (Capacitor) builds are out of scope for v1; the MCP Gateway section of the portal keeps needing trusted upstream when MCP accounts are SCIM-provisioned (those lookups need an email).

## Approaches considered

1. **`postMessage` handoff with an allowlist of Chat origins (chosen).**
   Chat opens the portal window, the portal asks its opener for a token, Chat answers with a fresh Matrix OpenID token addressed to the portal origin, and the portal exchanges it for a session cookie, reporting the message origin, which the backend checks against `MINDROOM_CONNECTIONS_ALLOWED_ORIGINS`.
   The token never enters a URL, history, or logs, and a page that is not an allowlisted Chat cannot sign the victim in as someone else.
2. URL fragment handoff (`/connections/#openid_token=...`).
   Smallest change, but it puts a reusable identity token in browser history, and anyone can send a victim a link that signs them in as the attacker (login CSRF), after which the victim may connect their Google account to the attacker's agent.
3. One-time code from a cross-origin `POST`, opened as `/connections/#code=...`.
   Keeps the token out of the URL, but an attacker can mint a code for their own account server-side, so login CSRF remains.

## Design

### Handoff protocol

1. Chat's click handler synchronously calls `window.open(<backend>/connections/, "mindroom-connections")` without `noopener` (it needs the window handle, and the portal needs `window.opener`).
2. The portal loads its public static shell and calls `GET /api/connections`.
   On 401 with a `window.opener`, it posts `{type: "mindroom:connections-ready"}` to the opener with target origin `"*"` (the message carries no secret) and waits up to 30 seconds.
3. Chat accepts a ready message only when `event.source` is the window it opened and `event.origin` is the backend origin.
   It then calls `getOpenIdToken()` and posts `{type: "mindroom:connections-openid", openid_token}` to that window with target origin set to the backend origin, so the browser drops the message if the window navigated elsewhere.
   Chat answers every ready message from that window (so a portal reload after expiry signs in again) and stops listening once the window closes.
4. The portal accepts the token only when `event.source === window.opener`, then sends a same-origin `POST /api/connections/session` with `{openid_token, client_origin: event.origin}` and reloads its data.

### Backend

- **`MINDROOM_CONNECTIONS_ALLOWED_ORIGINS`**: a JSON list of exact Chat origins, parsed with the same rules as `MINDROOM_COMPUTER_ALLOWED_ORIGINS` (HTTPS, loopback HTTP, `capacitor://localhost`, no paths or wildcards; one bad entry disables the list).
  The existing parser in `worker_computer/auth.py` becomes a shared helper taking the env name.
  The env is registered in `runtime_env_policy.py` next to the computers one.
- **Session store** (new focused module): opaque `secrets.token_urlsafe(32)` tokens, stored by SHA-256 digest, mapping to a Matrix user ID with a fixed 1 hour lifetime, at most 1024 sessions per runtime and 16 per user (oldest evicted), pruned on access, held on the app state like `computer_sessions`.
- **`POST /api/connections/session`**: 404 unless `MINDROOM_CONNECTIONS_AGENT` is set; requires the HTTPS public origin and a same-origin request (the existing connections check, moved to a shared helper); 403 when `client_origin` is not allowlisted; `verify_openid` against the configured homeserver (its errors keep their status, details are never echoed); creates a session and sets `__Host-mindroom_connections_session` (`Secure`, `HttpOnly`, `SameSite=Lax` so the OAuth popup callback carries it, `Path=/`, `Max-Age=3600`); responds `no-store` with `{matrix_user_id}`.
- **`GET /api/connections/session`**: returns `{matrix_user_id}` for a signed-in portal user (session or strict JWT) and 401 otherwise; the portal uses it as its sign-in probe and shows "Signed in as ..." so a user notices a wrong account.
- **Auth integration** (`api/auth.py`):
  - A session is honored only on portal paths: `/connections`, `/api/connections` and their sub-paths, and `/api/oauth/{provider}/{callback|success}`.
    Everywhere else the cookie is ignored, so it never grants dashboard or administrator access, even to an administrator.
  - The session identity is `{"user_id": mxid, "email": None, "matrix_user_id": mxid, "auth_source": "matrix_openid"}`.
  - `require_connections_user` accepts a valid session before falling back to strict JWT.
  - `authenticate_user` accepts a valid session on portal paths before trusted upstream, API key, or Supabase auth, still enforcing browser mutation origin, so the portal's nested OAuth connect, status, disconnect, callback, and success calls see the same identity.
  - `request_has_frontend_access` serves the `/connections` shell and assets without auth when the portal is enabled; every API route stays protected.
- **Requester identity**: `_dashboard_requester_id_for_request` treats `matrix_openid` like `trusted_upstream` (use the verified Matrix ID).
  Without this, a portal user would resolve to `MINDROOM_OWNER_USER_ID` and act on the owner's credentials.
  `dynamic_workflows._private_report_auth_principals` is not reachable from portal paths and stays unchanged.

### Portal frontend (`frontend/src/connections/`)

- New `matrixSignIn.ts` implementing step 2 and 4 with origin and source checks and a timeout.
- `Connections.tsx`: on the initial 401, try the opener sign-in; without an opener, show "Open Connections from MindRoom Chat to sign in."

### MindRoom Chat

- New `src/app/mindroom/connections/openConnections.ts` implementing steps 1 and 3 with injectable `window` and token getter.
- A "Connections" card in the General settings MindRoom section next to Computers, using `useComputerApiUrl()` as the backend origin; hidden on native builds; when no backend is configured it explains that Connections use the server set under Computers.
  If `window.open` returns `null`, the card shows that the browser blocked the window.
- Strings in every locale file, a `FORK_CHANGES.md` runbook entry.

## Error handling

- Verifier unavailable: 503; invalid token or subject: 401; disallowed client origin: 403; portal disabled: 404; non-HTTPS or cross-origin request: 403.
- An expired or unknown session is treated as no session (401 from API routes); the portal re-runs the opener handshake when its opener is still open.
- Popup blocked or no reply within 30 seconds: the portal shows the "Open Connections from MindRoom Chat" message.

## Testing

- Backend unit tests for the session store (expiry, per-user and global caps, digest lookup).
- Backend API tests following `tests/api/test_connections_api.py` and `tests/computer_helpers.py`: sign-in sets the cookie with the right attributes; rejects a disallowed origin, a cross-origin request, a non-HTTPS public origin, a disabled portal, and a bad token without echoing it; the session reads the catalog as the Matrix user; a two-user connect, callback, and disconnect flow stores credentials under each Matrix user, never the owner; the session is ignored on dashboard routes in API-key mode; the shell is served without auth.
- Portal vitest for `matrixSignIn.ts` (source and type checks, timeout, POST body).
- Chat vitest for `openConnections.ts` (ignores wrong source, origin, or type; posts with the exact target origin; popup blocked; repeated ready) and the card.
- Live check on the `mindroom` LXC with `MINDROOM_CONNECTIONS_AGENT=desktop` and the allowlist set to the hosted and lab Chat origins.

## Docs

- `docs/deployment/trusted-upstream-auth.md` Connections Portal section: add Matrix sign-in from MindRoom Chat and the allowlist env; keep strict JWT as the other way in.
- Update the statements that the portal requires strict JWT in `docs/deployment/mcp-gateway.md`, `docs/oauth-framework.md`, `docs/usage.md`, and `docs/architecture/security-posture.md` (trust model change).
- `docs/tools/worker-computer.md` mentions the shared origin rules.
