---
icon: lucide/shield-check
---

# Agent Keys

**Agent Keys** let your agents use API keys and logins without ever seeing them.
The **egress broker** that does this runs inside the primary runtime and intercepts outbound HTTP(S) requests from worker code, injecting secrets the worker never sees; it is configured under `egress_broker`.
Use it when workers need to call APIs with credentials (GitHub, Google, Atlassian, OpenAI, cloud providers) while keeping those secrets out of worker code, environment variables, and container memory.
Each service gets its credential from an API key you store or from an account you connect with a few clicks, and built-in presets define the common services in one line.
Users can also add services of their own, limit GitHub access to chosen repositories in place, and see their own recent requests on a personal page, without dashboard access.
This page covers how the broker works, how it handles requests, configuration and presets, secret sources and connected accounts, user services, per-repo control, the Connections pages, the personal request log, deployment, secret management, error codes, what the broker cannot protect against, migration from Agent Vault, and current limitations.
Why the broker is built this way is in [Egress Broker Design](../architecture/egress-broker-design.md).

## How it works

When a worker makes an HTTP(S) request through the broker, the broker matches the destination host against configured services.
If the request matches a service rule, the broker terminates TLS with its own certificate, injects the configured secret into the request as a header or query parameter, forwards the request to the upstream server, and returns the response to the worker.
Unmatched hosts are either tunneled through (passthrough mode) or blocked (deny mode), controlled by `egress_broker.unmatched_hosts` in `config.yaml`.

Workers receive a signed token in their environment (`HTTP_PROXY`, `HTTPS_PROXY`) that authenticates them to the broker; it is valid for `MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS` (default 7 days).
The token is the user name in the proxy URL, `http://<token>:mindroom@<broker host>:<port>`, and the password is the fixed text `mindroom`.
The broker reads only the user name and ignores the password, which is not a secret.
The password is there because Python `urllib` and Node `fetch` (with `NODE_USE_ENV_PROXY`) send `Proxy-Authorization` only when both the user name and the password are non-empty, so with an empty password they sent nothing and got 407.
With it, curl, Python `urllib`, and Node `fetch` all authenticate.
The broker validates the token, resolves the worker's scope (user, user-agent, shared, or global for agents without a worker scope), and loads the service secret from that scope's primary-only credential store, or a fresh access token from the account connected for that scope (see [Secret sources](#secret-sources)).
The secret never reaches the worker process, its environment, or the filesystem it can read.

Each worker call gets a fresh token valid for the configured TTL (default 7 days), so long-running commands keep working while a leaked token expires on its own.
The TTL applies to new requests: an expired token gets 407 on every new request, but websocket splices and raw tunnels that were already open continue until they close.

### Request handling

The broker parses every client request itself (with `h11`) and forwards exactly one well-framed request per parsed request, rebuilt from what it parsed rather than copied from the client's bytes. Websocket frames after a 101 and raw tunnels to hosts without rules are the exceptions: they are relayed as they come.
These rules stop a request that two parsers would read differently from reaching an upstream as two requests, a secret from going to the wrong host, and an upstream from echoing a secret back:

- **Head limit.** A request head (request line through the blank line) over 64 KiB gets 431 with `bad_request`, however the head is split across reads. A head that never completes is refused at the same size, and an unauthenticated client that never finishes one is dropped after 30 seconds.
- **Conflicting lengths.** A request with both `Content-Length` and `Transfer-Encoding` is framed by `Transfer-Encoding` and forwarded chunked, without `Content-Length`. Its connection then closes after the response (RFC 9112 section 6.1), so bytes that a parser trusting the length would read as a further request are never read. Inside an intercepted tunnel, such a request that asks for a websocket upgrade is refused with 400 `bad_request` before anything is forwarded, so it never becomes a splice. Other malformed or conflicting lengths (conflicting repeated, signed, or hexadecimal `Content-Length`, an unknown transfer coding) are refused with 400, 413, or 501; repeated equal lengths are forwarded as one.
- **Echo methods.** `TRACE` and `TRACK` ask a server to send the request back as the response body, which would hand the injected credential to the agent. On a host with rules, either method (in any letter case) is refused with 405 `method_not_allowed`, before any key is looked up and before anything is dialed. Other methods, and every method on a host without rules, are forwarded as before.
- **Framing headers.** The request's framing is rebuilt from what `h11` read, so a `Connection` header that names `Content-Length` or `Transfer-Encoding` cannot remove it.
- **Reused upstream.** An intercepted tunnel reuses one upstream connection for its requests. Before each reuse the broker checks that the upstream has sent nothing since its last response, and drops and redials a connection that sent stray bytes (a second response, a body on a `HEAD` or 204 answer, late bytes) or closed, so one request never reads another's response. The plain path dials a fresh upstream for every request.
- **Streamed bodies.** The broker streams request bodies: it forwards a valid head before it has read the body. A body that later turns out to be invalid (a bad chunk) or over the limit gets 400 or 413, and the upstream connection is aborted, so the upstream can see one partial request and a reset. That partial head went to the host the tunnel was opened for and carries the injected secret exactly once, like any other request to it. Buffering every body first would cost memory and latency, so the broker does not.
- **TLS name.** A client whose TLS server name (SNI) differs from the CONNECT host gets its handshake aborted with an `unrecognized_name` alert, and no request is read. Case and a trailing dot are ignored. A client that sends no SNI, as for an IP address, is served.
- **Paths.** A path is matched against the rules only after the ambiguity checks under [Limiting paths and repositories](#limiting-paths-and-repositories).

## Configuration

### Environment variables

Set these on the primary runtime to enable the broker:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MINDROOM_EGRESS_BROKER_PORT` | Yes (when using the broker) | Unset (broker disabled) | Port the broker listens on, such as 8768; when unset the broker stays off |
| `MINDROOM_EGRESS_BROKER_HOST` | No | `0.0.0.0` | Bind address for the broker listener |
| `MINDROOM_EGRESS_BROKER_URL` | Yes (when port is set) | None | Worker-facing first hop, such as `http://host.docker.internal:8768` for Docker workers or `http://squid:3128` in an approved-egress chain |
| `MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS` | No | `604800` (7 days) | How long each minted worker token remains valid |

When `MINDROOM_EGRESS_BROKER_PORT` is unset, the broker does not start and workers get no broker environment.
Agent Keys then stays hidden: every Agent Keys API route and the `/connections/egress` page answer 404, the dashboard's Credentials page has no Agent Keys panel, the Connections portal has no Agent Keys link and no "API keys and accounts" section, and the `egress_credentials` tool is left out of the tool lists and not given to agents that list it.
Keys and accounts can only be entered while the port is set.
With the port set, the request log and CA download routes return 409 while the broker is not running.

Running MindRoom with `--no-api` disables the broker along with the API.

### Service rules

Add `egress_broker` to `config.yaml` with the services workers may reach.
Most services need only a preset; define a custom service when no preset fits.

#### Presets

A preset is a built-in service definition.
Name it with `preset` and the service is complete:

```yaml
egress_broker:
  unmatched_hosts: passthrough  # or deny
  services:
    github:
      preset: github
    gmail:
      preset: google_gmail
    openai:
      preset: openai
```

A preset fills `display_name`, `description`, `rules`, `placeholder_env`, and `oauth_provider`.
The service name is yours to choose; it names the stored `egress_<name>` credential and the dashboard row.

| Preset | Connected account (`oauth_provider`) | Rules | Placeholder env |
|--------|--------------------------------------|-------|-----------------|
| `github` | `github` | `api.github.com` bearer; `uploads.github.com` bearer; `github.com` basic with username `x-access-token` | `GH_TOKEN`, `GITHUB_TOKEN` |
| `google_drive` | `google_drive` | `www.googleapis.com` paths `/drive/` and `/upload/drive/`, bearer | None |
| `google_gmail` | `google_gmail` | `gmail.googleapis.com` bearer; `www.googleapis.com` path `/gmail/`, bearer | None |
| `google_calendar` | `google_calendar` | `www.googleapis.com` path `/calendar/`, bearer | None |
| `google_sheets` | `google_sheets` | `sheets.googleapis.com` bearer | None |
| `google_docs` | `google_docs` | `docs.googleapis.com` bearer | None |
| `google_tasks` | `google_tasks` | `tasks.googleapis.com` bearer; `www.googleapis.com` path `/tasks/`, bearer | None |
| `atlassian` | `atlassian` | `api.atlassian.com` bearer | None |
| `openai` | None | `api.openai.com` bearer | `OPENAI_API_KEY` |
| `anthropic` | None | `api.anthropic.com` header `x-api-key` | `ANTHROPIC_API_KEY` |

Placeholder values are `mindroom-brokered`.
Presets without a connected account take an API key only.

Several Google presets share `www.googleapis.com`.
Longest path prefix matching picks the right service, and a request to another path on that host is forwarded without injection, because the host has rules and so does not count as unmatched.

Any field you set next to `preset` replaces the preset's value for that field, as a whole:

```yaml
egress_broker:
  services:
    github:
      preset: github
      display_name: Work GitHub
      placeholder_env: {}  # replaces the preset's GH_TOKEN and GITHUB_TOKEN
```

Fields you leave out keep coming from the preset, so MindRoom updates to a preset reach your service.
`rules` and `placeholder_env` are not merged with the preset's lists, so an authored `rules` list replaces all of its rules.
Saving the config from the dashboard keeps the preset form you wrote and does not write the expanded values back.
An unknown preset name is rejected when the config loads, and the error lists the known presets.
A service must end up with at least one rule, from `rules` or from its preset.

#### Custom services

Define the rules yourself when no preset fits:

```yaml
egress_broker:
  services:
    github:
      display_name: GitHub
      description: GitHub API, gh CLI, and git over HTTPS
      oauth_provider: github  # optional: lets users connect an account instead of storing a key
      rules:
        - host: api.github.com
          auth: { type: bearer }
        - host: uploads.github.com
          auth: { type: bearer }
        - host: github.com
          auth: { type: basic, username: x-access-token }
      placeholder_env:
        GH_TOKEN: mindroom-brokered
        GITHUB_TOKEN: mindroom-brokered
    openai:
      display_name: OpenAI
      description: OpenAI API
      rules:
        - host: api.openai.com
          auth: { type: header, name: Authorization, template: "Bearer {secret}" }
      placeholder_env:
        OPENAI_API_KEY: mindroom-brokered
```

**Service fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `preset` | No | Built-in preset that supplies the fields below; see [Presets](#presets) |
| `display_name` | No | Name shown in the UI and the agent tool; defaults to the service name |
| `description` | No | Short description shown in the UI |
| `rules` | Yes, unless a preset supplies them | Routing rules for the service. Every rule needs `auth`, unless the service sets `restrict_only` |
| `placeholder_env` | No | Placeholder environment variables for workers |
| `oauth_provider` | No | MindRoom OAuth provider id (such as `github`, `google_drive`, `atlassian`) whose connected account supplies the secret when no API key is stored; see [Secret sources](#secret-sources) |
| `oauth_on_shared_workers` | No | Default `false`. Set `true` to use a requester's own GitHub or Atlassian account in shared sandboxes too (`shared` and unscoped agents, and every agent on the static runner), which lets every user of such a sandbox act with other users' connected accounts; see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes). Presets never set it |
| `restrict_to_rules` | No | Default `false`. Set `true` to refuse a request with 403 `path_not_allowed` when its path matches no rule of the same party's services on that host (the administrator's services for a config service, the requester's own for a user service), instead of forwarding it without credentials. A user service that sets it also limits the administrator's services on its hosts, for the scope that holds it; see [Limiting paths and repositories](#limiting-paths-and-repositories). Presets never set it |
| `restrict_only` | No | Only for [user services](#user-services): a service in `config.yaml` that sets it to `true` is rejected ("restrict_only is only for services users add; use restrict_to_rules in config"). Default `false`, and it must be a real boolean (the string `"true"` is rejected). Set `true` for a service that only limits paths: its rules take part in the path check like `restrict_to_rules` (which it implies, so both may be set), but it never chooses a credential. It has no key, account login, or placeholders: it may not set `oauth_provider`, `placeholder_env`, or `oauth_on_shared_workers`, its rules need no `auth` (one is accepted and ignored), and with a `preset` it takes only the preset's `display_name`, `description`, and `rules`. See [Limiting in place](#limiting-in-place). Presets never set it |

**Rule fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `host` | Yes | Host to match; exact, IP address, or one-level wildcard such as `*.example.com` |
| `port` | No | Port to match, 1 to 65535; omit to match any port |
| `path_prefix` | No | Path prefix to match by whole segments; defaults to `/`; selects a rule but is not an access boundary (see [Limiting paths and repositories](#limiting-paths-and-repositories)) |
| `auth` | Yes, unless the service sets `restrict_only` | Authentication configuration for this rule |

**Auth types:**

| Type | Injects |
|------|---------|
| `bearer` | `Authorization: Bearer <secret>` |
| `basic` | `Authorization: Basic <base64(username:secret)>`; requires `username` field |
| `header` | Custom header; requires `name` and `template` fields; `name` must be a valid HTTP header name other than `Host`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `Proxy-Authorization`, `Proxy-Connection`, or `Keep-Alive`; template must contain `{secret}` exactly once |
| `query` | Query parameter `<name>=<secret>`; requires a non-empty `name`; replaces any client value |

Matching follows this order: exact host over wildcard, specific port over none, longest path prefix, then the service whose name sorts first, so the order services are written in never matters.

Service names use up to 63 lowercase letters, digits, `_`, and `-`, start with a letter or digit, and must not end in `_oauth` or `_oauth_client`, because the stored `egress_<name>` credential would then read as an OAuth service.

**Choosing auth safely:**

- Prefer `bearer`, `basic`, or `header` auth. The broker returns upstream responses to the worker, so any response that echoes the request can reveal the secret to worker code.
- `query` auth puts the secret in the URL. A redirect `Location` header, an error page, or a log line that echoes the URL can hand it back to the worker; use it only for APIs that accept nothing else.
- `header` and `bearer` secrets are exposed the same way by upstream debug endpoints that echo request headers (such as `httpbin.org/headers`), so do not add rules for hosts that offer them.
- `path_prefix` chooses which rule and secret apply; it does not limit what the secret can reach. See [Limiting paths and repositories](#limiting-paths-and-repositories) to refuse other paths.

**Placeholder environment:**

Services with `placeholder_env` set inject those variables into worker environments when a secret is available for that service in the worker's scope, either a stored API key or a connected account.
Use this so CLIs that refuse to run without a token (such as `gh`) work without modification.
The value can be any placeholder string; `mindroom-brokered` is the conventional choice.

#### Limiting paths and repositories

**Segment matching.** A `path_prefix` ending in `/` matches every path under it, so `/` matches everything.
A prefix without a trailing slash matches the exact path or that path followed by `/`: `/repos/o/r` matches `/repos/o/r` and `/repos/o/r/pulls` but never `/repos/o/r-old`.
Matching is case-sensitive, so `/repos/Alice/Repo` does not match a rule for `/repos/alice/repo`.
That fails safe, because the request then gets no credential (or a 403 under `restrict_to_rules`), so write names as they appear in URLs.

**Ambiguous paths.** On a host with rules, a path gets 400 `bad_request` instead of being matched when it has empty segments (`//`) or raw backslashes, or when it or any percent-decoded form of it (up to four rounds) has a dot segment (`/../`, `%2e%2e`, `%252e%252e`, also `..;x`, `..%3f`, and whitespace-padded forms), a NUL, or invalid UTF-8; so does a path still changing after four rounds of decoding.
Every layer is also checked after Unicode NFKC folding, because a server that applies it reads the two dot leader (U+2025) or two fullwidth full stops (U+FF0E) as `..`, so `/private/‥` or `/private/%EF%BC%8E%EF%BC%8E/x` is refused, and so is a fullwidth percent sign (U+FF05) before hex.
A fullwidth percent sign that folds into an escape that is not valid UTF-8 is refused too, which fails safe.
The folding only adds refusals: every path refused without it is still refused.
Legitimate non-ASCII paths such as `/wiki/Café` or `%C3%A9` stay allowed.
Encoded slashes such as `group%2Fproject` are allowed.
The broker refuses these paths instead of normalizing them, because servers disagree on how to normalize, so a raw-path trick cannot select a different rule.
Hosts without rules are not checked.

**Refusing unlisted paths.** By default a path that no rule matches is forwarded without credentials, and the upstream's own permissions decide what the secret can reach.
With `restrict_to_rules: true` on a service (or `restrict_only: true`, which implies it), a request to a host and port that one of its rules names must pass that restriction, or it is refused with 403 `path_not_allowed`.
Two parties can restrict a host, and a path must pass every party's restriction:

- **The administrator.** When a service in `config.yaml` that has a rule for the host and port sets `restrict_to_rules`, the path must match a rule of a config service on that host and port.
- **The requester.** When one of the requester's own [user services](#user-services) that has a rule for the host and port sets `restrict_to_rules`, the path must match a rule of one of their user services on that host and port.

A rule bound to another port never restricts this one.
A path that passes both checks picks its credential by the most specific rule over the config and user services, in the matching order given above (exact host, specific port, longest path prefix, then config services before user services, then service name), and a path that matches no rule is forwarded without credentials.
Rules of `restrict_only` services take part in the checks but are never considered for the credential (see [Limiting in place](#limiting-in-place)).
The 403 body names the restricting service in `service` (the restricting service whose name sorts first, of the party whose check failed) and the place to change it in `manage_url`, and its message names that service by its display name and says who can change it; see [Error responses](#error-responses).

What follows from this:

- **A user's restriction also limits the administrator's services on that host.** With the administrator's `github` service open on all of `api.github.com`, a user service that lists one repository and sets `restrict_to_rules` makes every other `api.github.com` path refuse for the scope that holds that service. The scope is the one that holds the service (see [User services](#user-services)): one agent for `user_agent`, all of the user's `user` agents for `user` (they share one store), everyone who uses the agent for a shared one, and every agent without a scope for an unscoped one (they share the global store). The personal page's editor says so with the sentence that matches the scope: "This also limits services from your administrator on these hosts, for this agent only." (`user_agent`), "... for all your agents that share your personal workspace." (`user`), "... for everyone using this agent." (shared), or "... for every agent without a scope." (unscoped). The dashboard editor leaves the sentence out. Other requesters, and hosts the user service has no rule for, follow the administrator's services as before.
- **A user's restriction cannot open a path the administrator refuses.** The administrator's check runs on its own, so a user service with a `/` rule on a host where a config service restricts still gets `path_not_allowed` for every path the config rules do not list.
- **On a shared or unscoped agent only managers can narrow.** Administrators and the agent's `credential_managers` write its user services, so only they can add a restriction, and it then applies to everyone who uses the agent.

An administrator's service restricted to one repository, in `config.yaml`:

```yaml
egress_broker:
  services:
    agent_cli:
      display_name: GitHub (agent-cli only)
      restrict_to_rules: true
      rules:
        - host: api.github.com
          path_prefix: /repos/basnijholt/agent-cli
          auth: { type: bearer }
        - host: github.com
          path_prefix: /basnijholt/agent-cli
          auth: { type: basic, username: x-access-token }
        - host: github.com
          path_prefix: /basnijholt/agent-cli.git
          auth: { type: basic, username: x-access-token }
```

GitHub's GraphQL endpoint (`api.github.com` `/graphql`) is refused under `restrict_to_rules` unless a rule of the restricting party lists it.
Listing it opens every repository the credential can reach, because a GraphQL query names its repositories in the request body, which the broker never reads.

**GitHub "Limit to repositories" helper.** The [services editor](#services-editor) writes these rules for you.
Its description reads: "One repository per line, as owner/repo, or owner/* for everything an owner has. Applying replaces the rules above with rules for just those repositories (API and git over HTTPS) and refuses every other path on api.github.com and github.com. Other API paths, such as /user or search, stop working. Matching is case sensitive, so write names as they appear in GitHub URLs."
Enter one `owner/repo` or `owner/*` per line and **Use these repositories** replaces the service's rules and turns on `restrict_to_rules`.
Repositories you typed are applied when you save too, even if you never pressed the button: an invalid line stops the save, is marked, and takes focus.
They are applied once per distinct list, so rules you edited by hand after pressing the button survive a save, and a changed list is applied again.
The helper writes:

- `owner/repo` gives `api.github.com` `/repos/owner/repo` (bearer), plus `github.com` `/owner/repo` and `/owner/repo.git` (basic auth with username `x-access-token`, which git over HTTPS uses).
- `owner/*` gives the owner-wide prefixes `/repos/owner/` and `/owner/`.
- On a service's own rules, `uploads.github.com` (release assets, `/repos/owner/repo` or `/repos/owner/`) and `/graphql` stay off unless you tick them. A [limit in place](#limiting-in-place) always gets the `uploads.github.com` rules and has no such choice, because leaving that host out would leave the administrator's `uploads.github.com` rule reaching every repository.
- Other API paths, such as `/user` or search, stop working while the restriction is on.
- On a **Custom** service that has no placeholder variables, it also adds `GH_TOKEN` and `GITHUB_TOKEN` with the value `mindroom-brokered`, so `gh` and other GitHub tooling in the worker find a token to send. A service that already has placeholders keeps them.
- When the display name and description are empty (or still the text the helper wrote last), it sets them to "GitHub ({repos})" and "Limited to {repos}". Text you wrote stays.

The editor shows the helper only when the preset is `github` or one of the service's own rules has the host `github.com`, `api.github.com`, or `uploads.github.com`.

**Limit to repositories on an administrator's service.** On the personal page, a service from `config.yaml` that has a rule on one of those three hosts gets a **Limit to repositories** action for users who can manage the agent.
It opens the editor in limit mode, titled "Limit to repositories", with the name `github-limited` (or the first free `github-limited-N`), the repository helper, and the sentence that says whose agents the limit reaches (see [Services editor](#services-editor)).
The form has no preset, website, key, or More options.
**Save limit** adds a `restrict_only` service of the user's own (see [Limiting in place](#limiting-in-place)): it narrows the administrator's GitHub service as described above, and the administrator's service is not changed and keeps supplying the credential, the user's own connected account or API key.
A row whose rules on GitHub hosts all name repositories reads "Limited to {repos}", where `{repos}` is the `owner/repo` or `owner/*` list; a rule for the whole API means the row is not limited. A rule for `/graphql` does not hide the limit: the row then reads "Limited to {repos} (plus GraphQL, which reaches every repository the key can reach)".

**What it cannot do:**

- It limits only the hosts the service has rules for. A limit in place covers `api.github.com`, `uploads.github.com`, and `github.com`. On a service's own rules `uploads.github.com` is covered only when you tick it, so otherwise the administrator's `uploads.github.com` rule keeps reaching every repository.
- Under `unmatched_hosts: passthrough` it is not a network boundary. A worker can open a tunnel to the server's IP address, which the broker does not intercept. The tunnel carries no credential, but paths you did not list stay reachable through it. `unmatched_hosts: deny` refuses that tunnel.
- The real boundary is the credential. Use a fine-grained personal access token limited to the repositories you want, or a GitHub App installed on selected repositories, so GitHub itself refuses everything else. The rules only decide what the broker injects and forwards.

#### Limiting in place

A service with `restrict_only: true` only limits paths. It is how a user narrows an administrator's service, such as GitHub, to some repositories without replacing the credential: the administrator's service, with the user's own connected account or API key, keeps sending it.
The personal page's [limit editor](#the-limit-editor) saves one of these. As the body of `PUT /api/connections/egress/agents/<agent>/services/github-limited`, it looks like this:

```json
{
  "display_name": "GitHub (basnijholt/agent-cli)",
  "description": "Limited to basnijholt/agent-cli",
  "restrict_to_rules": true,
  "restrict_only": true,
  "rules": [
    {"host": "api.github.com", "path_prefix": "/repos/basnijholt/agent-cli"},
    {"host": "github.com", "path_prefix": "/basnijholt/agent-cli"},
    {"host": "github.com", "path_prefix": "/basnijholt/agent-cli.git"},
    {"host": "uploads.github.com", "path_prefix": "/repos/basnijholt/agent-cli"}
  ]
}
```

With the administrator's `github: {preset: github}`, a request to `api.github.com/repos/basnijholt/agent-cli/pulls` passes the user's check and still gets the administrator's `github` credential, while `api.github.com/user` gets 403 `path_not_allowed` naming this limit. The same holds on `uploads.github.com`: release assets of `basnijholt/agent-cli` get the administrator's credential, and any other repository's get 403. A limit with no rule on `uploads.github.com` would leave that host unlimited, which is why the limit editor always writes one.

- **Config.** Only a user service may set `restrict_only`, and it must be a real boolean. The service may not set `oauth_provider`, a non-empty `placeholder_env`, or `oauth_on_shared_workers`, because it never sends a credential. Its rules need no `auth`; one that is written is ignored. With a `preset`, only the preset's `display_name`, `description`, and `rules` apply, so `{preset: github, restrict_only: true}` is valid and takes no login or placeholders from the preset. Setting `restrict_to_rules: true` beside it, which the services editor does, is valid too.
- **Routing.** The rules are a path check only. They count in the requester's check like the rules of a user service with `restrict_to_rules`, so a path that none of the requester's rules on the host list is refused with `path_not_allowed`. They are never considered when the credential is chosen, so a path they allow still gets the credential of the most specific matching rule of the other services on the host, usually the administrator's GitHub rule. With no such rule the request is forwarded without credentials, as for any path that no rule matches. Everything under [Limiting paths and repositories](#limiting-paths-and-repositories) about scope and the administrator's services holds for it.
- **Not in `config.yaml`.** A config service that sets `restrict_only: true` fails validation with "service '<name>': restrict_only is only for services users add; use restrict_to_rules in config". In the administrator's own config the service that holds the credential limits its paths itself, with `restrict_to_rules` and rules for the paths it allows.
- **No key.** The key routes answer 422 for such a service ("This service only limits paths and never sends a key, so it cannot store one"): `PUT /api/connections/egress/agents/<agent>/<service>` and `PUT /api/egress-broker/services/<name>/secret`. Saving a user service as a limit also deletes any key stored under its name, even when it replaces an existing service, so converting a service to a limit leaves no key behind.
- **Agent tool.** The [`egress_credentials` tool](#agent-tool) leaves such services out, so the agent is never told that a key is missing for a service that takes none.
- **Listings.** The status listings, the portal catalog, and `GET /api/connections/egress/agents/<agent>/services/<name>` carry `restrict_only`, so a client can show a limit and open it for change.

## Secret sources

A service can take its secret from two sources in a worker's scope:

- **API key**: a key stored for the scope, set by hand.
- **Connected account**: an OAuth login that the user connected through MindRoom's OAuth providers (the GitHub App user login, the Google providers, Atlassian). A service uses this source when it has an `oauth_provider`, which every preset except `openai` and `anthropic` sets.

For each request the broker picks the secret in this order:

1. The API key stored for the scope, if there is one. An explicit key always wins over a connected account, and removing the key falls back to the account.
2. Otherwise, the connected account's access token. The primary refreshes it only when it is near expiry, through the same serialized refresh the tools that share the connection use, so there is no second refresh path.
3. Otherwise, a 403 `credential_not_configured` that also carries a connect link when the broker may hand one out for the account (see [Error responses](#error-responses)).

The matched rule's auth type then formats the token like any other secret, so a connected GitHub account goes out as `Authorization: Bearer <token>` to `api.github.com` and as basic auth with username `x-access-token` to `github.com`.
Placeholder environment variables are added when either source is available.

OAuth access tokens are fetched and refreshed in the primary and injected by the broker.
They never reach a worker, its environment, or its filesystem; the worker holds only its proxy token and the placeholder values.

**Which account a request uses:**

- The account follows the provider's own credential policy. GitHub and Atlassian are requester-scoped: the broker uses the requester named in the worker's verified token, so each user's requests use that user's own account. By default the broker uses such an account only on `user` and `user_agent` agents that run on a dedicated (Docker or Kubernetes) worker backend (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)).
- The Google providers follow the agent's worker scope like API keys do: a `shared` agent has one connection that credential managers maintain, and a `user` agent has one per requester.
- A call without a requester has no requester-scoped account (GitHub or Atlassian) to use.

**Service accounts are never injected.**
A deployment that sets `GOOGLE_SERVICE_ACCOUNT_FILE` serves the Google providers through a shared Google service account instead of personal logins.
The broker does not inject a service account's credentials, so the egress pages show such a service as "Uses a shared service account" and personal accounts cannot be connected for that provider.
The account part shows as not connected unless a personal connection was stored earlier; such a connection keeps working, and shows as connected, until it is disconnected.
Give the service an API key if workers need to call it in that deployment.

**Unknown `oauth_provider` ids** are not a config error.
When the id is not in MindRoom's OAuth registry (for example a plugin provider that is not loaded), the broker logs one warning that names the service and uses no account source for it, so the service works with an API key only.

**Connected account problems** do not reach the worker as plain missing credentials:

- A revoked or rejected grant, or a stored credential that cannot be read, returns 403 `oauth_connection_required`. The user reconnects (an unreadable credential must first be reset, with the egress row's **Reset connection** button or from the dashboard Tools tab, and then the response has `reset_required` and no link).
- A provider outage, timeout, or network failure while refreshing returns 503 `oauth_refresh_failed`. The grant is fine, so the worker retries later and the user does not reconnect. After such a failure the broker answers the same credential store with 503 immediately for 30 seconds instead of asking the provider again.
- Logs carry the service, the provider id, and the error type, never tokens or connect links.

### Personal accounts and shared sandboxes

A requester's own GitHub or Atlassian account is safe to use only in a sandbox that belongs to that requester.
That is an agent with worker scope `user` or `user_agent` on a dedicated worker backend (`MINDROOM_WORKER_BACKEND` set to `docker` or `kubernetes`), where each requester's commands run in their own worker.
When other requesters' files must also stay out of those commands, the agent must be `private`; its `private.per` then sets the worker scope (see [Shared workspaces on non-private agents](#shared-workspaces-on-non-private-agents)).

Every other sandbox is shared:

- A `shared` agent, and an agent without a worker scope, runs every requester's commands in one sandbox, whatever the backend.
- The static runner (`MINDROOM_WORKER_BACKEND` unset or `static_runner`, including the hosted sidecar) runs every call in one process, so even `user` and `user_agent` agents share a sandbox there.

A proxy token minted for one user's call stays readable in a shared sandbox for its lifetime (for example in the environment of a process that call left running), so a later command from another user could use it to act with the first user's GitHub or Atlassian account until the token expires.

So in a shared sandbox the broker does not use requester-scoped accounts at all:

- It injects no GitHub or Atlassian account and adds no placeholder variables for it, and a matched request without an API key gets a 403 `credential_not_configured` with `manage_url` and no `connect_url`.
- The status API reports the account part with `unavailable_reason: "shared_sandbox"`, not connected and not connectable.
- On a shared or unscoped agent the row reads "Personal {provider} accounts can't be used by shared agents." plus "Ask {managers} to add a team API key." for a user who cannot manage the agent ("Ask an administrator to add a team API key." when the agent has no `credential_managers`) or "Add a team API key instead." for one who can.
- On a personal agent (`user` or `user_agent`) that runs on the static runner, the sandbox is shared but the agent is not, so team keys and managers do not apply. The row reads "Personal {provider} accounts can't be used in this sandbox, which other users' commands share. Add an API key instead."
- Both texts show on the personal page and in the "API keys and accounts" section of each agent on the Connections portal. The dashboard panel only lists shared and unscoped agents, so it always reads "... Add a team API key instead.", because an administrator manages every key there. None of them offers **Connect** there.
- The [`egress_credentials` tool](#agent-tool) reports such a service as not configured and not connectable.

Give those agents an API key instead, or run the agents whose users need their own account with worker scope `user` or `user_agent` on the Docker or Kubernetes worker backend, and make them `private` if other requesters can use them (see [Shared workspaces on non-private agents](#shared-workspaces-on-non-private-agents)).
The Google providers are not affected: their connection on a shared agent is the agent's own, maintained by its credential managers.

An operator who accepts the risk can set `oauth_on_shared_workers: true` on the service.
The broker then injects the calling requester's own account in shared sandboxes as well, and anyone who can run commands in such a sandbox can act with any other user's connected account until that user's proxy token expires (`MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS`, default 7 days).
The status API marks those rows with `shared_worker_opt_in: true`, and the egress pages warn "Everyone using this agent can act with the connected account until its access expires".
Use it only where everyone who can use the agent may act with each other's accounts, such as a single-user deployment.

#### Shared workspaces on non-private agents

A worker per requester does not keep requesters apart.
On a `user` or `user_agent` agent that is not `private`, every requester works in the same agent workspace.
A file one requester leaves there, such as `.mindroom/worker-env.sh`, can run in another requester's commands, and it then runs with that requester's broker access.
So another requester's code can use that requester's connected accounts and personal keys, but not read them, as long as none of the hosts those services reach echo requests (see [Hosts that echo requests](#what-the-broker-cannot-protect-against)).
When requesters need to be kept apart, make the agent `private`, so that each requester gets a workspace root of their own. Set `private.per` to `user` or `user_agent` instead of `worker_scope`, because the two cannot both be set (see [Private Instances](../configuration/agents.md#private-instances)).
Connected accounts and personal keys belong to the requester, not to one agent: GitHub and Atlassian accounts are stored at scope `user` whichever agent uses them, and `user` keys are shared by all of that requester's `user` agents. So every personal (`user` or `user_agent`) agent that other requesters can use must be `private` for those accounts to stay out of other requesters' code, not only the agent that seems most sensitive.

## Secret management

API keys are stored per worker scope in the primary-only credential store (the same encrypted store that holds other credentials), never in worker-writable locations.
Connected accounts live in MindRoom's OAuth credential stores under the same primary-only rule and the scope policy above.

**Scopes:**

| Worker scope | Secret stored in |
|--------------|------------------|
| `user_agent` | Requester and agent scoped store |
| `user` | Requester scoped store |
| `shared` | Agent scoped store |
| None (no worker scope) | Global store, shared by every agent without a worker scope |

Agents without a worker scope do not get a store of their own: they all read the one global key per service, so setting or removing it affects every such agent.
The dashboard panel edits it as **Agents without a scope**.

Set secrets and connect accounts in the **Agent Keys** panel on the dashboard's Credentials page, or on the personal egress page at `/connections/egress` (linked as "API keys and accounts" from the Connections pages).
The panel is the first card on the Credentials page. Below it sits the raw editor, **Raw credential payloads (advanced)**, collapsed until you click its heading (collapsing hides the payloads again), whose button reads **Save payload**.
The panel's **Keys for** selector lists the `shared` agents that can run commands first, in config order, and then **Agents without a scope**, only when such an agent exists; it defaults to the first entry, which is **Agents without a scope** when no shared agent exists.
When no agent uses the panel's keys at all (every agent that can run commands is `user` or `user_agent`), the panel hides its key actions and says "No agent uses these keys."
Under **Add service** the panel says "Services you add here are offered to every agent and user. Private agents are not listed: each user sets their own keys on the Connections page.", and "Connections page" links to `/connections`.
Keys for `user` and `user_agent` agents belong to each requester, so the panel does not list them and each user sets them on the personal egress page.
The status API returns, for each service and scope, whether a key is set and when it was last updated, and the state of the connected account; it never returns a secret or token.
`configured` is true when either source is available, and `active_source` is `key`, `oauth`, or `null`:

```json
{
  "name": "github",
  "configured": true,
  "active_source": "oauth",
  "key_configured": false,
  "key_updated_at": null,
  "oauth": {
    "provider": "github",
    "display_name": "GitHub",
    "connected": true,
    "account_label": "alice@example.org",
    "can_connect": true,
    "reset_required": false,
    "service_account": false,
    "unavailable_reason": null,
    "shared_worker_opt_in": false
  }
}
```

The example is abbreviated: each service also has `display_name`, `description`, and `source`, which is `config` for a service in `config.yaml` and `user` for a [user service](#user-services).
Both listings add `restrict_only` (`true` for a service that only [limits paths](#limiting-in-place)) and `rules`, which clients use to warn about overlapping rules and to say how a service sends its key. Each rule has:

- `host`, `port`, and `path_prefix`.
- `auth_type`: `bearer`, `basic`, `header`, `query`, `template` (a header whose value template is more than the bare key), or `null`.
- `auth_name`: the header or query parameter name for `header`, `query`, and `template`, and `null` for `bearer` and `basic`.

Both are `null` for the rules of a `restrict_only` service. They never carry the key, a template's text, or a basic username.
The personal listing, and the `egress_services` of the portal's catalog, also give each service `placeholder_names`, the names (never the values) of the variables the service sets in the sandbox, a preset's included, so the editor can warn when a service of the user's own sets a variable that an administrator's service sets too.
The personal listing also adds `is_shared` and `can_manage` per service, and gives each agent:

- `shared` (a shared or unscoped agent) and `can_manage` (the caller may change its keys and services), so a client can offer **Add service** only where it works, even for an agent that has no services yet.
- `scope`, whose store the agent's services and keys live in: `"user_agent"` (this agent's own, per requester), `"user"` (one store for all of the requester's `user` agents), `"shared"` (the agent's, for everyone who uses it), or `"unscoped"` (the global store, shared by every agent without a worker scope).
- `scope_agents`, for a `user` agent, the display names of the requester's agents that share the store, this agent included, in config order. It is `[]` for every other scope.
- `managers`, for a shared or unscoped agent, the Matrix IDs of its `credential_managers` (administrators can always manage it as well), and `[]` otherwise.
- `inactive_services`, the entries stored in that agent's scope that the broker ignores, as `{"name": "...", "reason": "shadowed"}` (a config service has that name now) or `"invalid"` (the entry no longer validates); see [User services](#user-services).

Agents come in config declaration order, whatever their state.
`display_name` can be `null` in the dashboard listing, while the personal listing falls back to the title-cased service name.
`oauth` is `null` for a service without an account provider.
`unavailable_reason` is `"shared_sandbox"` when the scope runs in a shared sandbox (a shared or unscoped agent, or any agent on the static runner) and the provider is GitHub or Atlassian without `oauth_on_shared_workers`; the account part is then not connected and not connectable. Clients pick the refusal text by the agent's `shared` flag, not by this reason alone (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)).
`shared_worker_opt_in` is `true` on such a scope when the service sets `oauth_on_shared_workers` (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)).
The OAuth part comes from the same helper as the Connections portal's per-provider status, so the egress pages and the portal agree.

### Connecting an account

On the personal egress page and the dashboard panel, a service with an account provider shows **Connect <Provider>** as its primary action.
On the Connections portal's cards the button reads just **Connect**, and the provider is in its accessible name ("Connect <Provider>").
It opens the provider's login in a popup; a connected row then reads "Connected as <account>" (just "Connected" when the connection has no label) with a **Disconnect** button.
That is the text of an egress row, on the personal page, the dashboard panel, and the "API keys and accounts" section of the Connections portal; the portal's account cards instead show "Connected" with the account on a separate line, and a shared service uses the "shared with everyone using" form below.
A row whose saved connection cannot be read reads "Reset required" and offers only **Reset connection**; **Connect** returns once the reset is done.
**Use an API key instead** keeps the key actions (**Set key**, **Replace key**, **Remove key**); once an account is connected it reads **Use an API key instead of the account**. A row of a service with an account provider whose key is in use reads "Using API key".
When a key and a connected account both exist, the row adds "Your connected {provider} account is kept for other services."
In a shared sandbox (a shared or unscoped agent, or any agent on the static runner) a GitHub or Atlassian row offers no **Connect** and says personal accounts cannot be used there, in the shared-agent wording or, for a personal agent on the static runner, the sandbox wording (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)), unless the service sets `oauth_on_shared_workers`, in which case the row warns that everyone using the agent can act with the connected account.
Where the status offers no **Connect** because the scope runs in a shared sandbox, the connect and disconnect routes agree and answer 409 with a message instead of starting a login.

**The login popup.** The popup's last page tells the page that opened it how the flow ended, then closes itself.
That page is the success page or any refusal page of the OAuth routes (a provider error, a cancelled authorization, a stale or foreign connect link, a failed authorize step).

- **The message.** The page calls `window.opener.postMessage({type: "mindroom-oauth", status, provider}, origin)`. `status` is `connected`, `cancelled` (the user declined at the provider, `access_denied`), or `error`, and `provider` is always the registered provider id; an unknown provider in the URL gets a page with no script and no URL text.
- **The target origin is validated and never `*`.** When the connect request carries an `Origin` that is the OAuth completion origin (the OAuth public base URL) or one of the dashboard's allowed CORS origins (`MINDROOM_DASHBOARD_CORS_ALLOWED_ORIGINS`, or the hosted instance's own origins; a CORS `*` adds none), the pending flow records it, and the callback's pages post there. Otherwise the page posts to its own origin, and only when its opener is a same-origin page, so a window opened from a chat link or from no page gets no message and stays open so its text can be read. The dashboard's success redirect carries the recorded origin as `?opener_origin=`, which the success page validates again, ignoring anything outside the allowed set.
- **Closing.** After posting, the page closes itself after 1.5 seconds. The cancelled page is titled "Authorization cancelled" and reads "You cancelled. Nothing was connected."; other provider errors keep "OAuth provider returned an error: <code>. Nothing was connected."
- **The opener.** It accepts a message only from its own popup window, from the OAuth completion origin, and for the provider it is connecting, then stops "Connecting…" at once: `connected` refreshes the row, `cancelled` says "Authorization was cancelled.", and `error` says "Could not connect. Try again." It leaves the popup open to close itself, so its text can be read.
- **A popup closed without a message.** When the popup is found closed and nothing arrived (closed by hand, or the connection finished before the message was read), an egress row reads the listing it came from once more and checks its service's `oauth.connected`: `GET /api/connections/egress` for the rows of the personal page and of the Connections page, and `GET /api/egress-broker/services` for the selected scope on the dashboard (`?agent_name=<agent>`, or none for the agents without a scope). A connected service counts as connected; anything else, a failed read included, counts as cancelled. A tool row on the Connections page asks its provider's status route, `/api/connections/agents/<agent>/<provider>/status`, instead. That route knows only providers the agent has a tool for, so egress rows do not use it.

**GitHub account label.** After a GitHub connection finishes, MindRoom reads the account's login from the GitHub API (`https://api.github.com/user`, with the new token, one overall 5 second deadline, and no redirects) and shows it as the account label, so the row reads "Connected as octocat".
GitHub's token response names no account, so the lookup runs once per connection, never on refresh.
If the lookup fails, the account still connects and shows no label, and the log records only the error type, never the token.
Accounts connected before the lookup existed show no label until they are reconnected.
The label is the verified email when the provider gives one, else the login.

**Shared accounts.** Where connecting an account makes everyone who uses the agent act as it, **Connect** first asks "Connect a shared account?" with the body "Everyone who uses {agent} will act as the {provider} account you pick. Use a team account, not your personal one." and the buttons **Continue** and **Cancel**; nothing is sent before **Continue**.
That is an agent-scoped account (the Google providers) on a shared or unscoped agent, and the dialog appears on the personal egress page, the Connections portal, and the dashboard panel (where the unscoped scope names itself "the agents without a scope").
It does not appear for a service account, for a personal GitHub or Atlassian account that a shared sandbox refuses, or for one that `oauth_on_shared_workers` allows.
Every user of the agent, not only its managers, sees such a connected account as "Connected as {account} · shared with everyone using {agent}" (just "Connected · shared with everyone using {agent}" when it has no label), because they all act as it. Only administrators and credential managers can connect or disconnect it.

**GitHub and Atlassian on shared agents.** These accounts belong to the requester, so a shared agent differs:

- Without `oauth_on_shared_workers`, a shared sandbox refuses them (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)), so there is no **Connect**, and no user's personal account appears on the agent.
- With `oauth_on_shared_workers`, **Connect** goes straight to the login with no confirmation. The row shows the viewer's own "Connected as {account}" plus the amber warning "Everyone using this agent can act with the connected account until its access expires", and any user who may use the agent connects their own account there.
- Any account shown comes only from the viewer's own connection, never another user's.

**Disconnecting.** The confirmation reads "Disconnect {provider}?" (or "Reset {provider}?" for an unreadable connection), then "This removes the saved {provider} connection for {agent}. These services stop working until an account is connected again: {services}." The list holds every service in that agent's listing that uses the provider, and on the Connections portal's cards also the provider's tools.

The Connections portal cards do not edit services: every agent the user may use for egress has a **Manage services** link to its section on the personal page (`/connections/egress#egress-agent-<agent>`), even an agent that has no services yet, where services are added, edited, and deleted. When the user can change none of the agent's listed services, the link reads **View services**; an agent with no services keeps **Manage services**, because nothing says whether the viewer can manage it.

An agent can also send a user straight to the login: the 403 `credential_not_configured` and `oauth_connection_required` responses and the [`egress_credentials` tool](#agent-tool) point at where to connect, and the broker's responses carry a `connect_url`, a short-lived single-use link.
The link carries only the connect target, not a login: the browser that opens it must be signed in to MindRoom as the requester the link was minted for.
A link for a connection that everyone using the agent shares would skip that sign-in, and any process in the shared worker could read it from the response, so the broker never hands one out for it: the response has no `connect_url` and the user connects at `manage_url` instead.
GitHub and Atlassian connections belong to the requester, not to the shared scope. Where `oauth_on_shared_workers` lets a shared agent use them, the response carries a link for the calling requester's own account, and its message is the connectable text (see [Error responses](#error-responses)).
The broker reuses one link per caller for 60 seconds, so a worker that retries in a loop does not mint a new one each time.

Who may connect an account follows who may set a key, with one exception:

- For `user` and `user_agent` agents, each user connects their own account on the personal page. GitHub and Atlassian accounts work only where those agents run on a dedicated worker backend; on the static runner they are shared sandboxes (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)).
- For `shared` and unscoped agents, administrators and the agent's `credential_managers` connect and disconnect accounts, and set keys.
- GitHub and Atlassian are the exception where the service sets `oauth_on_shared_workers`. Their connections belong to the requester, so any user who may use the agent can then connect their own account on a shared agent too. Without that setting a shared sandbox does not use these accounts, so its rows offer no connection. API keys on shared agents stay with the managers.

On the dashboard panel, a GitHub or Atlassian account is likewise the signed-in administrator's own account, for an agent and for **Agents without a scope** alike, never one shared by the agent.
The panel's scopes are shared and unscoped agents, which are shared sandboxes, so it offers such a connection only where the service sets `oauth_on_shared_workers`.

The personal egress page and its API, `/api/connections/egress`, authenticate with `require_connections_user`: they need [trusted upstream auth](trusted-upstream-auth.md) with JWT (`MINDROOM_TRUSTED_UPSTREAM_REQUIRE_JWT`) and a verified Matrix identity on the request.
Without that signed identity gate, such as on a lab host that has no upstream proxy, only the dashboard can manage secrets.
When more than one user can sign in through the gateway, `MINDROOM_CONNECTIONS_AGENT` is required as well: the egress routes themselves work without it, but without it every user the gateway admits has full dashboard access, including configuration edits, shared keys, and every requester's log (see [Security Boundary](trusted-upstream-auth.md#security-boundary)).
With `MINDROOM_CONNECTIONS_AGENT` set, a user who is not in `administrators` and opens a dashboard page (a browser `GET` that accepts `text/html`, outside `/api/`) is redirected with 303 to `/connections?notice=admin-only` instead of seeing a JSON refusal.
The Connections header shows the notice "The dashboard is for administrators. Manage your agents' keys and accounts here." until it is dismissed (**Dismiss** is remembered for the browser session), and ignores a `notice` value it does not know.
API calls keep the 403 JSON, and the Connections routes and the OAuth callback, success, and reset pages behave as before.
On the personal page, users manage their own keys, accounts, and [services](#user-services) for `user` and `user_agent` agents, while keys, accounts, and services for shared and unscoped agents are managed only by administrators and the agent's `credential_managers`, who also see every requester's rows in that agent's [request log](#personal-request-log).

**Dashboard API routes** (all require dashboard authentication):

| Route | Method | Description |
|-------|--------|-------------|
| `/api/egress-broker/services?agent_name=<name>` | GET | List services with configured status; omit `agent_name` for global scope. The list holds the config services, then the selected scope's own user services, read-only, each with `source` |
| `/api/egress-broker/presets` | GET | List the built-in presets and the OAuth providers an account login can name, in the shape described under [Services editor](#services-editor) |
| `/api/egress-broker/services/<name>/secret?agent_name=<name>` | PUT | Set a secret; body `{"secret": "<value>"}`. 404 when the name is neither a config service nor one of the scope's own services, 422 for an invalid secret and for a [`restrict_only` service](#limiting-in-place), which takes no key |
| `/api/egress-broker/services/<name>/secret?agent_name=<name>` | DELETE | Delete a secret |
| `/api/egress-broker/services/<name>/connect?agent_name=<name>` | POST | Start the OAuth login of the service's provider for that scope; returns the authorization URL. 404 when the name is not a config service or the service has no known provider, 409 while a shared service account replaces personal accounts and 409 when the scope's sandbox is shared and the broker would not use a requester's own account there (GitHub and Atlassian without `oauth_on_shared_workers`) |
| `/api/egress-broker/services/<name>/disconnect?agent_name=<name>` | POST | Reset the connected account for that scope; 404 and the shared-sandbox 409 as for connect. It stays possible while a shared service account is configured, so an account connected earlier can be revoked |
| `/api/egress-broker/logs?agent_name=&requester=&host=&service=&limit=` | GET | Query request audit logs for every requester; each row carries `requester_id` and `code`, and `requester` matches `requester_id` exactly; returns 409 when the broker is not running |
| `/api/egress-broker/ca.pem` | GET | Download the broker's root CA certificate; returns 409 when the broker is not running |

The dashboard has no route that writes service definitions: it edits the services in `config.yaml` through the config API that Settings uses (see [Services editor](#services-editor)), and the connect and disconnect routes work for config services only.

Secrets are rejected when they are empty, whitespace-only, contain ASCII control characters, or exceed 16 KiB.

**Personal API routes** (all under `/api/connections/egress`) need a signed Matrix identity and answer 403 without one.
The routes that change something also need a same-origin request from an HTTPS `MINDROOM_PUBLIC_URL`, and answer 403 for any other origin.
Every route except the log rejects any query parameter with 400, so a request cannot carry a filter the route does not define.
The routes that name an agent answer 404 for an unknown agent and for one the caller may not use:

| Route | Method | Statuses and description |
|-------|--------|--------------------------|
| `/api/connections/egress` | GET | 200 with every agent the caller may use and its services (config services first, then the scope's own) |
| `/api/connections/egress/presets` | GET | 200 with the built-in presets and the OAuth providers an account login can name, in the shape described under [Services editor](#services-editor) |
| `/api/connections/egress/logs?agent_name=&limit=` | GET | 200 with the caller's own rows, or every requester's rows on a shared or unscoped agent the caller manages, see [Personal request log](#personal-request-log). 400 for any other query parameter, 409 when the broker is not running, 422 for a non-integer `limit`, 503 when no config is loaded |
| `/api/connections/egress/agents/<agent>/<service>` | PUT | Set a key; body `{"secret": "<value>"}`. 204; 403 without credential management on a shared or unscoped agent; 404 for a service that is neither a config service nor one of the scope's own; 422 for an invalid secret and for a [`restrict_only` service](#limiting-in-place), which takes no key |
| `/api/connections/egress/agents/<agent>/<service>` | DELETE | Delete a key. 204; 403 and 404 as for PUT |
| `/api/connections/egress/agents/<agent>/<service>/connect` | POST | Start the OAuth login of the service's provider. Same checks as the key routes, with the requester-scoped exception above, then the provider's OAuth connect flow; 404 for a service without a known provider, 409 while a shared service account replaces personal accounts and 409, with a string detail, where the agent runs in a shared sandbox and the broker would not use the requester's own account there (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)) |
| `/api/connections/egress/agents/<agent>/<service>/disconnect` | POST | Reset the connected account, with the same checks, the 404, and the shared-sandbox 409. It stays possible while a shared service account is configured, so an account connected earlier can be revoked |
| `/api/connections/egress/agents/<agent>/services/<name>` | GET | 200 with one of the scope's own services as authored, so a preset stays `{"preset": "github"}` and a limit keeps `restrict_only`. 404 for a config service or a name only another scope has. Any user of the agent may read it, because a service holds no secret |
| `/api/connections/egress/agents/<agent>/services/<name>` | PUT | Create or replace one of the scope's own services; the body has the fields of a [config service](#custom-services) except `oauth_on_shared_workers`. 204; 403 for a user who cannot manage services there; 409 when a config service has the name; 413 for a body over 16 KiB; 422 with a string detail for a body that is not a JSON object, an invalid service, or one of the caps and rules in [User services](#user-services) |
| `/api/connections/egress/agents/<agent>/services/<name>` | DELETE | Delete one of the scope's own services together with its key, or an [inactive entry](#user-services) of either reason (a shadowed entry keeps the key, which the config service uses). 204; 403 as for PUT; 404 when the scope has no such entry; 409 for the name of a config service that has no entry of its own |

**The Connections identity route.** `GET /api/connections/me` returns `{"matrix_user_id": "...", "email": "..." or null, "is_administrator": true or false, "egress_enabled": true or false}` for the signed-in user, where `egress_enabled` says whether the broker is on, so the pages link the Agent Keys page only then.
It works for any signed user, with or without agents, and with or without `MINDROOM_CONNECTIONS_AGENT`, because both Connections pages use it for their header.
It needs the same signed Matrix identity as the other personal routes, rejects any query parameter with 400, and sends no-store headers.

The portal's catalog, `/api/connections`, lists the same egress rows as the personal listing, so each row there has `source`, `rules`, and `placeholder_names` too.
While the broker is on, an agent's `egress_services` there is a list, empty when the agent has no services, for every agent the user may use for egress, and `null` for any other agent, so the portal links **Manage services** exactly for the first kind.
While the broker is off, `egress_services` is `null` for every agent.
Agents in the catalog follow config declaration order, with no agent placed first.
Each agent in the catalog carries `managers` (the same list as the personal listing: a shared or unscoped agent's credential managers, `[]` otherwise; while the broker is off, it is filled only when the agent has an account the user cannot change), and each service in its `services` carries `connected`: what the status route would report to the viewer, read without refreshing the token, and `false` when the state cannot be read. The Connections summary uses it to count accounts before an agent is opened.

## User services

A user service is a service the user defines for their own scope instead of an administrator defining it in `config.yaml`.
Users manage them on the personal egress page at `/connections/egress`, which needs [trusted upstream auth](trusted-upstream-auth.md) with JWT.
They have the same fields and validators as a config service (a preset or `rules`, `placeholder_env`, `oauth_provider`, `restrict_to_rules`), plus [`restrict_only`](#limiting-in-place), which only user services may set. Only `oauth_on_shared_workers` stays operator-only: a request that sets it, even to `false`, is rejected with 422.

**Who can add them:**

- On `user` and `user_agent` agents, the requester themself. The service applies only to that requester's workers.
- On `shared` and unscoped agents, administrators and the agent's `credential_managers`, the same rule as for keys. Other users of the agent can read the services but not change them.

**Where they live.**
A service is stored per scope, in the same primary-only store as that scope's keys, as one document under the reserved credential name `egress__services`; a service name starts with a letter or digit, so no key can take it.
It follows the placement in the [scope table](#secret-management): per requester (and agent for `user_agent`), per agent for `shared`, and in the global store for unscoped agents, where every agent without a worker scope shares it.
So a service saved on one of a user's `user` agents applies to all of that user's `user` agents, together with its key, while each `user_agent` agent has its own.
The editor says which on a personal agent, from the listing's `scope` and `scope_agents`: for `user_agent`, "Only your {agent} uses this service and its key."; for `user`, "All your agents that share your personal workspace use this service and its key: {agents}." Shared, unscoped, and dashboard editors show no such note.
The delete confirmation of a service says who loses it, by scope: "Your {agent} loses access through it." (`user_agent`), "All your agents that share your personal workspace lose access through it: {agents}." (`user`), "Everyone using {agent} loses access through it." (shared), or "Every agent without a scope loses access through it." (unscoped).
Workers never read that store.
The broker merges the config services and the calling scope's own services per request, from a small per-scope cache that every save or delete clears, so a change applies to the next request without a restart.
A user service routes only that scope's keys and accounts, so it cannot reach anyone else's credentials.

**Rules about names and overlap:**

- Config names win. Saving a name that a config service already uses returns 409, and a user entry that a config service later shadows is ignored. It can still be deleted, and its key then stays, because the config service uses that key. On a shared or unscoped agent, storing a key for that config service deletes the entry (see **Keys** below).
- On a host that both a config service and a user service name, the usual order applies (exact host, specific port, longest path prefix, then config services before user services, then service name), so a longer user prefix takes those paths for that user only.

**Inactive entries.**
The broker ignores a stored entry that a config service now shadows (`shadowed`) and one that no longer validates, for example after an upgrade tightened a rule (`invalid`), but the entry stays in the scope's store.
The personal listing reports each as `inactive_services` with its reason, and the personal page shows them under the agent as **Inactive** with the reason and a **Delete** button where the caller may manage services.
Inactive entries count toward the caps below until they are deleted, so a scope full of them cannot take a new service.
Deleting a shadowed entry keeps the key, which the config service uses, and deleting an invalid entry removes its key.

**Caps.** A scope can have at most 50 user services, a service at most 50 rules, a service at most 16 KiB (as stored, in its authored form), and all of a scope's services at most 256 KiB.
Going over one of these is a 422, except that a request body over 16 KiB is refused with 413 before its fields are checked.

**User services narrow operator policy and never widen it:**

- Under `unmatched_hosts: deny`, only hosts that the operator's services name are allowed. At runtime a user rule applies only on a host and port pair that an operator rule names, and a user rule on any other host is ignored. Saving is stricter and returns 422 naming the hosts: it also rejects a wildcard host that the config does not cover with the same wildcard, and a rule with no port that no any-port config rule covers.
- On a host where an operator service sets `restrict_to_rules`, a path must match an operator rule. A user rule only picks the credential for a path that is already allowed, so a user rule for `/` cannot open paths the operator refuses.
- A user service that sets `restrict_to_rules` also limits the operator's services on its hosts: a path there must match one of the requester's own rules too, so an operator rule for a broader path no longer reaches it. This holds for the scope that holds the service only, and other requesters are unaffected; see [Limiting paths and repositories](#limiting-paths-and-repositories). A `restrict_only` user service does the same without a credential of its own, so the operator's service keeps sending the user's key or account for the paths it allows (see [Limiting in place](#limiting-in-place)).
- A user service can sign in with a connected account (`oauth_provider`, or a preset that has one) only on personal agents (`user` and `user_agent`). On a shared or unscoped agent, saving one with a provider returns 422, because a manager could otherwise route the agent's shared account to any host; set `oauth_provider: null` and use a key. A provider the registry does not know is refused too.
- A user service sends a connected account only to its provider's own hosts, because the token works nowhere else: the rule hosts of the built-in [presets](#presets) bound to that provider, such as `api.github.com`, `uploads.github.com`, and `github.com` for `github`, or `www.googleapis.com` for `google_drive`. Ports and path prefixes are free, but hosts compare exactly, so a wildcard such as `*.github.com` is refused. Saving a service with `oauth_provider` whose rules name another host returns 422 naming the provider, its hosts, and the refused hosts ("oauth_provider 'github' can only be used on api.github.com, uploads.github.com, github.com, so these hosts cannot be used with it: api.notes.example.com"), and a provider no preset is bound to, such as `google_cloud` or a plugin provider, is refused on every host. A stored entry that breaks this rule keeps its rules but loses its `oauth_provider` on load with the warning `egress_broker_user_service_oauth_ignored`, so no token is resolved or reported for it. Services in `config.yaml` and user services that use an API key are not limited this way.

**Keys.**
Creating a user service clears any stored key with the same name in that scope first, so a new service never inherits an old key (for example one left behind by a removed config service); replacing a service keeps its key, unless the saved service is `restrict_only`, which never has one and so deletes it.
Deleting a user service deletes its key, unless a config service now shadows the entry.
On shared and unscoped agents a key stays bound to the hosts it was set for, because the manager who changes a service may not be the one who stored its key:

- Replacing a service whose rules change (a host, port, path prefix, or how the key is sent, a preset's rules included) deletes its key, and a stored entry that no longer validates counts as changed. A change that leaves the rules as they were, such as the display name, description, or placeholders, keeps the key.
- Storing a key for a config service, from the dashboard or the personal page, deletes the scope's user entry of the same name, which that config service shadows, so the entry never becomes active with that key when the config service is removed or renamed.

On `user` and `user_agent` agents the requester owns both the service and the key, so a changed service keeps its key and a shadowed entry stays until they delete it.

**Placeholder variables.**
A user service's `placeholder_env` has stricter rules than a config service's, because a shared agent's services set variables in every requester's sandbox:

- The name matches `^[A-Z][A-Z0-9_]*$` and has `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `PAT`, `AUTH`, or `CREDENTIAL` as a whole word between underscores. `GH_TOKEN` qualifies, `PYTHONPATH` and `LD_PRELOAD` do not.
- The name does not start with `SSH_` and has none of `COMMAND`, `CMD`, `FILE`, `DIR`, `PROVIDER`, `HELPER`, `OPTS`, `OPTIONS`, or `EXTENSIONS` as a word, because tools read such variables as programs or paths to run or load. The reserved names that apply to config services apply here too.
- The value is 1 to 256 characters from letters, digits, `.`, `_`, `:`, and `-`, such as `mindroom-brokered`.
- When a config service sets the same variable, the config value wins, and the editor warns: "{VAR} is also set by {service} from your administrator; when both are set, theirs is used."

A save that breaks these rules returns 422 with one of these texts, which the editor shows beside the field:

- "{VAR} is not allowed as a placeholder: name a credential, such as MY_API_KEY, with TOKEN, KEY, SECRET, PASSWORD, PAT, AUTH, or CREDENTIAL as one of its words."
- "{VAR} is not allowed: tools read names with COMMAND, CMD, FILE, DIR, PROVIDER, HELPER, OPTS, OPTIONS, or EXTENSIONS, or starting with SSH_, as programs or paths."
- "The value of {VAR} must be 1 to 256 letters, digits, or . _ : -"

A stored entry that no longer passes these rules is skipped (or loses the offending variable) with a warning that names the service and never the value.

## Services editor

One editor adds, edits, and deletes services in two places:

- **Personal egress page** (`/connections/egress`): each agent has an **Add service** button where the caller may manage services (their own personal agents, and shared or unscoped agents they manage as an administrator or credential manager). A user's own services have **Edit service** and **Delete service**, and deleting also deletes the service's key. Services from `config.yaml` appear read-only under "From your administrator" and keep their key and account controls; a service that covers GitHub also offers **Limit to repositories** until the user has a limit on it, which the row then shows with **Change limit** and **Remove limit** (see [Limiting paths and repositories](#limiting-paths-and-repositories) and [The limit editor](#the-limit-editor)). [Inactive entries](#user-services) are listed under the agent with their reason, and can be deleted by anyone who may manage services there.
- **Dashboard Credentials page**: the **Agent Keys** panel has **Add service**, and **Edit service** and **Delete service** on the services of `config.yaml`. Deleting one removes it from the configuration but keeps its saved keys, which apply again if a service with the same name is added back. A save writes `config.yaml` through the same config API as Settings, keeps the preset form you wrote (`{preset: github}` is not expanded), so later preset updates still reach the service; because a save writes the whole configuration draft, when the Settings draft holds other unsaved changes the panel says so and asks you to confirm before it saves or deletes. When the save fails with an error, the draft goes back to what it was before the write; when the configuration changed while saving (a stale save), the panel asks you to reload the page and check the service list instead. The selected scope's user services show read-only with a "User service" badge, since users edit them on their own page. A user's limit (a `restrict_only` user service) of the selected scope shows read-only as a limit row, and the administrator's service it narrows reads "Limited to {repos}" without **Change limit** or **Remove limit**, since users change their limits on their own page. The panel's editor has no key field (keys have their own actions on each row), and its restriction help leaves out the sentence about limiting the administrator's services, because the dashboard edits the administrator's own services.

**Basic fields.** The editor opens with the fields most services need, in this order, and saves the service and its key in one step:

- **Preset**, or **Custom**. A preset brings its website, so the website and send fields below show only for a **Custom** service or after ticking **Replace the preset's rules with my own**; a line says what the preset covers.
- **Website**, the host of the first rule. The field strips what is not a host on every change, typing and pasting alike: a scheme (`https://`) and everything from the first `/`, `?`, or `#`. A path in what was pasted (up to a `?` or `#`, and not a bare `/`) moves into **Path prefix** when that is empty, and a note reads "Moved {path} to Path prefix" until the next change; a prefix that is already filled is kept, and the pasted path is dropped. A host with a port still says "Host must not contain a port (use the port field)".
- **Send the key as**: Bearer token, Header, Basic, Query parameter, or Custom template (a header with a value template). A Query parameter or Custom template adds a **Value template** field with the hint "Leave empty to send the key as is."
- **Header name**, with the hint "For example X-Api-Key" (or **Username** for Basic, or **Parameter name** for a query parameter, with the hint "For example api_key").
- **Name**, fixed once saved. For a new service it follows the preset id, or the first label of the website (`httpbin.org` gives `httpbin`), until you type one, and it takes the first free `{name}-2` or `{name}-3` when the name is taken. An empty name says "Name is required".
- **API key**, an optional password field with the hint "Paste the key now or later". It appears on the personal page only, where the caller may set the agent's keys. When the service being edited belongs to a shared or unscoped agent and has a key, a line under it says "Saving changed rules removes the saved key, so it must be set again." (see [User services](#user-services)).

When another service of this agent that sends a key already has a rule on a host the form covers, a status line under the website fields warns: "{service} already sends a key to {hosts} for this agent. An exact host wins, then a specific port, then the longest path, then your administrator's services before your own, then the service name alphabetically."
It compares hosts only, lists all the hosts a service shares, skips `restrict_only` services and rules that send nothing, skips the service being edited, and shows on the personal page only, because the dashboard has no per-agent listing to compare with.

On save, the service is written first and the key second, and a key is only sent when one was typed.
If the service fails to save, no key is sent for it.
If the key fails after the service saved, the editor says "The service was saved, but its key was not: {reason}. Paste the key again and save to retry.", keeps the service, locks its name, and stays open; the retry does not write the service again when nothing changed.
Errors show beside their field, and the first invalid field gets focus.

**More options** holds everything else: display name, description, path prefix, port, extra rules, **Replace the preset's rules with my own**, **Refuse other paths on these hosts** (`restrict_to_rules`), the account login, and the placeholder variables.
A new custom service saved with an empty display name gets its website as typed, lowercased, as its display name (`httpbin.org`), not a title-cased name, and the field's hint reads "Leave empty to use {host}." (a preset's reads "Leave empty to use {preset name}."). A preset service and a service being edited keep what they have, so an edited custom service has no such hint.
The account login (`oauth_provider`) is an "Account login (optional)" select, only for a **Custom** service. Its options are "No account login" and the providers the presets routes return in `oauth_providers`, and a login the service already has that the server does not list stays selectable; without `oauth_providers` it offers only "No account login". With a preset that has a provider, a line of text says "Users can connect an account ({provider}) instead of an API key.", and a preset without one shows nothing.
For a shared or unscoped agent, which cannot use personal accounts in a user service (see [User services](#user-services)), the field is disabled and empty with the hint "Accounts cannot be connected on a shared agent. Use an API key.", and a preset's line reads "Accounts cannot be connected on a shared agent, so this service uses an API key."
The **Limit to repositories** helper described in [Limiting paths and repositories](#limiting-paths-and-repositories) sits between the basic fields and **More options**, and shows only for a GitHub service.
The restriction's help reads: "Requests to these hosts whose path matches none of your rules are refused (path_not_allowed) instead of being sent without a key. This also limits services from your administrator on these hosts, {scope}. The real boundary is the key itself, so scope it as narrowly as the website allows." The {scope} part follows the scope that holds the service: "for this agent only" on a `user_agent` agent, "for all your agents that share your personal workspace" on a `user` agent, and "for everyone using this agent" on a shared or unscoped agent. The dashboard editor leaves the whole sentence out. On GitHub hosts it adds: "GraphQL (/graphql) is refused unless listed, and a listed GraphQL rule reaches every repository the key can reach. Use a fine-grained token or a GitHub App installed on selected repositories."

Rules you write next to a preset replace the preset's rules as a whole, which the form says when you tick **Replace the preset's rules with my own**.
The preset dropdown comes from the presets routes (`GET /api/connections/egress/presets` and `GET /api/egress-broker/presets`), so it always lists the presets this MindRoom version knows.
Both return the presets as the config model expands them:

```json
{
  "presets": [
    {
      "id": "github",
      "display_name": "GitHub",
      "description": "GitHub API, gh CLI, and git over HTTPS",
      "oauth_provider": "github",
      "rules": [{"host": "api.github.com", "port": null, "path_prefix": "/"}],
      "placeholder_env": {"GH_TOKEN": "mindroom-brokered", "GITHUB_TOKEN": "mindroom-brokered"}
    }
  ],
  "oauth_providers": [{"id": "github", "display_name": "GitHub"}],
  "validation": {
    "max_rules_per_service": 50,
    "max_service_bytes": 16384,
    "placeholder": {
      "name_pattern": "[A-Z][A-Z0-9_]*",
      "credential_words": ["TOKEN", "KEY", "SECRET", "PASSWORD", "PAT", "AUTH", "CREDENTIAL"],
      "refused_words": ["COMMAND", "CMD", "FILE", "DIR", "PROVIDER", "HELPER", "OPTS", "OPTIONS", "EXTENSIONS"],
      "refused_prefix": "SSH_",
      "reserved_names": ["ALL_PROXY", "HOME", "PATH", "SSL_CERT_FILE"],
      "reserved_prefixes": ["GIT_CONFIG_", "MINDROOM_"],
      "value_pattern": "[A-Za-z0-9._:-]{1,256}",
      "value_max_length": 256
    }
  }
}
```

The example is abbreviated to one preset, one rule, one provider, and a few of the `reserved_names`.
Rules carry no auth settings, and `display_name` falls back to the preset id.
`oauth_providers` lists the OAuth providers a service's account login can name, in registry order: the registry that a saved service's `oauth_provider` is checked against.
`validation` is the one source of the [user service](#user-services) caps and placeholder rules the server enforces: the number of rules and the size of one service, and for placeholders the pattern a name must match completely, the credential words it needs, the words and prefix it may not have, the reserved names and prefixes, and the pattern a value must match completely.
The word lists keep the order the server's messages list them in, and the other lists are sorted, so an editor can show the server's own texts without a copy of the rules.
The editor checks what it can before saving, and shows the server's message for the rest (a name that is taken, a cap, or a rule the server refuses).
On the personal page the placeholder fields check the user-service rules from [User services](#user-services) (the name and value patterns and the refused words) after the first save attempt, and live from then on, and the hint under them lists those rules, so a placeholder the server would reject is flagged before saving.
The hint also says "Placeholders are set only while this service has a key or a connected account.", matching [Placeholder environment](#custom-services).

### The limit editor

The same editor opens in limit mode for a [`restrict_only` service](#limiting-in-place), from **Limit to repositories** (new) or **Change limit** (an existing limit). It is titled "Limit to repositories" or "Change limit", and has:

- **Name**: `github-limited` (or the first free `github-limited-N`) for a new limit, fixed when changing one.
- **Repositories**: the GitHub helper with its **GraphQL** choice, and no **Use these repositories** button, because **Save limit** applies the list. It has no **uploads.github.com** choice: a limit always limits that host to the same repositories. An empty list says "Enter at least one repository, such as owner/repo", and the usual caps on a service's rules (50) and size (16 KiB) apply, so a limit holds at most 12 `owner/repo` lines (4 rules each) or 16 `owner/*` lines (3 rules each).
- On a personal agent, the sentence that says whose services the limit also narrows: "This also limits services from your administrator on these hosts, {scope}."

It has no preset, website, send, key, or **More options** fields: a limit never has a key, and **Save limit** never sends one.
Saving writes `{display_name, description, rules, restrict_to_rules: true, restrict_only: true}` with rules that carry no `auth`, and the labels "GitHub ({repos})" and "Limited to {repos}" follow the list unless you wrote your own.
Changing a limit reads the repositories and the GraphQL choice back from its rules. When the stored rules are not exactly what the helper writes, the editor warns "Some rules of this limit are not repositories from the list. Changing the list replaces them.", and saving without changing anything writes the stored rules back untouched.
**Remove limit** asks first and says what it gives back, by scope: "This removes the limit. {who} can then reach every repository the key or connected account allows." Here `{who}` is "Your {agent}" for `user_agent`, "All your agents that share your personal workspace ({agents})" for `user`, "Everyone using {agent}" for a shared agent, and "Every agent without a scope" for an unscoped one.

On the personal page's rows:

- The administrator's GitHub row shows "Limited to {repos}" with **Change limit** and **Remove limit** once the user has a limit that shares one of its hosts, and offers **Limit to repositories** only until then. When the limit allows GraphQL, the line reads "Limited to {repos} (plus GraphQL, which reaches every repository the key can reach)".
- The limit is also a row of its own under "Added by you" (or "Added by its credential managers"), with a "Limit only" badge, "Limits requests to {hosts}", and the same two actions. It has no status badge or key controls.
- While one change is being written, every limit action on the page is disabled, so one limit shown in two rows cannot be removed twice.

## Connections pages

Users see two pages: the Connections portal at `/connections` (their agents, tools, and account cards) and the personal egress page at `/connections/egress` (titled "Agent Keys").
Both need [trusted upstream auth](trusted-upstream-auth.md) with JWT, as described under [Connecting an account](#connecting-an-account).

**Identity and navigation.** Both pages show "Signed in as {matrix_user_id}" and link to each other, as "Agents" (`/connections`) and "Agent Keys" (`/connections/egress`).
Administrators also get a "Dashboard" link to `/`.
The identity comes from `GET /api/connections/me`; when that request fails, the identity line and the "Dashboard" link are left out, and the portal also leaves out the "Agent Keys" link.
With the portal enabled (`MINDROOM_CONNECTIONS_AGENT` set), a user who is not an administrator and opens a dashboard page is redirected to `/connections?notice=admin-only`, which says why (see [Connecting an account](#connecting-an-account)).

**Intro.** The personal page opens with one line: "Connect accounts or add API keys; MindRoom adds them to your agents' requests and your agents never get the keys themselves." A **How this works** disclosure under it (a button that expands in place) holds the full text: "Connect an account or paste an API key for the services below, or add a service of your own. MindRoom stores them and adds them to your agents' requests to the matching websites. Your agents never get the keys themselves, but a website can send a key back in its response (an echo service does), so only add keys for sites you trust. Saved keys cannot be read back."
The caveat is real: the broker returns upstream responses to the worker, so a site that echoes the request (such as `httpbin.org/headers`) hands the key it received back to worker code; see "Choosing auth safely" under [Custom services](#custom-services).

**Grouping and wording.** Under each agent, rows are grouped as "From your administrator" (services from `config.yaml`) and "Added by you" (personal agents) or "Added by its credential managers" (shared agents); empty groups are left out.
A row with a key reads "Key saved {date}" with **Replace key** and **Remove key** (**Set key** when none is saved), and a row's service actions are **Edit service** and **Delete service**.
Under a personal agent's name a line says who uses its keys: "Only you use this agent's keys." for `user_agent`, and "Shared by all your agents in your personal workspace." for `user`. Shared and unscoped agents have the managers note below instead.
Every service row shows a host line under its description, "Sends to {hosts}": the unique hosts of its rules, comma-separated, with a port written as `host:port`.
Muted lines under it say what happens to the key, from the listing's rule summaries (see [Secret management](#secret-management)):

- **How it is sent**: "Sent as a bearer token", "Sent as header {name}", "Sent as query parameter {name}", "Sent with basic auth", or "Sent with a custom header template". A service whose rules differ joins each way once, as "Sent as a bearer token and with basic auth". Nothing shows where the listing carries no summaries or the service sends no key.
- **What the agent sees**: "Your agent sees {VAR}=mindroom-brokered" for each placeholder variable the service sets. A service with no placeholders and no account login reads "Your agent is not told this key exists; mention {hosts} in your request." Neither shows for a limit, or where the listing does not carry `placeholder_names`.
- **While unset**: "While no key is set, requests to {hosts} are refused." This is on every row with neither a key nor an account, an account row included, but not a limit, and it goes once the service has either.

A shared sandbox's refusal hint ("Personal {provider} accounts can't be used by shared agents...") goes once a key is saved, and the status reads "Key saved {date}" then.

**Accessible names.** A button's accessible name starts with its visible text and names the service, so two rows for the same provider never share a name: "Set key for {service}", "Replace key for {service}", "Remove key for {service}", "Limit to repositories for {service}", "Edit service for {service}", "Delete service for {service}", "Disconnect for {service}", "Reset connection for {service}", "Connect {provider} for {service}", "Change limit for {service}", "Remove limit for {service}", and "Use an API key instead for {service}" ("Use an API key instead of the account for {service}" once an account is connected), where {service} is the service's display name.

**Shared agents.** Each shared or unscoped agent has a note under its name, from the listing's `managers`:

- For a user who cannot manage it: "Only {managers} can change keys for this shared agent.", or "Only administrators can change keys for this shared agent." when the list is empty.
- For a manager: "You manage this shared agent's keys. Everyone who uses it shares them."

The shared-account confirmation, the account that every user sees, and the refused personal-account row are described under [Connecting an account](#connecting-an-account) and [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes).

**The agents page.**

- Each agent row reads "{tools} tools / {set} of {total} accounts and keys set". It counts the portal's account services plus the egress services: an account service counts as set when it is connected, and an egress service when it is `configured`.
- Agents follow config declaration order, and no state changes it.
- Search matches agent names and display names, tool names, service display names, egress service names, and the hosts of their rules.
- An agent without an avatar answers 204 from its avatar route (no Matrix account yet, no profile picture, or a picture that is not a usable raster image), so the browser logs no 404. A Matrix failure is still 502, and an agent the user cannot see is 404.
- Below 640 px the Connections tables stack into cards and buttons wrap.

**OAuth popup pages.** The success page and every refusal on `GET /api/oauth/{provider}/authorize` and `/callback` (a provider error, a cancelled authorization, a stale or foreign connect link) render as one styled page with a **Close window** button instead of raw JSON, with the same status as before.
The provider's own `error` is shown only when it is a plain code (lowercase letters and underscores), and a crafted callback link cannot print its own text.
The pages also tell the opener how the flow ended and close themselves after a moment; see [The login popup](#connecting-an-account).

## Personal request log

`GET /api/connections/egress/logs?agent_name=&limit=` returns the caller's own brokered requests, newest first, at most 200.
It returns only rows whose requester is the caller (after human-alias resolution, the identity worker tokens carry), so no query can show another user's rows, with one exception.
When `agent_name` names a shared or unscoped agent that the caller may use and manage (an administrator or one of its `credential_managers`, who also set its keys), it returns every requester's rows for that agent, including rows without a requester.
Rows the agent logged under another worker scope, such as before it became shared, stay visible only to their own requester.
Other users of the agent, any personal (`user` or `user_agent`) agent, even for an administrator, and a request without `agent_name` return only the caller's own rows.
`agent_name` narrows the rows to one agent (an empty value means all), `limit` is clamped to 1 to 200 (default 200), and any other query parameter is a 400.
Administrators keep the full log at `/api/egress-broker/logs`, with `requester` (an exact match on `requester_id`), `agent_name`, `host`, and `service` filters.
On the dashboard, the **Request log** under the **Agent Keys** panel has these columns, in this order, and a **Filter by user** box next to the agent, host, and service filters:

- **Time**, with the request's duration (`duration_ms`, in ms) as the cell's title.
- **User** (`requester_id`).
- **Agent**, as its display name from the configuration, or its id when the configuration has no such agent.
- **Method** and **Host**.
- **Status**, with the broker's error code under it when there is one.
- **Service**.
- **Path**, truncated with its full value as the cell's title.

Each row has `at`, `kind` (`request`, `tunnel`, or `denied`), `scope`, `agent_name`, `requester_id`, `method`, `host`, `path` (without the query string), `service`, `status`, `bytes_up`, `bytes_down`, `duration_ms`, and `code`.
`code` is the `error` value of the JSON body the broker itself answered with, for example `path_not_allowed`, `bad_request`, `method_not_allowed`, `host_mismatch`, `host_not_allowed`, `tls_required`, `destination_blocked`, `credential_not_configured`, `oauth_connection_required`, `oauth_refresh_failed`, `broker_error`, `request_body_too_large`, `upstream_unreachable`, or `upstream_timeout`.
It is `null` when the upstream's response was relayed, and for rows written before the column existed.
A 407 and a malformed request the broker rejects before it can route it write no row.

On the personal egress page each agent has a collapsible **Recent requests** table with the time, method, host, path, service, and status of its latest requests, loaded when you open it (the newest 50 at most), and the broker's error code under the status when there is one.
On a shared or unscoped agent you manage, the table holds everyone's requests: its text reads "The last 50 requests through this agent's sandbox, from everyone who uses it", and a **User** column after **Time** shows each requester's Matrix ID ("-" for a request without one).
The table shows the newest 10, with **Show all ({n})** to list every loaded row and **Show latest 10** to fold them again; the button appears only when there are more than 10.
Codes wrap after an underscore and never clip, on this table and on the dashboard's.
A `CONNECT` row for a host without a service, a tunnel the broker only relayed, reads "Passed through (no key added)" in its service cell, and the table's caption says "Requests to sites without a service pass straight through; MindRoom sees only the host. Administrators can also see these requests (method, host, and path). Only your own requests are shown."
On a shared or unscoped agent the caption says "Administrators and this agent's credential managers can also see these requests (method, host, and path).", and to its managers "Requests from everyone who uses this agent are shown." instead of the last sentence.
While the broker is not running, the table shows the server's "Egress broker is not running" message.

## Agent tool

Add the `egress_credentials` tool to an agent so it can tell a user which keys or accounts are missing when a brokered request fails with `credential_not_configured`.
It replaces `agent_vault_access` for the native broker.

```yaml
agents:
  code:
    tools:
      - shell
      - egress_credentials
```

Its one function, `list_egress_credentials`, takes no arguments and returns JSON:

```json
{
  "tool": "egress_credentials",
  "services": [
    {"name": "github", "display_name": "GitHub", "source": "config", "configured": true, "active_source": "oauth"},
    {
      "name": "gmail",
      "display_name": "Gmail",
      "source": "config",
      "configured": false,
      "active_source": null,
      "can_connect_account": true,
      "provider": "google_gmail"
    },
    {
      "name": "openai",
      "display_name": "OpenAI",
      "source": "user",
      "configured": false,
      "active_source": null,
      "can_connect_account": false,
      "provider": null
    }
  ],
  "manage_url": "https://mindroom.example/connections/egress",
  "note": "..."
}
```

- The tool lists the services the broker matches for the calling scope that take a credential: the services in `config.yaml`, then the user's own [user services](#user-services). `source` says which, `config` or `user`, so the agent can tell the user whether an administrator defined a service or they added it themselves. A [`restrict_only` service](#limiting-in-place) is left out, because it never takes a key and the tool would otherwise report one as missing.
- `configured` is true when the calling agent's scope has either source for the service, and `active_source` says which one the broker uses: `key`, `oauth`, or `null`. An explicit key wins over a connected account. The tool reports the scope the broker uses, so each requester sees only their own keys and, for GitHub and Atlassian, their own account, and an agent with no worker scope reads the global store.
- A service with nothing configured also reports `can_connect_account`. When it is `true`, the user can connect an account instead of adding a key, and `provider` names the OAuth provider id. It is `false` when the service has no account provider, the provider's OAuth client is not set up, a shared service account serves the provider, a stored connection is unreadable and needs a reset first, or the agent runs in a shared sandbox (a shared or unscoped agent, or any agent on the static runner) and the provider is GitHub or Atlassian without `oauth_on_shared_workers`; `provider` is then `null`. A `true` value says the provider can be connected, not that this user may connect it: for providers that are not requester-scoped (the Google providers) on a shared agent, only administrators and credential managers can.
- `display_name` falls back to the service name when the service sets none.
- `manage_url` is the personal egress page when trusted upstream auth is enabled and the dashboard otherwise; it is `null` when `MINDROOM_PUBLIC_URL` is not set, and the note then tells the agent to ask the operator.
- The tool never returns secret values, access tokens, connect links, or update timestamps, and its note tells the agent not to ask users to paste a key into the chat. Users connect accounts and add keys at `manage_url`; the one-time `connect_url` only appears in the broker's HTTP responses to worker code.
- The tool always runs in the primary runtime. When it is built without a worker target, it returns an empty `services` list and a note saying a worker-scoped agent is required.

## Deployment

### Docker workers

Set the environment variables on the primary runtime and open the broker port on `docker0` only so workers can reach it while the host network cannot:

```bash
export MINDROOM_EGRESS_BROKER_PORT=8768
export MINDROOM_EGRESS_BROKER_HOST=0.0.0.0
export MINDROOM_EGRESS_BROKER_URL=http://host.docker.internal:8768
export MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS=604800
```

On the firewall, allow TCP 8768 from `docker0` to the primary:

```bash
# NixOS example (hosts/mindroom/networking.nix)
networking.firewall.interfaces.docker0.allowedTCPPorts = [ 8768 ];
```

Without this firewall rule, workers cannot reach the broker and brokered calls time out.

The broker port must not be published beyond the worker network.
Do not add it to a published ports list in `docker run -p` or Docker Compose `ports:`, because that would let any code on the host network use a leaked token until it expires.

### Static runner

Worker-routed calls on the shared static runner get the same per-call broker environment as dedicated workers.
Set `MINDROOM_EGRESS_BROKER_URL` to an address the runner process can reach; when the runner shares the primary's network, as the hosted sidecar does, that is the loopback address (see [Hosted instances](#hosted-instances-sandbox-runner-sidecar)).
Calls with no worker scope get a token for the unscoped worker key a dedicated backend would give the agent.
The runner is shared across users, so it is not an isolation boundary between the calls it serves, and the broker uses a requester's own GitHub or Atlassian account there only when the service sets `oauth_on_shared_workers`; see [Security Posture](../architecture/security-posture.md#config-and-state-kept-out-of-workers).

### Kubernetes

The broker needs no worker pod changes: the token and CA certificate travel in each call's environment, and worker pods already have a writable `/tmp` for the trust bundle.
Worker images must still come from a release that includes the broker (see [Worker images](#worker-images)).
The primary's storage volume holds broker state under `egress_broker/`, which workers never mount.
The runtime chart runs one primary replica, so there is one broker.
Users without dashboard access get the personal egress page, their own services and keys, their account connections, and their own request log from it, once trusted upstream auth with JWT is set up; see [Self-service for users](https://github.com/mindroom-ai/mindroom/blob/main/cluster/k8s/runtime/README.md#self-service-for-users).

The charts support these topologies:

| Deployment | Worker to broker | Broker to internet |
|------------|------------------|--------------------|
| Runtime chart, no egress proxy | Worker pod to the `<fullname>-egress-broker` Service to the primary pod | Direct from the primary pod |
| Runtime chart with `egressProxy` (operator proxy) | Same, plus an additive worker egress NetworkPolicy for the broker port | Through the operator proxy only when the primary's env sets `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`; otherwise direct (see the warning below) |
| Runtime chart with `approvedEgress` (Squid) | Worker to Squid, which checks the grant by pod IP, then to the broker as Squid's parent | Direct from the primary pod |
| Instance chart (`static_runner` sidecar sharing the primary pod's network) | Sidecar to `127.0.0.1:8768` | Direct |

The first three rows are the runtime chart's two modes.
**Direct mode** (`egressBroker.enabled`, optionally with `egressProxy`) points workers straight at the broker Service.
**Chain mode** (`egressBroker.enabled` together with `approvedEgress.enabled`) keeps Squid as the workers' first hop and renders Squid's parent as the broker.

> [!WARNING]
> **Direct mode with `egressProxy` bypasses the operator proxy unless the primary uses it.**
> Each `shell` and `python` call's broker environment replaces the `HTTP_PROXY` and `HTTPS_PROXY` that `egressProxy.injectWorkerProxyEnv` gives worker pods, so that traffic goes to the broker instead of the operator proxy.
> The broker then dials from the primary pod: matched hosts always, and unmatched hosts too under the default `unmatched_hosts: passthrough`.
> Unless the primary's own environment sets `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`, that traffic leaves the cluster directly instead of through the operator proxy.
> Set the operator proxy on the primary through `env.extra`, or set `egress_broker.unmatched_hosts: deny` so only the configured services' hosts are reached directly.
> The broker connects through the operator proxy to the IP address it validated, so the proxy must allow CONNECT to IP addresses on ports 80 and 443.
> The chart does not enforce either setting yet.

The broker's environment also replaces `NO_PROXY` for `shell` and `python` calls with `localhost,127.0.0.1,::1,.svc,.cluster.local` plus the hosts of the primary's callback URLs (the broker, script gateway, and agent CLI URLs).
Entries from `egressProxy.noProxy` or a worker `NO_PROXY` no longer apply to those calls, so requests to other internal hosts go to the broker (through Squid in chain mode), which refuses private addresses with 403 `destination_blocked`.

```yaml
workers:
  backend: kubernetes

egressBroker:
  enabled: true
  port: 8768
  tokenTtlSeconds: ""
```

When `egressBroker.enabled` is true, the chart:

- Exposes an `egress-broker` port on the primary and sets `MINDROOM_EGRESS_BROKER_PORT`, `MINDROOM_EGRESS_BROKER_HOST=0.0.0.0`, and `MINDROOM_EGRESS_BROKER_URL`, plus `MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS` when `egressBroker.tokenTtlSeconds` is set.
- Creates a ClusterIP Service named `<fullname>-egress-broker` that selects the primary.
- Creates, when `networkPolicy.create` is true, an ingress NetworkPolicy on the primary for the broker port: from worker pods in direct mode, from the approved egress pods in chain mode.
- Adds, in direct mode only and only when the chart's worker egress NetworkPolicy exists, a worker egress rule to the broker port. Without that policy workers already have unrestricted egress and need no rule.

In chain mode `MINDROOM_EGRESS_BROKER_URL` is Squid's URL, because workers keep sending their traffic to Squid, which still enforces grants.
Requests that carry the worker's broker token in `Proxy-Authorization` go on to the broker, requests without a token go directly to the internet, and `approvedEgress.parentProxy.bypassDomains` skip the parent.
The chart renders that chain itself, so `approvedEgress.parentProxy.enabled` is not needed.
The broker checks the token and injects the secret, and it re-validates the destination address when it dials, so a DNS change after Squid's check cannot reach private addresses.
See [Approved Egress](approved-egress.md#egress-broker-chaining).

The chart refuses to render when:

- `workers.backend` is not `kubernetes`.
- `workers.kubernetes.agentVault.enabled` is also true.
- `egressBroker.port` equals `runtime.apiPort` or `scriptGateway.port`.
- `approvedEgress.parentProxy.enabled` names a host other than the default while the broker is enabled, so a custom parent is never dropped silently.

If `networkPolicy.extraEgress` restricts the primary, allow TCP 80 and 443 to public addresses yourself, because the chart cannot infer that rule.
The broker shares the primary's lifecycle: a primary restart interrupts brokered connections in flight, and brokered TLS uses primary CPU, so leave room in the primary's resource requests.

#### Hosted instances (sandbox-runner sidecar)

The instance chart that the SaaS platform deploys runs tool code in a `static_runner` sidecar that shares the primary pod's network.
Set `egressBroker.enabled: true` and the chart sets `MINDROOM_EGRESS_BROKER_PORT=8768`, `MINDROOM_EGRESS_BROKER_HOST=127.0.0.1`, and `MINDROOM_EGRESS_BROKER_URL=http://127.0.0.1:8768` on the primary container and on nothing else.
The broker binds loopback, so the sidecar reaches it without a Service or NetworkPolicy, and nothing outside the pod can.
Tenant secrets are then managed on the dashboard or the personal egress page like any other deployment.
The sidecar is a static runner, so personal GitHub and Atlassian accounts there need `oauth_on_shared_workers` on the service (see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes)).
The chart default is off, and the platform provisioner does not forward `egressBroker.enabled` yet.
It runs `helm upgrade --install` with a fixed set of values and no `--reuse-values`, and every release deploy re-provisions all tenants, so a value set by hand (for example `--set egressBroker.enabled=true`) is overwritten by the next provision and brokered secrets then silently stop being injected.
Until the provisioner forwards the value, which is a follow-up, treat a hand-set value as for testing only.
The primary image must also include the broker, so it takes effect with a SaaS release.

### Worker images

Worker and runner images must come from the same release as the primary, or at least one that includes the broker.
Older runners ignore `MINDROOM_EGRESS_BROKER_CA_PEM`, so they never install the broker's CA: requests to matched hosts then fail TLS verification and no secret is sent, while unmatched passthrough hosts keep working.
Upgrade the worker image together with the primary; on the LXC host that means rebuilding `mindroom:dev` after pulling the checkout.

### Background-script workers

Background-script workers do not yet receive the broker environment.
This gap will close after dedicated worker coverage stabilizes.

## Error responses

Every JSON refusal the broker writes has a `message`: a plain sentence that an agent can relay to its user, next to the machine-readable `error` code.
Messages name only the service, the provider, the host, the path (without its query string), and the Matrix IDs of credential managers, and never a secret, token, query string, or connect link.
Links travel in their own fields, `connect_url` and `manage_url`, which the messages point to by name.
`manage_url` is `null` when `MINDROOM_PUBLIC_URL` is not set.

**Transport of a refusal.** The JSON body is not the only place a refusal says what happened, because many clients print only the status line:

- **`X-MindRoom-Error` header.** Every refusal the broker writes carries `X-MindRoom-Error: <code>`, the same `error` value as the body, so a client can tell a broker refusal from an upstream's own error without reading the body. The broker removes the header from every upstream response it relays, in an intercepted tunnel and on plain HTTP, so an upstream cannot pass its own response off as a refusal. A tunnel to a host without rules is passed through unread, so a response inside it reaches the client as the upstream sent it.
- **Reason phrase.** The HTTP reason phrase is the message: printable ASCII, with CR and LF removed and any other character replaced by `?`, cut to 200 characters. Clients that print the reason phrase, such as Python `urllib` (`HTTP Error 403: <reason>`), show the message even when the code never reads the body. The 407 challenge keeps its `Proxy-Authenticate` header and gets the same reason.
- **git smart HTTP.** `git` reads only the status line of a failed request, so a refused discovery request (`GET .../info/refs?service=git-upload-pack` or `git-receive-pack`) from a git client (a `User-Agent` starting with `git/`, or any `Git-Protocol` header) gets a 200 with `Content-Type: application/x-<service>-advertisement` and the pkt-lines `# service=<service>`, a flush, and `ERR <message>`, so git prints `remote error: <message>`. Other clients, and every other request, get the normal JSON refusal. The audit row keeps the refusal's own status (for example 403) and code, not the 200.
  - The `ERR` message names the real link: `manage_url`, and `connect_url` where the message offers it, are replaced by the body's `manage_url` value, because git shows no other field. The `connect_url` itself, with its one-time token, never appears in the line. Without a manage link (`MINDROOM_PUBLIC_URL` unset) the text is unchanged.
  - The line is cut at 4096 characters, and non-ASCII characters become `?`.
  - A 407 stays a 407 for git: git's HTTP client answers the challenge with the proxy credentials.

The broker returns these errors to worker code:

| Condition | Response |
|-----------|----------|
| Missing or invalid proxy token | 407 with a `Proxy-Authenticate: Basic` challenge and JSON `{"error": "proxy_authentication_required", "message": "..."}` |
| Expired token | The same 407, including on each request inside an already-open intercepted tunnel; only websocket splices and raw (unmatched-host) tunnels that were already open continue until closed |
| Plain HTTP request matching a rule | 403 JSON `{"error": "tls_required", "service": "<name>", "message": "..."}` |
| `Host` header inside an intercepted tunnel naming a different host than the CONNECT target | 403 JSON `{"error": "host_mismatch", "message": "..."}` |
| Client TLS server name (SNI) that differs from the CONNECT host | No response: the TLS handshake is aborted with an `unrecognized_name` alert, and nothing is forwarded |
| Websocket upgrade inside a tunnel on a request that has both `Content-Length` and `Transfer-Encoding` | 400 JSON `{"error": "bad_request", "message": "..."}` with the malformed-request text |
| Request the broker cannot read: an invalid CONNECT target, a CONNECT with a body or with bytes sent before its answer, an invalid absolute URL on a plain HTTP request, a non-origin-form request target (absolute, authority, or asterisk form) inside an intercepted tunnel, or an HTTP protocol error | 400 JSON `{"error": "bad_request", "message": "..."}` with the malformed-request text (431 for a request head over 64 KiB, however it is split across reads) |
| Path on a host with rules with empty segments or raw backslashes, or with a dot segment, NUL, or invalid UTF-8 in it or any percent-decoded form of it | 400 JSON `{"error": "bad_request", "message": "..."}` with the ambiguous-path text |
| `TRACE` or `TRACK` request (any letter case) to a host with rules, inside an intercepted tunnel or over plain HTTP, refused before any key is looked up | 405 JSON `{"error": "method_not_allowed", "message": "..."}`; the upstream would echo the injected credential back |
| Path that fails a restriction (see [Limiting paths and repositories](#limiting-paths-and-repositories)) | 403 JSON `{"error": "path_not_allowed", "service": "<restricting service>", "manage_url": "<link>", "message": "..."}`; the message names the service by its display name |
| Destination fails dial guard (private/metadata/link-local) | 403 JSON `{"error": "destination_blocked", "message": "..."}` |
| Unmatched host under `deny` policy | 403 JSON `{"error": "host_not_allowed", "services": [...], "message": "..."}` with the operator's service names as a hint |
| Matched service, no key and no connected account in scope | 403 JSON `{"error": "credential_not_configured", "service": "<name>", "manage_url": "<link>", "message": "..."}`, plus `"provider": "<id>"` and `"connect_url": "<link>"` when the service's account provider is connectable and the broker may hand out a link (never for a connection that everyone using a shared agent shares; a requester's own GitHub or Atlassian account under `oauth_on_shared_workers` does get one). The link still requires its opener to be allowed to connect that account |
| Connected account revoked, rejected by the provider, or unreadable | 403 JSON `{"error": "oauth_connection_required", "service": "<name>", "provider": "<id>", "connect_url": "<link>", "manage_url": "<link>", "message": "..."}`; `connect_url` is `null` for a shared scope, and an unreadable stored credential adds `"reset_required": true` and has a `null` `connect_url` until it is reset |
| Provider outage, timeout, or network failure while refreshing the account's token | 503 JSON `{"error": "oauth_refresh_failed", "service": "<name>", "provider": "<id>", "manage_url": "<link>", "message": "..."}`; retry later, do not reconnect |
| Unresolvable destination, or upstream connect or TLS failure | 502 JSON `{"error": "upstream_unreachable", "message": "..."}` |
| Broker internal error or secret resolution failure | 502 JSON `{"error": "broker_error", "message": "..."}` |
| Request body over 1 GiB | 413 JSON `{"error": "request_body_too_large", "message": "..."}` |
| Upstream timeout | 504 JSON `{"error": "upstream_timeout", "message": "..."}` (connect timeout 10s, idle read timeout 30 minutes for long streams) |

The `path_not_allowed` `service` is the restricting service whose name sorts first, of the party whose check failed (the administrator's, checked first, or the requester's own).
`oauth_connection_required` carries both `connect_url` and `manage_url`, because its message names both, and `connect_url` can be `null` where `manage_url` is the way to reconnect. `oauth_refresh_failed` carries only `manage_url`, which its message names.

The messages, with `{service}` (the service's display name, or its name when it has none), `{provider}`, `{host}`, `{path}`, and `{managers}` filled in (the managers' Matrix IDs, joined with ", "):

| `error` | `message` |
|---------|-----------|
| `credential_not_configured`, connectable | "No {service} credential is set for this agent. Ask the user to connect it at connect_url or add a key at manage_url, then retry." |
| `credential_not_configured`, key only | "No {service} key is set for this agent. Ask the user to add one at manage_url, then retry." |
| `credential_not_configured`, shared or unscoped agent, no connect link | "No {service} key is set for this shared agent. Only its credential managers ({managers}) can add one, at manage_url." With no managers: "No {service} key is set for this shared agent. Only an administrator can add one, at manage_url." |
| `oauth_connection_required` | "The {provider} account for {service} must be connected again. Ask the user to reconnect at connect_url or manage_url." |
| `oauth_refresh_failed` | "{provider} did not refresh the account token. Retry in a minute; if it keeps failing, ask the user to reconnect at manage_url." |
| `path_not_allowed`, personal agent, limit set by the agent's own services | "{host}{path} is outside the paths {service} allows for this agent. Ask the user to add it at manage_url if the agent needs it." |
| `path_not_allowed`, shared or unscoped agent, limit set by the agent's own services | "{host}{path} is outside the paths {service} allows for this agent. Only its credential managers ({managers}) can change this, at manage_url." |
| `path_not_allowed`, limit set by the administrator's service on any agent, or a shared or unscoped agent with no managers | "{host}{path} is outside the paths {service} allows for this agent. Only an administrator can change this, at manage_url." |
| `bad_request`, ambiguous path | "The request path is ambiguous (dot segments, //, backslashes, or encoded forms of them) and was refused. Use a plain path." |
| `bad_request`, malformed request | "The request is malformed and was refused." |
| `method_not_allowed` | "TRACE and TRACK requests are refused because the server would echo the request, injected credential included, back to the agent." |
| `tls_required` | "Credentials are only added over HTTPS. Use https:// for {host}." |
| `host_mismatch` | "The Host header does not match the host this connection was opened for." |
| `host_not_allowed` | "{host} is not allowed by the administrator's egress policy." |
| `destination_blocked` | "{host} resolves to a private or internal address, which agents may not reach." |
| `request_body_too_large` | "The request body is larger than the broker accepts." |
| `upstream_unreachable` | "{host} could not be reached." |
| `upstream_timeout` | "{host} did not answer in time." |
| `broker_error` | "The credential broker hit an internal error. Retry; if it keeps failing, tell an administrator." |
| `proxy_authentication_required` | "The sandbox's proxy credentials are missing or expired. Start a new tool call." |

The `path_not_allowed` text names who can change the restricting service. When it is the administrator's, which neither the user nor the managers can edit, it names an administrator on every agent, personal ones included. For a limit that the agent's own services set, a personal agent's text tells the user to add the path, and a shared or unscoped agent's names its managers, or an administrator when it has none.
The connectable text wins over the shared one: when the response carries a `connect_url`, the message offers it, even on a shared or unscoped agent (a requester's own account that `oauth_on_shared_workers` allows there). The shared text is for a shared or unscoped agent whose response has no link, and its managers are read from the agent's `credential_managers` in the primary's current config.
The managers' Matrix IDs appear in no other broker response.

A 503 `oauth_refresh_failed` backs off per credential store: for 30 seconds after a failed refresh, further requests for that store get the same 503 without calling the provider again.
The `connect_url` values are short-lived, single-use connect links, so treat the response bodies as sensitive and do not log them.

The broker never logs header values, request bodies, query strings, tokens, connect links, or secrets.
Audit records include timestamps, worker scope, agent name, requester ID, method, host, path (without query string), service name, status code, the broker's error code (when it answered with one), bytes transferred, and duration.

## Verified behaviors

The following are tested and intentional:

- Only `Upgrade: websocket` is spliced; after a 101 response the broker forwards frames without inspecting them.
- Plain HTTP requests that match a rule get 403 `tls_required` and are never injected, because the secret would travel unencrypted.
- Inside an intercepted HTTPS tunnel, a `Host` header that names a different host than the CONNECT target gets 403 `host_mismatch` to prevent secrets from being sent to the wrong destination. Non-origin-form request targets are rejected with 400 `bad_request`.
- Routing uses the CONNECT target host and port only, never the `Host` header, so a replaced `Host` header cannot redirect the secret.
- Redirects are returned to the client without following them; a redirect to a new host requires a new CONNECT and a new match.
- The client's value for the slot the broker injects into (such as `Authorization`) is always removed before injection.
- An explicit API key wins over a connected account, and removing the key falls back to the account.
- Connected-account tokens are refreshed only through MindRoom's OAuth credential lifecycle, formatted by the matched rule's auth type, and never leave the primary. Shared service accounts are never injected.
- Expired or invalid tokens get 407 on new requests and on requests inside an already-open tunnel, but websocket splices and raw tunnels that started before the token expired keep running until the connection closes.
- A user's `restrict_to_rules` limits the administrator's services on its hosts for its own scope, and never opens a path that an administrator's restriction refuses.
- A `restrict_only` service limits paths without ever choosing a credential or taking a key, so the administrator's service keeps sending the user's own account or key for the paths it allows.
- Every refusal carries `X-MindRoom-Error` and a reason phrase that is its message, and a git client's refused discovery request shows it as `remote error: <message>` with the real manage link, never the connect link.
- A request head over 64 KiB gets 431. A request with both `Content-Length` and `Transfer-Encoding` is forwarded chunked only, and its connection closes after the response.
- An intercepted tunnel drops a reused upstream connection that sent stray bytes or closed, so a response is never read for the wrong request.
- A client SNI that differs from the CONNECT host aborts the handshake before any request is read.
- Paths that look like dot segments only after Unicode folding (`‥`, fullwidth `．．`) are refused like `..`.
- Python `urllib` and curl authenticate against the broker with the proxy URL from a worker's broker environment, because its password is not empty.
- Dedicated Docker and Kubernetes workers and the static runner get the broker environment; background-script workers do not yet.

## Migrating from Agent Vault

If you are currently using Agent Vault (the Go-based proxy fork) on the LXC host or in a Kubernetes deployment, follow these steps to migrate to the native broker.
A deployment uses either Agent Vault or Agent Keys, never both, so the switch is one change that turns the broker on and Agent Vault off.
Keys can only be entered once the broker is on, and the secrets stored in Agent Vault do not carry over, so users enter their keys after the switch.
Until they do, a brokered call answers 403 `credential_not_configured`, and its message says where to add the key.

### LXC (Docker workers)

Apply steps 1 to 5 as one change, so Agent Vault stops serving when the broker starts:

1. Add the egress broker environment variables to the MindRoom service configuration (such as `optional/mindroom-runtime-services.nix`), set `MINDROOM_EGRESS_BROKER_PORT=8768`, `MINDROOM_EGRESS_BROKER_HOST=0.0.0.0`, `MINDROOM_EGRESS_BROKER_URL=http://host.docker.internal:8768`.
2. Open port 8768 on `docker0` in the host firewall configuration (such as `hosts/mindroom/networking.nix`).
3. Rebuild the worker image from the updated checkout so workers install the broker's CA: `cd /srv/mindroom && docker build -t mindroom:dev -f local/instances/deploy/Dockerfile.mindroom .`
4. Add the `github` service (or other services you use) to `~/.mindroom-chat/config.yaml` under `egress_broker.services`, for example `github: {preset: github}`.
5. Remove the `agent-vault-bridge` plugin from config.
6. Set the secrets or connect accounts in the dashboard's **Agent Keys** panel on the Credentials page. The personal egress page needs trusted upstream auth with JWT, which a lab host without an upstream proxy does not have.
7. Verify the broker works by running a worker command that uses a brokered service (such as `gh pr list` or `git clone` of a private repository) and checking that the request succeeds, the audit log records it, and the worker environment and workspace contain no trace of the token.
8. Remove the Agent Vault CA pin from the NixOS configuration.
9. Stop the `agent-vault` compose stack on the `nas` host after a grace period.

### Kubernetes

1. Add the services to the deployment's `config.yaml` under `egress_broker.services`.
2. Run one `helm upgrade` that sets `egressBroker.enabled=true` and `workers.kubernetes.agentVault.enabled=false`. The chart refuses both being on at once. If approved egress is on, the chart rewires Squid's parent from Agent Vault to the broker in the same upgrade.
3. Have users and credential managers enter their keys or connect their accounts on `/connections/egress` or the dashboard.
4. Verify against real workers: a brokered call succeeds, the audit log records it, and `env` and `/proc/self/environ` hold only the placeholder values and the per-call proxy token, never a secret. Replaying the proxy URL after the token TTL returns 407.
5. Delete the Agent Vault bootstrap Secret and PVC after a grace period.

What replaces each Agent Vault piece:

| Agent Vault piece | Native replacement |
|-------------------|--------------------|
| Agent Vault server Deployment, PVC, bootstrap Job, owner and master password Secret | None; the broker runs in the primary |
| Init container minting a per-worker proxy token | Per-call token from the primary in the call's environment |
| Vault per worker key | Primary-only credential store per worker scope, with the same granularity |
| CA ConfigMap mounted at `/etc/agent-vault/ca.pem` | CA certificate in the call's environment; the runner writes the trust bundle to `/tmp` |
| `agent_vault_access` tool and Agent Vault accounts | Personal egress page (API keys and connected accounts) and the `egress_credentials` tool |
| `accessGrants` Job | `administrators` and `agents.<name>.credential_managers` in config |
| `approvedEgress.parentProxy.host: agent-vault`, port 14322 | Rendered automatically as the broker Service and port |

Hosted instances never had Agent Vault, so they have nothing to migrate and only gain brokered credentials.

## What the broker cannot protect against

The broker keeps keys out of worker code.
It cannot help where the code runs outside a worker, where the configuration or the remote host gives a key away, or where the key itself is too powerful.
Each of these is a choice you make, so make it on purpose.

- **Code in the primary process.** An agent whose code runs in the primary process can read every stored key and token. That is the case when no sandbox runner or dedicated worker is configured, so tools run in the primary process (the default when `MINDROOM_SANDBOX_PROXY_URL` is unset), with `MINDROOM_SANDBOX_EXECUTION_MODE` set to `off`, `local`, or `disabled`, with a `MINDROOM_SANDBOX_PROXY_TOOLS` list that leaves a tool out (unless the mode is `all`), with `worker_tools: []`, and with primary-only tools such as `duckdb`, `pandas`, `sql`, and `script`. Path tools that run in the primary process, such as `attachments` or `gmail`, can also open any file the primary can reach under `file_access: unrestricted`. Use a dedicated worker backend or a sandbox runner, keep `file_access` at `workspace`, and keep such tools off agents that should not see secrets.
- **Write access to the configuration.** `config_manager`, and any other way to write the `egress_broker` config, can point a service at another host, and the broker then sends that service's key there. Give config write access only to people and agents you would trust with every key.
- **Hosts that echo requests.** A host that sends the request back to the caller, such as a debug page or an error message with the full URL, hands the injected key to the agent. The broker refuses `TRACE` and `TRACK`, which exist to do this, but it cannot see what other pages do. Prefer header or bearer auth over query-parameter keys, and add keys only for hosts you trust not to echo them.
- **Wildcard rules on shared hosting domains.** A rule such as `*.github.io`, `*.vercel.app`, or `*.workers.dev` sends the key to every tenant on that domain, including a page that someone else publishes there. Name exact hosts instead.
- **Keys that can create other keys.** With an admin token or a deploy-key API, the agent can ask the service for a new working key and keep it, and that key no longer needs the broker. Store the least powerful key that works.
- **Shared workspaces.** On a `user` or `user_agent` agent that is not `private`, one requester's files can run in another requester's commands and use that requester's accounts and keys. Make such agents `private` when requesters need isolation (`private.per` replaces `worker_scope`). Accounts and personal keys belong to the requester, so every personal agent that other requesters can use must be `private`, not only the most sensitive one; see [Shared workspaces on non-private agents](#shared-workspaces-on-non-private-agents).

## Limitations

The broker has these known limits in the initial release:

- **HTTP/1.1 only:** the broker speaks HTTP/1.1 to clients and upstreams; HTTP/2 and HTTP/3 are not supported. Most agent workloads (curl, git, Python requests, Go http) use HTTP/1.1 by default or fall back to it.
- **Service accounts are not injected:** a Google provider served by `GOOGLE_SERVICE_ACCOUNT_FILE` cannot supply the broker's secret, so such a service needs an API key.
- **No body or websocket frame substitutions:** the broker injects into headers and query parameters only; path, body, and websocket frame substitutions planned for a later release.
- **Background-script workers not yet covered:** the broker environment reaches dedicated Docker and Kubernetes workers and the static runner; background-script workers are not yet wired.
- **Shared static runner is not an isolation boundary:** a scoped call's token lives in a process shared with other users' calls, valid for the token TTL, so keep the TTL short where that matters and use dedicated `user` or `user_agent` workers on `private` agents for isolation. A dedicated `shared` or unscoped worker does not isolate requesters either. For the same reason personal GitHub and Atlassian accounts are not used on the static runner unless the service sets `oauth_on_shared_workers`.
- **Streamed request bodies:** the broker forwards a valid request head to the right upstream before it has read the body, so a body that turns out to be invalid or over the limit gets 400 or 413 after the upstream has already seen the head. The upstream then sees a partial request and a reset, and the head carries the injected secret to the host the request was routed to, as any request would.
- **Not yet independently reviewed:** the transport code was tested with a smuggling corpus and property-based fuzzing, but no human or automated adversarial review of it has been done; see [Testing and review](../architecture/security-posture.md#testing-and-review-of-the-egress-broker).
- **Broker approvals stay with Squid:** the broker does not enforce approved-egress grants itself; in the Kubernetes chain Squid does, and the broker takes Agent Vault's place as its parent.

## Troubleshooting

**Workers time out when calling brokered services:**

Check that the broker port is open on the interface workers reach it through (`docker0` for Docker workers, the broker Service for Kubernetes workers).
Verify with `curl -v -x "$HTTPS_PROXY" https://example.com` from an agent's `shell` tool call, whose environment carries the broker URL and token.
A shell opened with `docker exec` does not have that per-call environment.

**403 `credential_not_configured` errors:**

The service is matched but the worker's scope has neither an API key nor a connected account for it.
Connect an account (when the response has `provider` and `connect_url`) or set a key through the dashboard or, where trusted upstream auth is enabled, the personal egress page; the error response includes a `manage_url` field pointing to the right UI.
The response's `message` says who can fix it: the user, or, on a shared or unscoped agent, its credential managers (named by Matrix ID) or an administrator.
Agents with the [`egress_credentials` tool](#agent-tool) can look up which services are set, whether an account can be connected, and relay the link to the user.

**403 `oauth_connection_required` errors:**

The account for that scope was revoked at the provider or its credential cannot be read.
Reconnect through `connect_url`, or on the egress page when the response has no link (a shared agent).
When the response has `reset_required`, reset the provider connection first, with the service row's **Reset connection** button on the egress page or the dashboard panel, or from the dashboard Tools tab, because MindRoom cannot read the stored credential.
Alternatively set an API key for the service, which takes priority over the account.

**503 `oauth_refresh_failed` errors:**

The provider's token endpoint failed or timed out while the broker refreshed the account's token, so the account itself is still connected.
Retry the request later; reconnecting does not help.
The broker answers further requests for the same credential store with 503 for 30 seconds before trying the provider again, and logs only the service, the provider id, and the error type.

**A connected account does not take effect:**

Check that the service has an `oauth_provider` (presets set it) and that the id exists in the OAuth registry; an unknown id logs a warning naming the service and leaves the service on API keys only.
An API key stored for the scope wins over the account, so remove the key to use the account.
A provider served by a shared service account shows "Uses a shared service account" and is never injected.
A GitHub or Atlassian account is not used in a shared sandbox (a shared or unscoped agent, or any agent on the static runner) unless the service sets `oauth_on_shared_workers`; see [Personal accounts and shared sandboxes](#personal-accounts-and-shared-sandboxes).

**403 `path_not_allowed` errors:**

A service on that host sets `restrict_to_rules` and no rule of that party lists the path.
The body's `service` names the restricting service, and it can be the user's own limit (such as `github-limited`, a [`restrict_only` service](#limiting-in-place)) as well as an administrator's service: a user's restriction also limits the administrator's services on its hosts, for its own scope. The message names it by its display name and says who can change it: an administrator for the administrator's service, otherwise the user or, on a shared agent, its credential managers.
Add a rule to that service whose `path_prefix` covers the path (a prefix such as `/repos/owner/repo` covers that path and everything below it), or turn its restriction off or delete it. For a limit, use **Change limit** or **Remove limit** on the personal page.
GraphQL (`/graphql`) needs a rule of its own, and a user service cannot list a path that an operator's `restrict_to_rules` refuses.

**400 `bad_request` on a path:**

The host has rules and the path has an empty segment (`//`), a backslash, a dot segment (also percent-encoded, `..;x`, `..%3f`, or whitespace-padded), a NUL, or invalid UTF-8.
Send the normalized path; the broker refuses ambiguous paths instead of guessing how the upstream reads them.

**431 `bad_request` on a request:**

The request head, from the request line through the blank line, is over 64 KiB, however the client split it.
Shorten the headers (a huge `Cookie` or custom header is the usual cause).

**A TLS handshake to the broker fails for one host:**

The client sent an SNI that differs from the CONNECT host, which the broker aborts with an `unrecognized_name` alert.
Use the same name in the CONNECT target and the TLS server name. Clients that send no SNI (for an IP address) are served.

**An agent only sees the status line of a refusal:**

Every refusal carries `X-MindRoom-Error: <code>` and a reason phrase that is its message, and git prints `remote error: <message>` for a refused clone or fetch; see [Error responses](#error-responses).

**407 authentication errors:**

The worker's token is missing, invalid, or expired, and the response's `message` says to start a new tool call.
This should not happen for normal tool calls because the primary mints a fresh token for each call; if it does, check that `MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS` is long enough for the command's expected runtime.
A client that builds its own proxy URL from the token alone, with an empty password, can also get 407: Python `urllib` and Node `fetch` send no credentials then. Use the `HTTPS_PROXY` from the call's environment, whose password is `mindroom`.

**A user who opens the dashboard lands on `/connections`:**

With `MINDROOM_CONNECTIONS_AGENT` set, a user who is not in `administrators` is redirected from dashboard pages to `/connections?notice=admin-only`, where a notice says the dashboard is for administrators and their own keys and accounts are; see [Connecting an account](#connecting-an-account).

**Plain HTTP requests get 403 `tls_required`:**

The request matched a service rule but used `http://` instead of `https://`.
The broker refuses to inject secrets over plain HTTP; change the request to `https://` or remove the service rule if the destination truly requires plain HTTP and does not need injection.

**Requests to unmatched hosts are blocked when I want them to pass through:**

Set `egress_broker.unmatched_hosts: passthrough` in `config.yaml`.
The default is passthrough; you may have explicitly set it to `deny`.
