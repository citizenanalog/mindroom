# Security Posture

This page records MindRoom's security model, the `file_access` setting, and the behaviors that are intentional.
Use it to explain what an agent's tools can reach and to check a suspected vulnerability before reporting or fixing it.
If a finding contradicts an intentional behavior below, do not change the code; raise the posture with the maintainers and explain which scenario it fails to protect.

## Trust model

A worker container, reached through the sandbox proxy, is the only security boundary between an agent and the MindRoom runtime.

Tools that run arbitrary programs cannot be confined inside their own process, because a program started by a shell or Python tool ignores any in-process path or command check.
MindRoom therefore never filters the paths, commands, or imports of code-execution tools as a security measure; it isolates them only by routing them to a worker with `worker_tools`.

An agent whose code-execution tools run in the primary process is trusted with everything that process can reach, so restricting its other tools protects nothing.

An agent whose code-execution tools run in a worker must not reach more through its primary-process tools than its worker can.
Tools such as `browser`, `attachments`, `matrix_message`, `gmail`, and `google_drive` run in the primary process by default even then, so they follow the agent's [`file_access`](#file-access) setting, which by default keeps them inside the agent workspace.

Which Matrix user may drive an agent, act in a room, or approve a change is a separate question governed by access policy and requester authorization.
An agent or team mentioned in another entity's reply acts for the human or configured bot account that requested that reply, so neither can reach an entity whose `access` excludes them by asking a different entity to mention it.

## Protecting the primary from worker code

Hardening that protects the primary runtime and other tenants from untrusted worker code is always in scope.
Examples are symlinks or files planted in shared workspaces that the primary later follows, worker-writable metadata the primary trusts, Git config the primary executes, and secrets mounted or passed into workers.

### Config and state kept out of workers

Runners and dedicated workers never receive the primary's config file, its directory, its `.env`, a ConfigMap holding it, or the credential encryption key.
The config sent to runners with each request, and the config file projected into each Docker worker, hold only the fields runners resolve; models, MCP servers, plugin settings, and every other section stay in the primary, and a worker-routed call carries only the called tool's own inline overrides.

Dedicated Docker and Kubernetes workers mount only agent workspaces, never the agent state roots around them, so sessions, memory, learning, Mem0 data, and private-instance identity records stay out of every worker.
The Kubernetes `static_runner` sidecar still mounts `agents` and `private_instances` read-write, so records the primary treats as authority live below the primary-only `tracking/` directory instead: the invited-room and pending-invite ledgers, personal-room records, conversation modes, and the primary's copy of each private-instance owner record, together with their locks.
The thread exporter writes into a private instance only for the requester that the primary's owner record names, so an owner record planted in `private_instances` gets no export.
Automations likewise run for a private instance only as the requester that record names, and post only in that requester's personal room, so their replies quoting private files never reach another room.

Egress broker secrets (credential services named `egress_*`) are stored in primary-only credential stores and never reach worker-writable locations, matching the placement of primary-built tool settings.
When the broker is enabled, workers receive a signed proxy token in their environment that authenticates them to the broker, valid for `MINDROOM_EGRESS_BROKER_TOKEN_TTL_SECONDS` (default 7 days), and the broker injects the configured secret when the worker's request matches a service rule.
Workers can read their own proxy token (it is in their environment), but the token only authorizes that worker's scope and expires after the configured TTL (default 7 days), so a leaked token exercises only that scope's configured services until it expires.
The proxy URL carries the token as its user name and the fixed password `mindroom`, which the broker ignores and which is not a secret: Python `urllib` and Node `fetch` send proxy credentials only when both parts are non-empty.
Every JSON refusal the broker writes carries a plain `message` for the agent.
It interpolates only the service, provider, host, path without its query string, and a shared agent's credential managers (Matrix IDs, which worker code can therefore read), and never a secret, token, query string, or connect link, which stay in their own fields.
The same message is the refusal's HTTP reason phrase (printable ASCII, CR and LF removed, 200 characters at most) beside an `X-MindRoom-Error` header, and a git client's refused discovery request gets it as an `ERR` pkt-line that names the manage link, never the connect link, so no refusal channel carries more than the JSON body does.
Agents without a worker scope all share the global store, so a token from any of them reaches the same global keys.
A service can also take its secret from an OAuth account that a user connected (GitHub, Google, Atlassian) when no API key is stored for the scope, and an explicit key always wins over the account.
The primary fetches and refreshes those access tokens through the OAuth credential lifecycle and the broker injects them as the matched rule's auth type; workers never receive an OAuth access token or a refresh token, only the proxy token and placeholder values, and the broker's logs and audit records never contain them.
Account scope follows each provider's own policy: GitHub and Atlassian are requester-scoped, so a worker's requests use the requester named in its verified proxy token, while the Google providers follow the agent's worker scope.
The broker uses a requester-scoped account only on `user` and `user_agent` workers that run on a dedicated (Docker or Kubernetes) worker backend by default.
A `shared` or unscoped worker, and every worker on the static runner, runs every requester's commands in one sandbox, where a later command from another user can read an earlier caller's proxy token (for example from the environment of a process left running) and act with that caller's account until the token expires, so there the broker injects no GitHub or Atlassian account, adds no placeholder for it, and offers no connect link.
A service's `oauth_on_shared_workers: true` removes that gate: every user of such a shared sandbox can then act with any other user's connected account until that user's proxy token expires, and the egress pages warn about it.
The `connect_url` that a 403 response carries goes only to the worker whose proxy token has that scope; it is the same short-lived single-use connect link that conversation OAuth uses, and it starts a connection for that one scope after the recheck of the requester's permission.
The link also requires the browser to be signed in to MindRoom as that requester.
A shared-scope link would skip that sign-in, and any process in a shared worker could read it, so the broker never puts one in a response; users of a shared agent connect its account from the egress pages instead.
A shared Google service account (`GOOGLE_SERVICE_ACCOUNT_FILE`) is never injected, so the broker cannot be used to spend it.
Everyone who uses a shared agent sees which account is connected for it (its email address, for the Google providers), because they all act as it, and connecting one asks for confirmation first; only administrators and credential managers can connect or disconnect it.
A requester-scoped account (GitHub or Atlassian) is read only from the viewer's own connection, and the broker refuses it on shared agents unless the service sets `oauth_on_shared_workers`, so another user's personal account never appears there.
Under that setting each user connects their own account without the confirmation, and the egress pages warn that everyone using the agent can act with it.
After a GitHub connection, the primary reads the account login once with the new token (5 second timeout, no redirects, only the error type logged on failure), and never on refresh.
On the shared static runner, including the hosted `static_runner` sidecar, a scoped call's broker token, valid for the token TTL, lives in a process shared with other users' calls, consistent with the static runner not being an isolation boundary; use dedicated `user` or `user_agent` workers on `private` agents when requesters must not be able to use each other's brokered credentials (see [Shared workspaces on non-private agents](https://docs.mindroom.chat/deployment/egress-broker/#shared-workspaces-on-non-private-agents)), because a dedicated `shared` or unscoped worker also runs every requester's commands in one sandbox.
Personal GitHub and Atlassian accounts follow the same line: only `user` and `user_agent` workers on the Docker or Kubernetes backend get them, and the static runner needs the service's `oauth_on_shared_workers` opt-in.
Users can define egress services of their own, and those stay per scope and never widen operator policy.
A user service is stored in the same primary-only store as that scope's keys, so it applies only to the workers of that scope: a requester's own on `user` and `user_agent` agents, and the agent's (or the global scope's) on shared and unscoped agents, where only administrators and credential managers may write them.
The credential managers of one key scope can change each other's keys and services, and unscoped agents share one key store, so the managers of all unscoped agents can too; the boundary is that agents and worker code never read a stored key, and users who are neither administrators nor credential managers cannot change keys or services (see [Egress Broker Design Decisions](https://docs.mindroom.chat/architecture/egress-broker-design/)).
It routes only that scope's own keys and accounts, and it cannot take a config service's name or set `oauth_on_shared_workers`.
Under `unmatched_hosts: deny` a user rule applies only on hosts that an operator service names, and on a host where an operator service sets `restrict_to_rules` a path must match an operator rule, so a user service can narrow operator policy but never open a host or path the operator refuses.
A user service that sets `restrict_to_rules` also narrows the operator's services on its hosts, for its own scope only: a path must pass the operator's restriction and the requester's, and another requester on the same host is unaffected.
A user service can use a connected account only in a personal scope, and its placeholder variables are limited to credential-like names and plain values, because a shared agent's services set variables in every requester's sandbox.
`restrict_to_rules` is not a network boundary: under `passthrough` a worker can reach the same server by IP address through a tunnel the broker does not intercept, which carries no credential, so the real boundary stays the token's own permissions on the upstream side.
A user can narrow an administrator's service in place with a `restrict_only` service, which limits paths without choosing a credential or storing a key, so it cannot widen anything and cannot redirect a key.
The broker parses each request itself and forwards one re-serialized request per parsed request, with a 64 KiB head limit, a connection that closes after conflicting length headers, a reused tunnel upstream that is dropped when it sent stray bytes, and a handshake that is refused when the client's SNI differs from the CONNECT host; the reasons are in [Egress Broker Design Decisions](https://docs.mindroom.chat/architecture/egress-broker-design/#where-a-secret-may-go).
The risks the broker cannot prevent (code in the primary process, write access to the config, hosts that echo requests, wildcard rules on shared hosting domains, keys that can create other keys, and shared workspaces on `user` and `user_agent` agents that are not `private`) are listed in [What the broker cannot protect against](https://docs.mindroom.chat/deployment/egress-broker/#what-the-broker-cannot-protect-against).

### Testing and review of the egress broker

About 1,700 lines of the broker's transport are hand-written (`_relay.py`, `mitm.py`, `proxy.py`, `dial.py`, `ca.py`), and so are the path checks in `rules.py`; TLS, HTTP/1.1 parsing, and certificates come from `ssl`, `h11`, and `cryptography`.
These pieces are tested, and they have not been independently reviewed.

- **Smuggling corpus.** Raw-socket tests (`tests/egress_broker/test_smuggling_requests.py`, `test_upstream_anomalies.py`, and `test_tunnel_tls.py`) send malformed and ambiguous HTTP/1.1 to a real broker, plain and inside an intercepted tunnel, in front of a fake upstream whose strict parser refuses anything another parser could frame differently.
  The cases include conflicting `Content-Length` and `Transfer-Encoding` (CL.TE, TE.CL, and TE.TE obfuscations), duplicate and signed lengths, chunk-size overflow, bare LF, obs-fold, oversized heads, pipelined requests for another host, `Expect: 100-continue`, non-websocket upgrades, upstream anomalies (extra bytes after a response, early close, split heads), an SNI that differs from the CONNECT host, an h2-only ALPN offer, and an upstream certificate failure that must give 502 and never fall back to insecure.
  Each case asserts that the broker refuses the request or forwards exactly one well-framed request, never adds a credential to a request for another host, never gives one request's response or secret to another, and still serves the next request.
- **Fuzzing.** Property-based tests (`tests/egress_broker/test_fuzz.py`, `hypothesis` with a fixed, derandomized profile) check that any path the router matches under a prefix still stays under it after the normalizations that common servers apply (repeated percent-decoding, cutting at `;?#`, backslash conversion, Unicode folding, and `normpath`), or is refused; that mutated requests, plain and inside a tunnel, never crash the listener or carry a credential to the wrong place; and, with a differential oracle, that no path refused before the Unicode fix is accepted now.
  `tests/egress_broker/test_dial.py` pins the dial guard against IPv4-mapped IPv6, decimal, octal, and hex IPv4, a trailing-dot `localhost.`, IPv6 zone IDs, link-local and metadata addresses, `fd00::/8`, CGNAT, `0.0.0.0`, multicast, and DNS rebinding between the check and the connect.
- **What they found.** Four real bugs, all fixed: stray upstream bytes answering the next request on a reused tunnel connection, an SNI that differs from the CONNECT host still being served, `Connection: Content-Length` removing request framing, and Unicode look-alike dot segments (with a regression in the first fix that the differential oracle now pins).
- **What was not possible.** Independent adversarial reviews of these modules, with concrete exploit attempts against a local broker, were planned and could not be done: the model providers' safety filters refused the task.
  There is no automated adversarial review, so the tests above are the evidence.
- **Recommendation.** Have a human penetration test of the proxy core (`_relay.py`, `mitm.py`, `proxy.py`, `dial.py`, `ca.py`, `rules.py`, `tokens.py`) before the broker is exposed widely.

The egress broker listener (when `MINDROOM_EGRESS_BROKER_PORT` is set) is a worker-reachable primary runtime surface: workers must reach it to make brokered requests, so it must be accessible from the worker network (Docker `docker0` interface or the Kubernetes broker Service).
The hosted `static_runner` sidecar shares the primary pod's network instead, so there the broker binds only loopback (`127.0.0.1`) and is reachable from no other pod.
The broker port must not be published beyond the worker network, because a leaked token could otherwise be used from arbitrary network locations until it expires; expired tokens get 407.
Firewall rules and network policies confine the broker port to worker-originated connections only.

### Workspace mounts by worker scope

[Worker scopes](https://docs.mindroom.chat/deployment/sandbox-proxy/#worker-scopes) lists the workspaces each dedicated worker mounts.
A `user` worker mounts several agents' workspaces, so code working in one of them can read and write the others.

A workspace is mounted only when it is a real directory reached from the storage root without links.
Because Docker resolves mount targets again on every container start, a worker whose mount target inside its writable root was replaced with a link by worker code is refused when it is created or restarted.
Assigned knowledge outside the workspace reaches a worker only when its configured path is a real directory or file, reached without links, outside every directory other workers write.
Kubernetes mounts such knowledge read-only, because kubelet follows links inside the volume when it mounts, and Docker copies it into the worker's read-only config snapshot through no-follow descriptors.

### Workspace files the primary reads and writes

The primary treats everything inside a mounted workspace as worker-controlled.
Files it reads or writes there, such as skills, subagent profiles, context files, delegation records, knowledge sources, call transcripts, callback scripts, script-run snapshots, todo templates, scheduled-run receipts, workspace knowledge links, thread exports, the files `prompt_curation` measures, and the memory files, staging copies, reports, verdicts, and thread-export `index.json` files `dreaming` reads, are reached from the workspace root without following links, never written through a file that has another hard link, opened non-blocking so a FIFO cannot stall the primary, and published by atomic replacement or exclusive creation.
The primary never takes a file lock inside a workspace, because worker code could hold it forever.
`dreaming` writes each run's agenda, staging copy of `memory/`, and patch under `.mindroom/dreaming/runs/`, and deletes finished staging and old runs without following links.
It writes an approved proposal into `memory/` from bytes worker code staged, which gives the agent nothing it could not write itself; it writes only Markdown under `memory/` other than today's daily note and context files, and keeps its progress below `tracking/`, outside the workspace.
Delegation records keep their working state below `tracking/`, and the `run.json`, `events.jsonl`, and `transcript.md` in the child's workspace are exports the primary never reads.
Worker code that makes one of those exports or the caller's receipt unwritable only leaves the record's exports or the receipt stale; the delegation still records its events and settles.

In the primary, `mindroom_output_path`, attachment saves, Google Drive and E2B downloads, `file_generation` saves, `visualization` charts, workspace knowledge links, workspace todo templates, and `file` and `coding` reads, writes, and deletes refuse a workspace replaced by a link after runtime resolution.
That check covers only the workspace's final path component, so a replaced parent such as `agents/<name>` is not refused.
With the default workspace names that is not exploitable in the hosted layout, because no primary-only directory there contains an entry named `workspace`; an authored `private.root` that matches a primary directory name, such as `credentials`, could be reached through a replaced parent.

A background job's saved result keeps the bytes a tool returned with a media file instead of reopening its path, and reads a media file the tool returned only by path as a regular file, opened non-blocking without following a final link.

Git commands the primary runs in a workspace, for knowledge checkouts and the `coding` tool's ignore check, use the hardened Git command and environment, so programs named in workspace Git config never run.

### Read limits on workspace files

Reads of worker-controlled files are capped per surface.

| Surface | Cap | Above the cap |
|---|---|---|
| Context files | 1 MiB | Truncated with a warning |
| `prompt_curation` snapshots of `MEMORY.md` and context files | 1 MiB per file | Refused, so the check is skipped with a warning or verify reports the file as unreadable |
| `dreaming` memory files, staging copies, reports, and verdicts | 1 MiB per file | A memory file is left out of the run, a staged file stops the run, and a report or verdict counts as missing, so the run stops or the proposal is rejected |
| `dreaming` thread-export `index.json` | 8 MiB per room | Ignored, so that room's conversations are aged by file modification time |
| Workspace `SKILL.md`, skill references and scripts | 1 MiB per file; names 64 characters; descriptions 1024 characters; 256 listed scripts and 256 references; per workspace 256 skills and 8 MiB of `SKILL.md` files and listings, including files that fail to load; 1,024 examined entries per `skills/`, `scripts/`, `references/`, or `skills/.history/<skill>/` directory, for skill loading and skill learning alike | An oversized file or a skill with a longer name is refused, a longer description or listing is truncated, and skills beyond the budget or count are skipped, each with a warning; entries past the first 1,024 in directory order are not examined |
| Workspace subagent profiles (`subagents/*.md`) | 64 KiB per file; names 64 characters; descriptions 1024 characters; the listing reads at most 256 profiles and 1 MiB; 1,024 examined entries in `subagents/` | An oversized or unreadable file is listed as invalid and cannot run, and profiles past the listing limits are left out of it but still load by name |
| Call transcripts sent to Mem0 | 64 MiB | Truncated |
| Knowledge sources, including operator-managed ones | 64 MiB | Left out of the listing with a warning |
| Scheduled-run receipts, `file` and `coding` reads, `airflow` DAG reads | 64 MiB | Refused with a logged error |
| `e2b` uploads, sandbox files that `e2b` downloads or reads, and `e2b` command and code output | 64 MiB | Refused with a tool error; `stream_command()` returns its first 64 MiB |
| Files a `file` content search reads | 500 KiB each, Agno's search limit | Skipped |
| `browser` upload snapshots, kept in the browser's temp directory until their tab closes | 256 MiB in total per browser | Refused with a tool error |
| Media files a background job's result reads by path | 48 MiB in total per result, within its 64 MiB encoded limit | The job fails with a size-limit error |
| `moviepy_video_tools` staged inputs | 1 GiB per video; 1 MiB per caption file | The call fails before staging more than the cap |

Thread-export files are read and built under the per-file, per-thread, and per-room limits documented in [Thread Exports](https://docs.mindroom.chat/thread-exports/).
The exporter's drift check reads at most 8 MiB of a room's `index.json` and rebuilds a larger one from the thread files.
Workspace todo templates have the size, render, and listing limits documented in [`todo`](https://docs.mindroom.chat/tools/project-management/#todo), and they render in a short-lived, memory-limited child process instead of the primary, because sandboxed Jinja alone does not bound their cost.

Workspace `SKILL.md` and subagent profile frontmatter, todo templates, and thread-export files are refused before parsing when their YAML uses aliases, `%TAG` directives, deep nesting, or other structures that would let a small file cost the primary unbounded memory, stack depth, or parse time; [Skills](https://docs.mindroom.chat/skills/#skillmd-format-openclaw-compatible) lists the exact limits.

## Hosted tenant isolation

Hosted tenants share the `mindroom-instances` namespace, and a tenant can run code in its own primary and sandbox-runner sidecar by design.
The boundary between tenants is the cluster configuration around those pods.

[Multi-Tenant Architecture](https://docs.mindroom.chat/deployment/saas-platform/#multi-tenant-architecture) lists those controls.
The instance chart refuses dedicated Kubernetes workers because RBAC cannot confine a worker manager to one tenant's Deployments, Services, PVCs, and Secrets in a shared namespace.

## File access

`defaults.file_access` sets the default and `agents.<name>.file_access` overrides it for one agent.

| Value | Path tools may use |
|---|---|
| `workspace` (default) | Files inside the agent workspace and attachments available in the conversation |
| `unrestricted` | Any file the tool's process can reach; on a worker that is the worker container |

Every tool, including plugin tools, must declare one of these file access classes when it registers, so no tool silently defaults to taking no paths.

| Tool class | Tools | Behavior |
|---|---|---|
| Path tools | `attachments` (including `view_file`), `matrix_message`, `chat_ui` canvas pages (`show_canvas` with `path`), `gmail`, `google_drive`, `browser` uploads, `e2b` uploads, `openai` and `groq` audio files, `airflow`, `moviepy_video_tools` | Follow the agent's `file_access` and refuse replaced workspace roots and swapped files; `airflow` and `moviepy_video_tools` writes do not follow links below the workspace, and MoviePy and FFmpeg work only on private staged copies, refusing video inputs that FFmpeg would open as playlists or manifests |
| Worker path tools | `file`, `coding` | Follow the agent's `file_access`; reads, writes, edits, deletes, and every file a `file` content search reads refuse replaced workspace roots and swapped files, while listing and the other searches walk by path, as the known gap below describes |
| Unconfined tools | Code-execution tools (`shell`, `python`, `docker`, `script`, `claude_agent`) and tools whose queries, paths, or URLs reach local files without confinement (`duckdb`, `csv`, `pandas`, `sql`, `composio`, `postgres`, `redshift`, `browserbase`, `slack`) | Class `unconfined`: not confined by `file_access`, whatever the agent's setting; authored tool config may only state `file_access: unconfined` |
| Other tools | Everything else, including `web_browser_tools`, which opens only `http` and `https` URLs | Take no local file paths |

[`browser_mcp`](https://docs.mindroom.chat/tools/worker-computer/#native-playwright-mcp-provider) runs only in a worker and confines its upload, drop, screenshot, and PDF paths to the worker workspace whatever the agent's `file_access`.

MCP servers on the local `stdio` transport are unconfined too, because they are operator-launched programs; remote `sse` and `streamable-http` servers take no local file paths.
Whether a tool executes code is a separate metadata flag from its file access class; only the code-execution tools above carry it.
A worker isolates the unconfined tools that support worker routing (`shell`, `python`, `docker`, `csv`, `postgres`, `redshift`).
The rest require the primary runtime and cannot run in a worker (`claude_agent`, `script`, `duckdb`, `pandas`, `sql`, `composio`, `browserbase`, `slack`), so enable them only for agents trusted with everything the primary runtime can reach.
MindRoom logs a warning when an agent routes code-execution tools to a worker while primary-process tools stay unconfined, meaning unconfined tools or path tools under `file_access: unrestricted`, because those tools can then read runtime secrets the worker was meant to keep away.
The model sees the effective file access and the unconfined tools in its tool execution environment description.

## Known gaps

These are tracked gaps, not intentional behaviors; fix them rather than documenting around them.

- The unconfined non-code tools `composio`, `postgres`, `redshift`, `browserbase`, and `slack` do not yet follow `file_access`; a separate change will confine their explicit path and URL arguments.
- SQL-capable tools (`duckdb`, `csv`, `sql`, and `pandas` query helpers) embed file paths inside queries, so guarding explicit path arguments cannot confine them; they stay unconfined until a query-level mechanism exists.
- The listing and search functions of `file` and `coding` (`list_files`, `search_files`, `grep`, `find_files`, and `ls`) refuse a workspace that no longer resolves to the pinned directory and paths that lead outside it, but then walk and read by path.
  This matters only when an operator routes these tools to the primary process while worker code writes the same workspace, such as the Kubernetes `static_runner` sidecar with `worker_tools` that leave out `file` and `coding`.
  Code that swaps the workspace, a checked directory, or a file for a link between that check and the walk can make that one call list or return any file the primary process can read, and a planted FIFO can stall a `coding` content search.
  By default these tools run in a worker, where they see only what the worker already mounts.
- Knowledge Git commands refuse a worktree whose path goes through a link, but Git then reopens that worktree by path.
  For a Git-backed knowledge base inside a workspace a worker writes, swapping the knowledge folder for a link between that check and the Git command can make that one sync check out or update files at the link target with the primary's permissions; the next sync refuses the link.

## Intentional behaviors

Do not report or "fix" these; they are deliberate.

- An operator who runs MindRoom without workers, for example inside a dedicated LXC container or VM, has chosen full trust; `file_access: unrestricted` matches that choice.
- `file_access: unrestricted`, or unconfined tools in the primary process, are allowed together with worker routing; they log a warning instead of failing.
- Hosted tenants may set `file_access: unrestricted`; it exposes only their own instance.
- With `file_access: workspace`, the browser, attachments, `matrix_message`, `chat_ui` canvases, Gmail, and Google Drive may still use every file in the agent workspace.
- A `chat_ui` canvas can leak what the user types into it through WebRTC, which browsers do not let a page block, or, with libraries on, through the addresses it requests, so agents should only show pages they wrote; see [Privacy and safety](https://docs.mindroom.chat/canvases/#privacy-and-safety).
- The browser and `matrix_message` also accept `att_*` IDs of attachments available in the conversation; Gmail and Google Drive take file paths only, so an agent first saves a received attachment into the workspace with `get_attachment(mindroom_output_path=...)` and then passes that workspace path.
- `mindroom_output_path`, attachment saves, Google Drive downloads, `file_generation` saves, `visualization` charts, and report publishing always write inside the workspace regardless of `file_access`, because they produce MindRoom-owned output.
- Writes into `.git` directories stay blocked for `file` and `coding` in both modes, because MindRoom runs Git in checkouts that may sit inside agent workspaces.
- A skill review may resend the reviewed conversation unredacted to the provider that just received it, and a digest replay redacts credentials only on a best-effort basis; see [What a review sees](https://docs.mindroom.chat/skills/#what-a-review-sees).
  The check that refuses skill files holding a literal credential is a heuristic for common formats; a miss is not a vulnerability, because skills live in the agent's own workspace next to the conversation history that already held the value.
- Automatic skill learning trusts the `metadata.mindroom` frontmatter flags and the provenance and usage in `skills/.usage.json` inside the workspace, which worker code can change; that only lets it make the learner edit or archive skills worker code could already change itself.
- `skill_manage`, used in chat by agents that list it or learn skills and by skill reviews, runs in the primary process and writes only below the agent's workspace `skills/` directory through no-follow descriptors, regardless of `file_access`, like MindRoom-owned output.
- An authored subagent, started by `run_subagent` with `system_prompt`, `tools`, or `profile` or by a Dynamic Workflow `subagent` participant, runs as its caller with the caller's tools, credentials, workspace, and approval rules, which for a workflow participant include the caller's `dynamic_workflow` `allowed_tools` pre-approval and reading the skills it names when the caller could without approval; worker code that edits a `subagents/*.md` profile can change what such a child is told, but gives it nothing the caller lacks.
- Each agent publishes its running background jobs in each room as unencrypted room state keyed by its own user ID: job ID, thread, kind, tool name, status, requester ID, and start time, never arguments or results, so the homeserver and every room member can read them even in an encrypted room.
- Anyone who may talk to an agent in a room may cancel its background jobs there, including jobs another requester started, as with **Stop**; another agent's account never may.
- The agent or team that answers in a conversation lists, reads, and cancels the background jobs its team members started there for the same requester, because the team already receives its members' output.
- The `job` function never asks for approval, even under `tool_approval.default: require_approval`, because it only reads and cancels the caller's own jobs, each of which passed its own approval.
- A team's `access` authorizes its exact member agents for team requests, in Matrix and the OpenAI-compatible API, even members whose own `access` would not admit the requester directly; adding an agent to a team is a deliberate grant.
- A response's CLI grant, in minimal mode or for a standard-mode agent whose shell can reach MindRoom, is in the environment of its shell commands, so other code in the same worker can use that requester's tools through it until the response ends; code that shares a worker already shares its trust.
- A non-private agent's workspace is shared by every requester's runtime for that agent, including `user` and `user_agent` workers, so files one requester leaves there (such as `.mindroom/worker-env.sh`, `.pth` files, or Git config) can run in another requester's runtime; use `private` agents when requesters need isolation from each other.
- Likewise, a non-private agent's primary-process `browser` profiles and default artifacts live in that agent's state root and are shared by all of its requesters, so one requester can use web sessions another signed in and upload screenshots another took; they never cross agents or the requesters of a private agent.
- A browser egress proxy in a sandbox runner receives destination hostnames, because an approved-egress proxy decides by name, so rebinding between the relay's check and that proxy's own lookup is the proxy's responsibility; in the primary the relay tunnels to the address it validated.
- A proxy environment the primary cannot follow, such as a SOCKS proxy or `auto_proxy`, makes the relay dial directly within the browser's destination policy instead of refusing to start, because no MindRoom egress policy depends on that proxy there; a sandbox runner refuses.
- A shared knowledge base whose path lies inside an agent workspace, such as that agent's thread exports, is bound without following links below the workspace, so even an operator-made link there is refused; shared knowledge outside every agent workspace still follows operator links.
- The egress broker streams request bodies, so a valid request head can reach the right upstream before a bad or oversized body gets 400 or 413 and the upstream connection is aborted; the head carries the secret only to the host the request was routed to.
  Buffering every body would cost memory and latency.
- The egress broker's check for stray bytes on a reused tunnel upstream cannot see bytes that reach the socket just after the check polls it.
  Such bytes can only come from that tunnel's own upstream, and no other tunnel, host, or requester is affected.
- A team approval continuation checks only that each approved call keeps the arguments its card showed, not whether the saved team run holds other calls ready to run, because team runs live below `teams/`, which no worker mounts.
- The Kubernetes `static_runner` sidecar mounts `agents` and `private_instances` read-write as the primary's user, so tool code it runs can read and change every agent's sessions, memory, learning data, and private-instance contents; the shared sidecar is not an isolation boundary between agents or requesters, and dedicated Kubernetes workers are the option that is.
- After an upgrade from workers that mounted whole state roots, startup stops those workers before serving, failing until none remain, and warns; it does not scan for or repair links they may have planted above workspaces, because a scan on every start is costly and an automatic repair could itself follow a planted entry, so an operator runs the [upgrade check](https://docs.mindroom.chat/deployment/upgrades/#workspace-only-worker-mounts).
- Conversation OAuth connect and reset links for shared-scope credentials work without a dashboard login; the short-lived single-use link and the recheck of the issuing requester's credential-management permission authorize them, because some deployments give users no dashboard access.
- Anyone who can use an agent may connect or reset their own requester-owned OAuth connection (user or user-agent credential scope) through its chat links, as on the Connections portal; the browser must authenticate as the link's requester, and shared-scope connections still require an administrator or credential manager.
- The MCP gateway runs an agent's tools without its instructions, so it withholds agents whose worker scope is `shared` or unset unless `mcp_gateway_shared_credentials` opts one in; an opted-in agent's users can call its tools directly with its shared accounts and worker, and the shared workspace and browser profiles of a non-private `user` or `user_agent` agent stay reachable through the gateway as they are in chat.

## Reviewing security findings

Classify every finding before proposing a change.

1. Name the boundary it crosses: worker to primary, tenant to tenant, Matrix user to agent, or none.
2. Check whether the agent involved is trusted under the trust model above.
3. Check the intentional behaviors list.
4. Only a finding that crosses a real boundary and matches no intentional behavior is a bug.

A fix that restricts a trusted setup, or that blocks workspace and attachment flows an agent legitimately needs, is not a security fix.
When a maintainer rejects a finding as intended behavior, add it to the list above in the same change so the next reviewer does not rediscover it.
