# History compaction

History preparation chooses native provider checkpoints when the resolved policy permits them, or portable conversation summaries when configured.
The provider choice, configuration schema, durable state format, and retry attempt limit are independent of this module split.

## Ownership

All paths below are relative to `src/mindroom/`.

| Module | Owns |
| --- | --- |
| `history/policy.py` | Resolving configuration and deciding whether compaction is available or needed. |
| `history/runtime.py` | Preparing one response, model construction, compaction notices, failure handling, and applying the final replay decision. |
| `history/session_context.py` | Canonical agent/team scope identity, opening the correct session store, and closing owned handles. |
| `history/replay.py` | Materializing visible persisted history, estimating its cost, and fitting replay limits. |
| `history/compaction.py` | Selecting runs, executing summary chunks, switching fallback models, and appending each chunk's summary row. |
| `history/summary_input.py` | Serializing conversation and prior summary into bounded inputs; preserving a progress-making run envelope when shrinking. |
| `history/message_content.py` | The shared text and media projection used by serialization and token estimation. |
| `history/summary_call.py` | One cancellable summary call, a typed wall deadline, complete-output validation, and bounded retry policy. |
| `history/storage.py` | Durable scope state, seen ids derived from loaded runs and summary rows, compaction chunk appends, and redaction and edit cuts, including the legacy summary rules. |
| `history/summary_rows.py` | The `<session_table>_summaries` and `<session_table>_removed_runs` tables: appending a summary row against its basis, the event sets rows fold, and cutting the log. |
| `history/summary_rows_schema.py` | The summary-row table layout, shared with session reads, run writes, and migrations. |
| `history/legacy_compaction_state.py` | The one-time migration, run when a conversation database opens, that gives every run a position, turns the compaction archive's generations into summary rows beside the runs they archived, and adopts state written when compaction deleted runs as content-free legacy summary rows. |
| `history/native.py` | Selecting and configuring native compaction for the resolved history route. |
| `native_compaction.py` | Provider-neutral checkpoint and native replay data. |

`SummaryModel` binds the serving model, its configured name, and its input budget.
A fallback switch replaces that whole value, so later chunks cannot accidentally use the previous model's budget or identity.
Persisted replay fitting and the Vertex full-request guard remain separate because they measure different inputs at different boundaries.

## Compatibility code

Agno internals use named `agno_compat_<subject>.py` boundaries beside their owners.
Each boundary records the upstream issue or tracking gap, proposed PR, removal condition, and regression coverage in source comments.
The [Agno compatibility inventory](agno-compatibility.md) covers the full runtime; the table below describes the history-related boundaries and the shared tool-hook patch.

| Module | Workaround and installation point |
| --- | --- |
| `history/agno_compat_message_builder.py` | Preserves roleful Team inputs and strips historical inline media in Agent/Team message builders; installed explicitly by `agents._initialize_agent_instance` and `teams._create_team_instance`. |
| `session_storage/agno_compat_session_persistence.py` | Guards and adapts Agno's asynchronous persistence against the owned session store; installed by `agent_storage._create_sqlite_state_storage` before filesystem work. |
| `agno_compat_prepared_tools.py` | Shares private Agent/Team tool preparation between RTC execution and prompt inspection; temporarily supplies Team tool instructions, restoring the original list even on failure. |
| `tool_system/agno_compat_tool_hooks.py` | Adapts Agno's private sync/async hook chains to deferred results and owner-controlled synchronous execution; installed by `tool_system/tool_hooks.py`, which retains dispatch, approval, and cancellation ownership. |
| `history/claude_replay_compat.py` | Removes stale signed reasoning from completed portable turns after rewriting; native checkpoint replay retains its separate provider policy. |
| `history/summary_provider_compat.py` | Normalizes effective Claude request overrides, preserves shorter HTTP limits and injected transports, disables nested Claude/OpenAI SDK retries, and classifies provider completion signals. |
| `providers/agno_compat_provider_errors.py` | Interprets legacy provider error strings and SDK cause chains when typed errors are unavailable. |

Importing the history engine does not install either global Agno patch.
The explicit installers remain idempotent, and the persistence patch retains its pinned-version guard.
When upgrading Agno or a provider SDK, inspect these compatibility modules first and run their contract tests before removing a workaround.
Mantle currently needs its existing HTTP transport passed explicitly when copying SDK client options.

## Invariants

- Summary instructions occupy their own system message; serialized conversation and prior summary occupy the user message.
- System/developer prompt roles and bulky request metadata are excluded from the portable conversation input.
- Claude summaries stopped by an output or context limit, and incomplete OpenAI Chat/Responses summaries, cannot be committed as complete summaries.
- Summary overrides preserve effective output-cap precedence while removing thinking from typed fields, request parameters, and raw body parameters.
- The outer retry policy disables Agno-level retries; Claude and OpenAI summary adapters also disable SDK retries while preserving caller-owned clients and transports.
- If the saved summary alone exceeds the final history budget, replay preparation raises an explicit budget error before a reply model call; the durable summary and already committed compaction progress remain intact.
- A scope's history is Agno's runs table in `run_index` order with summary rows between its runs, each sorting right after the newest run it covers; a session load returns the runs after the scope's latest summary row, every paused, cancelled, or errored run, and their member runs, with `session.summary` read from that row, all in one snapshot.
- Compaction never moves or deletes a run: each chunk appends one summary row, and only while the latest row's text is the summary the chunk built on and every run it folds is still stored and visible as the session loaded it, unchanged through the summary call; otherwise the compaction stops as after a failed chunk, keeping earlier chunks.
- New runs sort after every run and summary row; a paused or cancelled run saved visible, such as a completed approval, moves to the end; a visible run behind the latest summary row, or a member of one, is never rewritten, so a stale save cannot replay folded content or change its provenance.
- Every visible run between the latest barrier (a row without text) and the latest summary row is covered by that row's text; runs behind the latest barrier are retired: stored, never replayed, never counted as seen.
- Summary rows keep the event ids of what their own chunk folded, so seen ids and redaction candidates come from the rows after the latest barrier plus the loaded runs, and session metadata keeps only ids no stored run carries, such as team consumption.
- Edits and redactions cut: they delete the earliest element holding the event (an edit matches what a run answered, a redaction also what it read) and everything after it, except barrier rows, and record the removed runs so a late save of one writes no row; deleting a summary row returns the runs it covered to replay.
- Metadata seen ids have no summary-row counterpart, so a stale whole-row session write can restore ids a redaction dropped; that only withholds those messages from unseen thread context.
- Content-free legacy summaries cannot be split: while one is in force, a redaction of an event it may contain (its captured seen ids or retained source ownership) cuts at it, removing every run and later summary of the scope.
- A redaction cut that removes a loaded run holding the event while a legacy summary is in force retires every summary of the scope with a barrier row; edit cuts never consult legacy state.
- After any redaction change, the scope's metadata seen ids are dropped and the derived ids follow the remaining history, so removed messages return as unseen thread context unless a stale whole-row write restores those metadata ids (see above).
- State written by releases before the summary rows is adopted once, when the conversation database opens and before any response loads it; the summary-row tables' presence marks it done.

- Only the affected scope is rewritten; current-turn media and current-turn reasoning retain their existing replay rules.

The history, provider transport, Agno patch, import-boundary, and native compaction tests exercise these contracts, and `tests/test_compaction_fuzz.py` checks the log invariants over generated histories with raced chunks, paused and completed approvals, stale session writes, late run saves, and redactions.

See [Context Window](../configuration/history.md#context-window).
