# Connections Portal Matrix Sign-In Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement this plan task-by-task with the skill named in **Execution**. Steps use checkbox (`- [ ]`) syntax.

**Execution:** baspowers:subagent-driven-development — security-sensitive auth change across two repos where a fresh reviewer per task is worth the cost.

**Goal:** Let a MindRoom Chat user open the Connections portal of their MindRoom backend already signed in through a Matrix OpenID `postMessage` handoff, without touching dashboard auth.

**Architecture:** Chat opens the portal window and answers its `ready` message with a fresh OpenID token addressed to the portal origin; the portal exchanges it at `POST /api/connections/session`, which checks the reported Chat origin against `MINDROOM_CONNECTIONS_ALLOWED_ORIGINS`, verifies the token at the homeserver, and sets a portal-scoped session cookie that the auth layer honors only on portal and OAuth callback paths.

**Tech Stack:** Python 3 FastAPI, pytest, TestClient; React + Vite + vitest (backend `frontend/`); MindRoom Chat React/TypeScript + vitest + i18next.

**Spec:** `docs/baspowers/specs/2026-10-09-connections-matrix-openid-design.md`

**Repos:**
- Backend: `~/Work/dev/mindroom-worktrees/connections-openid`, branch `feat/connections-matrix-openid`, PR to `main`. Before tests: `uv sync --all-extras`, then `nix-shell shell.nix` for `uv run pytest ... -x -n 0 --no-cov`. Pre-commit: `uv run pre-commit run --all-files`.
- Chat: `~/Work/dev/mindroom-chat-worktrees/connections-openid`, branch `caveman/connections-openid-handoff`, PR to `dev`. Before tests: `npm ci`. Checks: `npm run lint`, `npm run typecheck`, `npm test`.

## Global Constraints

- Message types are exactly `mindroom:connections-ready` and `mindroom:connections-openid`; the token field is `openid_token` with the Matrix shape `{access_token, token_type: "Bearer", matrix_server_name, expires_in}`.
- Allowlist env: `MINDROOM_CONNECTIONS_ALLOWED_ORIGINS`, a JSON list, same parsing rules as `MINDROOM_COMPUTER_ALLOWED_ORIGINS`; a bad entry disables the whole list.
- Cookie: `__Host-mindroom_connections_session`, `Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=3600`.
- Session store: 1 hour fixed lifetime, at most 1024 sessions per runtime and 16 per user (oldest evicted), tokens from `secrets.token_urlsafe(32)` stored by SHA-256 digest.
- Session identity: `{"user_id": mxid, "email": None, "matrix_user_id": mxid, "auth_source": "matrix_openid"}`.
- A session is honored only on `/connections`, `/api/connections`, their sub-paths, and `/api/oauth/{provider}/callback` and `/api/oauth/{provider}/success`; never elsewhere, even for administrators.
- Portal waits at most 30 seconds for the opener's token.
- No AI attribution in commits; add files individually; follow-up commits, no force-push.
- Docs and FORK_CHANGES prose: one sentence per line, no em dashes.

## Review Focus

- A page that is not an allowlisted Chat opens the portal and answers `ready` with its own token: the backend must refuse because `client_origin` is not allowlisted (Task 3 test `test_sign_in_rejects_client_origin_not_allowlisted`).
- A session cookie sent to a dashboard route by an administrator in API-key mode: must be ignored, 401 without the API key (Task 4 test `test_session_ignored_on_dashboard_routes`).
- A portal user connecting OAuth on a deployment with `MINDROOM_OWNER_USER_ID` set: credentials must be stored under the portal user's Matrix ID, never the owner (Task 4 test `test_two_session_users_connect_under_their_own_ids_not_owner`).
- The Chat window receives `ready` from a window it did not open, or from the right window after it navigated to another origin: Chat must not post the token (Task 7 tests).
- A portal opened directly (no opener) or whose opener never answers: the user sees the "Open Connections from MindRoom Chat" message within 30 seconds, not a spinner forever (Task 5 test `shows open-from-chat message when the opener does not answer`).

---

## Backend (`mindroom`)

### Task 1: Shared Matrix OpenID module

**Files:**
- Create: `src/mindroom/matrix_openid.py`
- Modify: `src/mindroom/worker_computer/auth.py` (remove moved code), `src/mindroom/api/computers.py`, `src/mindroom/api/main.py` (computer CORS caller), `src/mindroom/runtime_env_policy.py` (add `CONNECTIONS_ALLOWED_ORIGINS_ENV = "MINDROOM_CONNECTIONS_ALLOWED_ORIGINS"`, exported and added to every frozenset that lists `COMPUTER_ALLOWED_ORIGINS_ENV`), `tach.toml` if a boundary check fails
- Test: `tests/test_matrix_openid.py`, existing `tests/api/test_computers.py` must pass unchanged

**Interfaces:**
- Produces:
  - `class MatrixOpenIDToken(BaseModel)`: moved unchanged from `worker_computer/auth.py`.
  - `class MatrixOpenIDError(Exception)` with attributes `status_code: int`, `detail: str`.
  - `async def verify_matrix_openid(token: MatrixOpenIDToken, paths: RuntimePaths) -> str`: the current `verify_openid` body, raising `MatrixOpenIDError` with the same statuses and details.
  - `def allowed_client_origins(paths: RuntimePaths, env_name: str) -> tuple[str, ...]`: the current `computer_origins` parser reading `env_name`.
- Computers code calls these directly (`allowed_client_origins(paths, COMPUTER_ALLOWED_ORIGINS_ENV)`) and maps `MatrixOpenIDError` to `ComputerError(error.status_code, error.detail)`; delete `computer_origins` and `verify_openid`.

- [ ] **Step 1: Write failing tests in `tests/test_matrix_openid.py`**
  - `test_allowed_client_origins_reads_named_env`: env `{"MINDROOM_CONNECTIONS_ALLOWED_ORIGINS": '["https://chat.example.org", "capacitor://localhost"]'}` returns `("https://chat.example.org", "capacitor://localhost")`, and `MINDROOM_COMPUTER_ALLOWED_ORIGINS` unset returns `()` for the computers env.
  - `test_allowed_client_origins_fails_closed`: `'["https://ok.example.org", "https://*.example.org"]'` returns `()`; `'"https://chat.example.org"'` (not a list) returns `()`.
  - `test_verify_matrix_openid_rejects_other_server`: token with `matrix_server_name="evil.org"` raises `MatrixOpenIDError` with `status_code == 401`.
  - `test_verify_matrix_openid_returns_subject`: reuse the fake homeserver from `tests/computer_helpers.py` (`ComputerPeer.openid`) and assert `"@alice:example.org"` for `access_token="openid-secret"`.
- [ ] **Step 2: Run** `uv run pytest tests/test_matrix_openid.py -x -n 0 --no-cov -v`. Expected: FAIL, `ModuleNotFoundError: mindroom.matrix_openid`.
- [ ] **Step 3: Implement the module, move the code, update callers and env policy.**
- [ ] **Step 4: Run** `uv run pytest tests/test_matrix_openid.py tests/api/test_computers.py -x -n 0 --no-cov`. Expected: PASS.
- [ ] **Step 5: Run** `uv run tach check --dependencies --interfaces`. Expected: no errors.
- [ ] **Step 6: Commit** `git add` each file; message `Share Matrix OpenID verification and client origin parsing`.

### Task 2: Connections session store

**Files:**
- Create: `src/mindroom/api/connections_sessions.py`
- Modify: `src/mindroom/api/config_lifecycle.py` (`_MindroomAppState.connections_sessions: ConnectionsSessionStore = field(default_factory=ConnectionsSessionStore)`)
- Test: `tests/api/test_connections_sessions.py`

**Interfaces:**
- Produces:
  - `CONNECTIONS_SESSION_COOKIE = "__Host-mindroom_connections_session"`, `CONNECTIONS_SESSION_SECONDS = 3600`.
  - `class ConnectionsSessionStore` with `__init__(self, *, max_sessions: int = 1024, max_per_user: int = 16, clock: Callable[[], float] = time.monotonic)`, `create(self, matrix_user_id: str) -> str`, `resolve(self, token: str) -> str | None`.

- [ ] **Step 1: Write failing tests**
  - `test_create_then_resolve_returns_user`: `resolve(create("@alice:example.org")) == "@alice:example.org"`; `resolve("unknown") is None`.
  - `test_session_expires_after_one_hour`: fake clock; at `+3599` resolves, at `+3600` returns `None`.
  - `test_per_user_cap_evicts_oldest`: 17 `create("@alice:example.org")`; the first token resolves to `None`, the 17th resolves.
  - `test_global_cap_evicts_oldest`: `max_sessions=2`, three users; the first token is `None`.
  - `test_tokens_are_not_stored_in_plaintext`: the token string does not appear in `repr(store.__dict__)`.
- [ ] **Step 2: Run** `uv run pytest tests/api/test_connections_sessions.py -x -n 0 --no-cov -v`. Expected: FAIL on import.
- [ ] **Step 3: Implement** with a dict from `hashlib.sha256(token.encode()).hexdigest()` to `(matrix_user_id, expires_at, created_order)`, pruning expired entries on `create` and `resolve`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `Add an in-memory Connections session store`.

### Task 3: `POST /api/connections/session`

**Files:**
- Create: `src/mindroom/api/connections_session.py` (router `APIRouter(prefix="/api/connections/session")`)
- Modify: `src/mindroom/api/connection_agents.py` (add `require_connections_same_origin(request: Request, runtime_paths: RuntimePaths) -> None`, moved from `connections.py::_require_same_origin` with the same messages), `src/mindroom/api/connections.py` (call it), `src/mindroom/api/main.py` (`app.include_router(connections_session_router)` before `connections_router`)
- Test: `tests/api/test_connections_signin.py`

**Interfaces:**
- Consumes: Task 1 `MatrixOpenIDToken`, `verify_matrix_openid`, `allowed_client_origins`, `CONNECTIONS_ALLOWED_ORIGINS_ENV`; Task 2 store, cookie constants; `config_lifecycle.app_state(request.app).connections_sessions`.
- Produces: `POST /api/connections/session` with body model `_SignIn(BaseModel, extra="forbid")`: `openid_token: MatrixOpenIDToken`, `client_origin: str`; 200 `{"matrix_user_id": str}`; response headers `CONNECTIONS_HEADERS`.

Order of checks: 404 `"Connections are not enabled"` when `MINDROOM_CONNECTIONS_AGENT` is blank; `require_connections_same_origin`; 403 `"Connections sign-in is not allowed from this client"` when `client_origin` is not in `allowed_client_origins(paths, CONNECTIONS_ALLOWED_ORIGINS_ENV)`; `verify_matrix_openid` with `MatrixOpenIDError` mapped to `HTTPException(error.status_code, error.detail)`; request validation errors become 401 `"Invalid sign-in request"` so the token is never echoed.

- [ ] **Step 1: Write failing tests.** Fixture `signin` mirrors `portal` in `tests/api/test_connections_api.py` but uses API-key mode (`MINDROOM_API_KEY=dashboard-key`, no trusted upstream env), `MINDROOM_OWNER_USER_ID=@owner:example.org`, `MINDROOM_CONNECTIONS_ALLOWED_ORIGINS='["https://chat.example.org"]'`, and monkeypatches `connections_session.verify_matrix_openid` with an `AsyncMock` returning `f"@{token.access_token}:example.org"` for tokens `alice` and `bob` and raising `MatrixOpenIDError(401, "Matrix OpenID verification failed.")` otherwise. Helper `sign_in(client, name, origin="https://chat.example.org")` posts with header `Origin: https://portal.example.org`.
  - `test_sign_in_sets_portal_session_cookie`: 200, body `{"matrix_user_id": "@alice:example.org"}`; the `set-cookie` header contains `__Host-mindroom_connections_session=`, `Secure`, `HttpOnly`, `SameSite=lax`, `Path=/`, `Max-Age=3600`; `cache-control` is `no-store`.
  - `test_sign_in_rejects_client_origin_not_allowlisted`: `origin="https://evil.example.org"` gives 403 and no `set-cookie`.
  - `test_sign_in_rejects_cross_origin_request`: header `Origin: https://evil.example.org` gives 403.
  - `test_sign_in_requires_https_public_origin`: `MINDROOM_PUBLIC_URL=http://portal.example.org` gives 403 `"Connections require an HTTPS public origin"`.
  - `test_sign_in_404_when_portal_disabled`: blank `MINDROOM_CONNECTIONS_AGENT` gives 404.
  - `test_sign_in_rejects_bad_token_without_echo`: token `access_token="not-a-user-secret"` gives 401 and `"not-a-user-secret"` is not in the response text; a body with an extra field gives 401 without echoing the token.
- [ ] **Step 2: Run** `uv run pytest tests/api/test_connections_signin.py -x -n 0 --no-cov -v`. Expected: FAIL, 404 or 405 on the route.
- [ ] **Step 3: Implement** the router, the shared same-origin helper, and the include.
- [ ] **Step 4: Run** the file plus `tests/api/test_connections_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `Exchange a Matrix OpenID token for a Connections session`.

### Task 4: Honor the session on portal paths only

**Files:**
- Modify: `src/mindroom/api/auth.py`, `src/mindroom/api/dashboard_credential_scope.py:54-64`, `src/mindroom/api/connections_session.py` (add `GET` route)
- Test: `tests/api/test_connections_signin.py` (same fixture), `tests/api/test_connections_auth.py` (update the static gating test that expects a gated shell)

**Interfaces:**
- Consumes: Task 2 store and cookie, Task 3 fixture.
- Produces:
  - `def connections_session_auth_user(request: Request) -> dict[str, Any] | None` in `auth.py`: returns the session identity (Global Constraints) only when the portal is enabled, the path is portal-scoped (extend `_is_connections_path` usage with a helper `_is_connections_session_path(path: str) -> bool` that also matches `/api/oauth/{provider}/callback|success`), and the cookie resolves.
  - `require_connections_user` returns it before the strict-JWT path.
  - `authenticate_user` checks it first; on success calls `_require_browser_mutation_origin(request, auth_state.settings)`, stores `scope["auth_user"]`, returns.
  - `request_has_frontend_access` returns `True` for connections paths when the portal is enabled, without auth.
  - `_dashboard_requester_id_for_request` uses `matrix_user_id` when `auth_source in {"trusted_upstream", "matrix_openid"}`.
  - `GET /api/connections/session`: 404 when disabled, otherwise `require_connections_user` and 200 `{"matrix_user_id": ...}`, `CONNECTIONS_HEADERS`.

- [ ] **Step 1: Write failing tests**
  - `test_session_reads_catalog_as_matrix_user`: after `sign_in(alice)`, `GET /api/connections` is 200 and `GET /api/connections/session` returns `{"matrix_user_id": "@alice:example.org"}`; without signing in both are 401.
  - `test_two_session_users_connect_under_their_own_ids_not_owner`: port `test_two_users_complete_and_disconnect_only_their_own_credentials` to two TestClients (one cookie jar each) signed in as alice and bob; assert `_stored_oauth_credentials(..., requester_id="@alice:example.org")` is not `None` and `requester_id="@owner:example.org"` is `None`.
  - `test_session_ignored_on_dashboard_routes`: signed in as alice, `GET /api/config/agents` is 401; with `Authorization: Bearer dashboard-key` it is 200.
  - `test_session_cookie_ignored_for_admin_on_dashboard_routes`: config lists `@alice:example.org` in `administrators`; signed in as alice, `GET /api/config/agents` is still 401.
  - `test_expired_session_is_rejected`: freeze the store clock via `config_lifecycle.app_state(main.app).connections_sessions` replaced with a store whose clock you advance 3600 seconds; `GET /api/connections` is 401.
  - `test_connections_shell_served_without_auth`: with a built `dist/connections/index.html` fixture (copy the approach of the existing static gating test), `GET /connections/` is 200 HTML without credentials; with `MINDROOM_CONNECTIONS_AGENT` blank it is 404.
  - `test_session_mutations_require_same_origin`: signed in as alice, `POST .../connect` with `Origin: https://evil.example.org` is 403.
- [ ] **Step 2: Run** `uv run pytest tests/api/test_connections_signin.py -x -n 0 --no-cov -v`. Expected: the new tests FAIL with 401 or 403.
- [ ] **Step 3: Implement** the auth changes, the requester identity change, and the `GET` route.
- [ ] **Step 4: Run** `uv run pytest tests/api -x -n 0 --no-cov`. Expected: PASS (update only the static gating assertion in `test_connections_auth.py`, which now expects the public shell).
- [ ] **Step 5: Commit** `Honor Connections sessions on portal and OAuth callback paths`.

### Task 5: Portal sign-in gate

**Files:**
- Create: `frontend/src/connections/matrixSignIn.ts`, `frontend/src/connections/ConnectionsSignIn.tsx`, `frontend/src/connections/matrixSignIn.test.ts`, `frontend/src/connections/ConnectionsSignIn.test.tsx`
- Modify: `frontend/src/connections/main.tsx` (render `<ConnectionsSignIn><Connections /></ConnectionsSignIn>`)

**Interfaces:**
- Consumes: Task 3 `POST /api/connections/session`, Task 4 `GET /api/connections/session`.
- Produces:
  - `export async function requestOpenIdFromOpener(win: Window = window, timeoutMs = 30000): Promise<{ openidToken: unknown; origin: string } | null>`: returns `null` when `win.opener` is missing or on timeout; posts `{ type: "mindroom:connections-ready" }` to `win.opener` with `"*"`; accepts only `event.source === win.opener` and `event.data?.type === "mindroom:connections-openid"` with an object `openid_token`.
  - `export async function signInWithMatrix(win: Window = window): Promise<boolean>`: calls it, then `fetch("/api/connections/session", {method: "POST", credentials: "same-origin", headers: {"Content-Type": "application/json"}, body: JSON.stringify({openid_token, client_origin: origin})})`, true on 2xx.
  - `ConnectionsSignIn`: probes `GET /api/connections/session`; 200 renders children with a muted line `Signed in as {matrix_user_id}`; 401 runs `signInWithMatrix` once and re-probes; otherwise shows exactly `Open Connections from MindRoom Chat to sign in.`

- [ ] **Step 1: Write failing vitest tests**
  - `matrixSignIn.test.ts`: `ignores messages from other sources`; `ignores messages with another type`; `returns token and origin from the opener`; `returns null without an opener`; `returns null after the timeout` (fake timers, 30000 ms); `posts token and client origin to the session endpoint` (assert fetch body `{"openid_token": {...}, "client_origin": "https://chat.example.org"}`).
  - `ConnectionsSignIn.test.tsx`: `renders children and the signed-in user when the session exists`; `signs in through the opener after a 401 then renders children`; `shows open-from-chat message when the opener does not answer`.
- [ ] **Step 2: Run** `cd frontend && bun run test -- src/connections` (or the repo's vitest command from `frontend/package.json`). Expected: FAIL on missing modules.
- [ ] **Step 3: Implement** the module, the gate, and the `main.tsx` change.
- [ ] **Step 4: Run** the same command plus the frontend typecheck and lint scripts from `frontend/package.json`. Expected: PASS.
- [ ] **Step 5: Commit** `Sign in to the Connections portal through MindRoom Chat`.

### Task 6: Docs and full verification

**Files:**
- Modify: `docs/deployment/trusted-upstream-auth.md` (Connections Portal: two ways in, the allowlist env, the session scope and cookie, the MCP SCIM limitation; update the matching troubleshooting rows), `docs/deployment/mcp-gateway.md`, `docs/oauth-framework.md`, `docs/usage.md`, `docs/architecture/security-posture.md`, `docs/tools/worker-computer.md` (origin rules shared with Connections), regenerated `skills/mindroom-docs/references/*` from pre-commit

- [ ] **Step 1: Edit the docs** so no page still says the portal requires strict JWT only.
- [ ] **Step 2: Run** `uv run pre-commit run --all-files`. Expected: all hooks pass (rerun once if a regeneration hook rewrote files, then `git add` them).
- [ ] **Step 3: Run** `just test-backend` inside `nix-shell shell.nix`. Expected: PASS.
- [ ] **Step 4: Commit** `Document Matrix sign-in for the Connections portal`.

## MindRoom Chat (`mindroom-chat`)

### Task 7: Portal handoff helper

**Files:**
- Create: `src/app/mindroom/connections/openConnections.ts`, `src/app/mindroom/connections/openConnections.test.ts`

**Interfaces:**
- Produces: `export function openConnectionsPortal(options: { backendUrl: string; getOpenIdToken: () => Promise<IOpenIDToken>; win?: Window; pollMs?: number }): 'opened' | 'blocked'`.
  It opens `new URL('/connections/', backendUrl).toString()` with target `mindroom-connections` and no features string, returns `'blocked'` when `window.open` returns `null`, listens for `message` events, answers each `{type: 'mindroom:connections-ready'}` whose `event.source` is the opened window and whose `event.origin` equals the backend origin by posting `{type: 'mindroom:connections-openid', openid_token}` to that window with the backend origin as target origin, and removes the listener once the window is closed (checked every `pollMs`, default 1000).

- [ ] **Step 1: Write failing tests**: `returns blocked when the browser blocks the window`; `opens the portal path on the backend origin`; `posts a fresh token to the opened window with the backend origin`; `ignores ready from another window`; `ignores ready from another origin`; `ignores other message types`; `answers each ready message with a new token`; `stops listening after the window closes`.
- [ ] **Step 2: Run** `npx vitest run src/app/mindroom/connections`. Expected: FAIL on missing module.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(connections): hand a Matrix OpenID token to the Connections portal`.

### Task 8: Connections settings card

**Files:**
- Create: `src/app/mindroom/settings/MindroomConnectionsSettings.tsx`, `src/app/mindroom/settings/MindroomConnectionsSettings.test.tsx`
- Modify: `src/app/mindroom/settings/settingsExtensions.tsx` (render after `MindroomComputerSettings`), all 17 `src/app/locales/*.json`, `FORK_CHANGES.md` (new dated Runbook entry at the top)

**Interfaces:**
- Consumes: Task 7 `openConnectionsPortal`; `useComputerApiUrl()`; `useMatrixClient().getOpenIdToken`; `Capacitor.isNativePlatform()`.
- Produces: keys `settings.general.connections.{sectionTitle, title, description, open, noBackend, blocked}` with English copy: `Connections`; `Connected accounts`; `Connect the accounts your agents use, such as Google or GitHub, on your MindRoom server.`; `Open Connections`; `Set your MindRoom server under Computers to use Connections.`; `Your browser blocked the Connections window. Allow pop-ups for this site and try again.`

- [ ] **Step 1: Write failing tests**: `renders nothing on native builds`; `explains how to set a server when none is configured` (button disabled, `noBackend` text); `opens the portal with the computers backend` (mock `openConnectionsPortal`, assert `backendUrl`); `shows the blocked message when the window is blocked`.
- [ ] **Step 2: Run** `npx vitest run src/app/mindroom/settings/MindroomConnectionsSettings.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** the card with `SequenceCard` and `SettingTile` like `MindroomComputerSettings`, add translated strings to all locales, and the FORK_CHANGES entry.
- [ ] **Step 4: Run** `npm run lint && npm run typecheck && npm test`. Expected: PASS (`src/app/i18n.test.ts` confirms every locale has the keys).
- [ ] **Step 5: Commit** `feat(connections): open the Connections portal from settings`.

## After the tasks

- Open both PRs (ready for review, not draft), link them to each other and to the thread, and run the review loop.
- Live check on the `mindroom` LXC: squash the backend PR on top of the local `main`, set `MINDROOM_CONNECTIONS_AGENT=desktop` and `MINDROOM_CONNECTIONS_ALLOWED_ORIGINS='["https://chat.mindroom.chat","https://chat.lab.mindroom.chat"]'` in `~/.mindroom-chat/.env`, rebuild `mindroom:dev`, restart, and run the lab Chat on the Chat PR branch.
