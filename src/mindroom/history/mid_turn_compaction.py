"""Compact a long turn between two of its model requests.

Before every provider request the request is sized. When it would exceed the replay window minus
``reserve_tokens``, everything except the leading system messages, the current prompt, transient messages, and
queued-message notices is folded into one summary, and the turn continues from
``[system, summary, current prompt, ...]``. A request without persisted replay keeps that summary as an ordinary
message of its own run.
"""

from __future__ import annotations

import asyncio
from copy import deepcopy
from dataclasses import dataclass, field
from functools import partial
from typing import TYPE_CHECKING, cast

from agno.agent import Agent
from agno.db.base import BaseDb, SessionType
from agno.models.base import Model
from agno.models.message import Message
from agno.run.agent import RunOutput
from agno.run.base import RunStatus
from agno.run.team import TeamRunOutput
from agno.session.team import TeamSession
from agno.team import Team

from mindroom.agent_storage import run_session_storage_operation, save_compaction_usage
from mindroom.agno_compat_model_hooks import install_request_preparation
from mindroom.background_tasks import run_blocking_until_complete
from mindroom.constants import QUEUED_MESSAGE_NOTICE_MARKER_KEY
from mindroom.helper_usage import get_helper_usage_owner
from mindroom.history import archive
from mindroom.history.agno_compat_message_builder import built_request_session
from mindroom.history.legacy_summary_system_prompt import strip_embedded_summary
from mindroom.history.policy import context_budget_after_reserve
from mindroom.history.replay import (
    HistorySummaryBudgetError,
    compaction_summary_message,
    compaction_summary_text,
    current_summary_text,
    estimate_request_messages_tokens,
    is_compaction_summary,
)
from mindroom.history.runtime import (
    compact_scope_mid_turn,
    resolve_agent_preparation_inputs,
    resolve_entity_preparation_inputs,
    summarize_run_locally,
)
from mindroom.history.session_context import resolve_history_scope
from mindroom.history.storage import new_scope_session, reconcile_compaction_state, roll_back_running_turn
from mindroom.history.types import HistoryScope
from mindroom.logging_config import get_logger
from mindroom.model_usage import response_context_tokens
from mindroom.native_compaction import NativeCompactionModel, checkpoint_items, native_replay_messages
from mindroom.token_budget import estimate_text_tokens, stable_serialize
from mindroom.usage.storage import COMPACTED_REQUESTS_METADATA_KEY, project_requests

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable, Sequence
    from typing import Any

    from agno.models.response import ModelResponse
    from agno.session.agent import AgentSession

    from mindroom.config.main import Config
    from mindroom.constants import RuntimePaths
    from mindroom.history.runtime import HistoryPreparationInputs
    from mindroom.history.types import CompactionLifecycle

logger = get_logger(__name__)

_HOOK_MARKER = "_mindroom_mid_turn_compaction_installed"
_BINDING_KEY = "_mindroom_mid_turn_compaction"
_PROMPT_ROLES = frozenset({"system", "developer"})
_RUN_STATES_KEPT = 32


@dataclass
class _RunState:
    """Mid-turn compaction state of one run."""

    # Identity of the response loop being prepared, and the message ids it started with.
    loop_identity: int
    start_ids: frozenset[str]
    # Set when compaction failed or cannot bring the request under the limit; the rest of the run, including after
    # an approval resume, is not compacted again.
    stopped: bool = False


@dataclass
class _MidTurnCompaction:
    """One Agent's or Team's mid-turn compaction policy and the state of each run it serves."""

    target: Agent | Team
    config: Config
    runtime_paths: RuntimePaths
    entity_name: str | None
    model_name: str
    lifecycle: CompactionLifecycle | None = None
    # Parallel delegations can run one member several times at once, so state is kept per run.
    runs: dict[str, _RunState] = field(default_factory=dict)

    def resolved_inputs(self) -> HistoryPreparationInputs:
        if isinstance(self.target, Agent):
            return resolve_agent_preparation_inputs(
                agent=self.target,
                agent_name=self.entity_name or self.target.id or "",
                full_prompt="",
                config=self.config,
                active_model_name=self.model_name,
                static_prompt_tokens=0,
            )
        return resolve_entity_preparation_inputs(
            config=self.config,
            entity_name=self.entity_name,
            static_prompt_tokens=0,
            active_model_name=self.model_name,
            active_context_window=None,
        )

    def run_state(self, run_id: str, run_response: RunOutput | TeamRunOutput, messages: list[Message]) -> _RunState:
        """Return the run's state; a new response loop records the ids it starts with, which predate its responses."""
        state = self.runs.pop(run_id, None)
        if state is None or state.loop_identity != id(run_response):
            ids = frozenset(message.id for message in messages if message.id)
            state = _RunState(id(run_response), ids, stopped=state.stopped if state is not None else False)
        self.runs[run_id] = state
        while len(self.runs) > _RUN_STATES_KEPT:
            self.runs.pop(next(iter(self.runs)))
        return state


@dataclass(frozen=True)
class _Layout:
    """How one request divides into kept and folded messages."""

    leading: int
    kept: tuple[Message, ...]
    # Replayed messages of earlier turns, which the scope summary or the archive already covers.
    history: tuple[Message, ...]
    # This turn's folded messages, each with the tool results that answer it, oldest first.
    exchanges: tuple[tuple[Message, ...], ...]
    prompt: Message | None
    previous_run_local_summary: str | None


def install_mid_turn_compaction(
    target: Agent | Team,
    *,
    config: Config,
    runtime_paths: RuntimePaths,
    entity_name: str | None,
    model_name: str,
) -> None:
    """Compact the target's long turns before any model request that would exceed its replay window."""
    model = target.model
    if not isinstance(model, Model):
        return
    binding = _MidTurnCompaction(
        target=target,
        config=config,
        runtime_paths=runtime_paths,
        entity_name=entity_name,
        model_name=model_name,
    )
    vars(model)[_BINDING_KEY] = binding
    install_request_preparation(model, marker=_HOOK_MARKER, prepare=partial(_prepare_request, binding))


def bind_compaction_lifecycle(target: Agent | Team, lifecycle: CompactionLifecycle | None) -> None:
    """Show this reply's mid-turn compactions through the same notices as its pre-reply compaction."""
    model = target.model
    binding = vars(model).get(_BINDING_KEY) if isinstance(model, Model) else None
    if isinstance(binding, _MidTurnCompaction):
        binding.lifecycle = lifecycle


@dataclass(frozen=True)
class _Policy:
    """The resolved compaction plan and request limit for one model request."""

    inputs: HistoryPreparationInputs
    limit: int
    # The model's own window minus the reserve; a rewritten request over it would fail at the provider.
    fit_limit: int
    model: Model
    replay_model: NativeCompactionModel | None
    # Set while the provider compacts natively; the hook then only falls back to text when a request cannot fit.
    native_route: str | None


async def _prepare_request(
    binding: _MidTurnCompaction,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    run_response: RunOutput | TeamRunOutput | None,
) -> None:
    if run_response is None or not run_response.run_id:
        return
    state = binding.run_state(run_response.run_id, run_response, messages)
    built_session = built_request_session(binding.target, run_response.run_id)
    if state.stopped or built_session is None:
        return
    loaded_ids = state.start_ids
    policy = _policy(binding)
    if policy is None:
        return
    # Sizing can tokenize the whole request, so it stays off the event loop that serves every room.
    request_tokens = await asyncio.to_thread(_request_tokens, binding, policy, messages, tools, loaded_ids)
    if request_tokens <= policy.limit:
        return
    session = _scoped_session(binding, built_session, run_response)
    layout = _layout(messages, run_response, scoped=session is not None)
    if not layout.exchanges and all(is_compaction_summary(message) for message in layout.history):
        # Nothing but an earlier summary would fold, so compacting again cannot shrink the request.
        return
    summary_message = await _summarize(binding, policy, layout, messages, run_response, session, request_tokens)
    if summary_message is None:
        state.stopped = True
        return
    if policy.replay_model is not None and policy.replay_model.native_compaction is not None:
        # The provider's own compaction could not keep this request within the window.
        logger.warning(
            "Native compaction left the request over its limit; compacted as text",
            run_id=run_response.run_id,
        )
        policy.replay_model.configure_native_compaction(threshold=None)
    _finish(messages, layout, summary_message, run_response)
    rewritten_tokens = await asyncio.to_thread(_estimated_request_tokens, policy, messages, tools)
    _require_fit(policy, rewritten_tokens, summary_message)
    if rewritten_tokens > policy.limit:
        # What stays (system prompt, tools, summary, prompt) exceeds the replay window on its own; compacting again
        # would only summarize each new tool result before the model ever saw it.
        logger.warning(
            "Compacted request still exceeds the replay window; not compacting again",
            run_id=run_response.run_id,
        )
        state.stopped = True


async def _summarize(
    binding: _MidTurnCompaction,
    policy: _Policy,
    layout: _Layout,
    messages: list[Message],
    run_response: RunOutput | TeamRunOutput,
    session: AgentSession | TeamSession | None,
    request_tokens: int,
) -> Message | None:
    """Summarize the folded history and every exchange of the turn, or return None when compaction failed."""
    try:
        if session is None:
            return await _summarize_run_locally(binding, policy.inputs, layout, run_response)
        return await _compact_scope(binding, policy, layout, messages, run_response, session, request_tokens)
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception("Mid-turn compaction failed; continuing without it", run_id=run_response.run_id)
        return None


def _finish(
    messages: list[Message],
    layout: _Layout,
    summary_message: Message,
    run_response: RunOutput | TeamRunOutput,
) -> None:
    _rewrite(messages, layout, summary_message)
    _carry_request_usage(run_response, [message for exchange in layout.exchanges for message in exchange])


def _scoped_session(
    binding: _MidTurnCompaction,
    built_session: AgentSession | TeamSession,
    run_response: RunOutput | TeamRunOutput,
) -> AgentSession | TeamSession | None:
    """Return the run's own session when the request replays persisted history, else None (run-local)."""
    target = binding.target
    if not target.add_history_to_context or not isinstance(target.db, BaseDb):
        return None
    return built_session if built_session.session_id == run_response.session_id else None


async def _compact_scope(
    binding: _MidTurnCompaction,
    policy: _Policy,
    layout: _Layout,
    messages: list[Message],
    run_response: RunOutput | TeamRunOutput,
    session: AgentSession | TeamSession,
    request_tokens: int,
) -> Message | None:
    """Archive the scope's visible runs and this run's exchanges behind a new summary, on Agno's own session.

    The turn's exchanges commit together: when a later chunk fails or is cancelled after some of them committed,
    those are rolled back so the request stays unchanged, while chunks of earlier runs stay compacted.
    """
    storage = binding.target.db
    assert isinstance(storage, BaseDb)
    scope = (
        HistoryScope(kind="team", scope_id=binding.target.id or "")
        if isinstance(binding.target, Team)
        else resolve_history_scope(binding.target)
    )
    assert scope is not None
    # Members' runs of this turn exist only in memory until the turn ends, and loading the stored row drops them.
    member_runs = [run for run in session.runs or [] if run.parent_run_id == run_response.run_id]
    snapshots = _snapshots(run_response, layout, policy.inputs)
    try:
        await run_blocking_until_complete(partial(_prepare_scope_session, storage, session, scope))
        try:
            outcome = await compact_scope_mid_turn(
                storage=storage,
                session=session,
                scope=scope,
                resolved_inputs=policy.inputs,
                snapshots=snapshots,
                # The size that triggered this compaction, so the history budget sees what the request needs.
                before_tokens=request_tokens,
                config=binding.config,
                runtime_paths=binding.runtime_paths,
                compaction_lifecycle=binding.lifecycle,
            )
        except asyncio.CancelledError:
            # A fully committed turn archived its exchanges, so the request must not resend them.
            if snapshots and await _turn_committed(storage, session, scope, snapshots):
                _finish(messages, layout, _scope_summary_message(session), run_response)
            raise
        turn_committed = await _turn_committed(storage, session, scope, snapshots)
        # Without exchanges of its own, only an outcome shows that the replayed history was archived.
        committed = turn_committed if snapshots else outcome is not None
    finally:
        kept = {run.run_id for run in session.runs or []}
        session.runs = [*(session.runs or []), *(run for run in member_runs if run.run_id not in kept)]
    return _scope_summary_message(session) if committed else None


def _prepare_scope_session(storage: BaseDb, session: AgentSession | TeamSession, scope: HistoryScope) -> None:
    # A first turn's session row does not exist until Agno writes it when the run ends.
    if storage.get_session(session_id=session.session_id, session_type=_session_type(session)) is None:
        storage.upsert_session(
            new_scope_session(session_id=session.session_id, scope_id=scope.scope_id, is_team=scope.kind == "team"),
        )
    reconcile_compaction_state(storage, session, scope)


def _session_type(session: AgentSession | TeamSession) -> SessionType:
    return SessionType.TEAM if isinstance(session, TeamSession) else SessionType.AGENT


async def _turn_committed(
    storage: BaseDb,
    session: AgentSession | TeamSession,
    scope: HistoryScope,
    snapshots: Sequence[RunOutput | TeamRunOutput],
) -> bool:
    """Return whether every snapshot of this compaction committed, rolling back one that committed only in part."""
    run_ids = [snapshot.run_id or "" for snapshot in snapshots]
    archived = await run_blocking_until_complete(
        partial(archive.archived_run_ids, storage, session_id=session.session_id, run_ids=run_ids),
    )
    if all(run_id in archived for run_id in run_ids):
        return True
    if any(run_id in archived for run_id in run_ids):
        await run_blocking_until_complete(
            partial(roll_back_running_turn, storage, session, scope, run_ids),
        )
    return False


def _scope_summary_message(session: AgentSession | TeamSession) -> Message:
    summary = current_summary_text(session)
    assert summary is not None
    return compaction_summary_message(summary, run_local=False)


def _policy(binding: _MidTurnCompaction) -> _Policy | None:
    """Return the limit text compaction keeps requests under, or None when it cannot run for this request."""
    inputs = binding.resolved_inputs()
    plan = inputs.execution_plan
    if not (plan.authored_compaction_enabled and plan.text_compaction_available) or plan.replay_window_tokens is None:
        return None
    model = cast("Model", binding.target.model)
    replay_model = model if isinstance(model, NativeCompactionModel) else None
    native = replay_model.native_compaction if replay_model is not None else None
    configured = binding.config.models.get(binding.model_name)
    model_window = configured.context_window if configured is not None else None
    return _Policy(
        inputs=inputs,
        limit=context_budget_after_reserve(plan.replay_window_tokens, plan.reserve_tokens),
        fit_limit=context_budget_after_reserve(model_window or plan.replay_window_tokens, plan.reserve_tokens),
        model=model,
        replay_model=replay_model,
        native_route=native.route if native is not None else None,
    )


def _require_fit(policy: _Policy, tokens: int, summary_message: Message) -> None:
    """Refuse to send a rewritten request whose kept messages and summary exceed the model's own window."""
    if tokens <= policy.fit_limit:
        return
    summary_tokens = estimate_text_tokens(str(summary_message.content))
    raise HistorySummaryBudgetError(
        summary_tokens=summary_tokens,
        available_tokens=max(0, policy.fit_limit - (tokens - summary_tokens)),
    )


def _request_tokens(
    binding: _MidTurnCompaction,
    policy: _Policy,
    messages: list[Message],
    tools: list[dict[str, Any]] | None,
    loaded_ids: frozenset[str],
) -> int:
    """Size the next request from the latest response this loop received, else by estimate.

    A native response that created a checkpoint is billed for the transcript it replaced, so native routes always
    estimate their projected request.
    """
    if policy.native_route is not None:
        return (
            estimate_request_messages_tokens(
                messages,
                replay_model=policy.replay_model,
                native_route=policy.native_route,
            )
            # Thinking before the latest checkpoint is part of that checkpoint, not of the request.
            + _thinking_tokens(
                [
                    message
                    for message in native_replay_messages(messages, policy.native_route)
                    if not checkpoint_items(message, policy.native_route)
                ],
            )
            + _tool_tokens(tools)
        )
    anchor = next(
        (
            index
            for index in range(len(messages) - 1, -1, -1)
            if messages[index].role == "assistant" and messages[index].id not in loaded_ids
        ),
        None,
    )
    if anchor is not None:
        configured = binding.config.models.get(binding.model_name)
        reported = response_context_tokens(
            messages[anchor],
            provider=policy.model.get_provider(),
            configured_provider=configured.provider if configured is not None else None,
            model_id=policy.model.id,
        )
        if reported is not None:
            newer = messages[anchor:]
            return (
                reported
                + estimate_request_messages_tokens(newer, replay_model=policy.replay_model)
                + _thinking_tokens(newer)
            )
    return (
        estimate_request_messages_tokens(messages, replay_model=policy.replay_model)
        + _thinking_tokens(messages)
        + _tool_tokens(tools)
    )


def _estimated_request_tokens(policy: _Policy, messages: list[Message], tools: list[dict[str, Any]] | None) -> int:
    return (
        estimate_request_messages_tokens(messages, replay_model=policy.replay_model)
        + _thinking_tokens(messages)
        + _tool_tokens(tools)
    )


def _tool_tokens(tools: list[dict[str, Any]] | None) -> int:
    return estimate_text_tokens(stable_serialize(tools)) if tools else 0


def _thinking_tokens(messages: Sequence[Message]) -> int:
    """Estimate this turn's thinking, which providers resend inside a tool loop but history estimates skip.

    Encrypted or omitted thinking shows no text, so a response's reported output beyond its visible part counts too.
    """
    total = 0
    for message in messages:
        if message.from_history or message.role != "assistant":
            continue
        text = estimate_text_tokens((message.reasoning_content or "") + (message.redacted_reasoning_content or ""))
        reported = message.metrics.output_tokens if message.metrics is not None else 0
        visible = estimate_request_messages_tokens([message], replay_model=None)
        total += max(text, reported - visible, 0)
    return total


def _layout(messages: list[Message], run_response: RunOutput | TeamRunOutput, *, scoped: bool) -> _Layout:
    """Split a request into kept messages, replayed history, and this turn's exchanges to fold.

    A run-local summary this run already wrote seeds the next run-local summary; a scoped compaction folds it into
    the snapshots instead, since the scope summary never saw it.
    """
    leading = next(
        (index for index, message in enumerate(messages) if message.role not in _PROMPT_ROLES),
        len(messages),
    )
    prompt = _current_prompt(messages[leading:], run_response)
    kept: list[Message] = []
    history: list[Message] = []
    exchanges: list[tuple[Message, ...]] = []
    previous: str | None = None
    for exchange in _exchanges(messages[leading:]):
        head = exchange[0]
        if head is prompt or not head.add_to_agent_memory or (_is_queued_notice(head) and not head.from_history):
            kept.extend(exchange)
        elif is_compaction_summary(head) and not head.from_history and not scoped:
            previous = compaction_summary_text(head)
        elif head.from_history:
            history.extend(exchange)
        else:
            exchanges.append(tuple(exchange))
    return _Layout(
        leading=leading,
        kept=tuple(kept),
        history=tuple(history),
        exchanges=tuple(exchanges),
        prompt=prompt,
        previous_run_local_summary=previous,
    )


def _exchanges(messages: Sequence[Message]) -> list[list[Message]]:
    """Group each message with the tool results that answer it, so a tool batch is never split.

    A tool result joins the latest assistant tool call even when a projection, such as an approval receipt, sits
    between them; that projection stays its own exchange.
    """
    exchanges: list[list[Message]] = []
    calls: list[Message] | None = None
    for message in messages:
        if message.role == "tool" and calls is not None:
            calls.append(message)
            continue
        exchanges.append([message])
        if message.role == "assistant":
            calls = exchanges[-1] if message.tool_calls else None
    return exchanges


def _current_prompt(messages: Sequence[Message], run_response: RunOutput | TeamRunOutput) -> Message | None:
    """Return the turn's current user message: the last input message, else Agno's own user message."""
    content = run_response.input.input_content if run_response.input is not None else None
    if isinstance(content, list) and content:
        last = content[-1]
        last_id = last.id if isinstance(last, Message) else last.get("id") if isinstance(last, dict) else None
        match = next((message for message in reversed(messages) if last_id and message.id == last_id), None)
        if match is not None:
            return match
    return next(
        (
            message
            for message in messages
            if message.role == "user"
            and not message.from_history
            and message.add_to_agent_memory
            and not is_compaction_summary(message)
            and not _is_queued_notice(message)
        ),
        None,
    )


def _is_queued_notice(message: Message) -> bool:
    return isinstance(message.provider_data, dict) and bool(message.provider_data.get(QUEUED_MESSAGE_NOTICE_MARKER_KEY))


def _snapshots(
    run_response: RunOutput | TeamRunOutput,
    layout: _Layout,
    inputs: HistoryPreparationInputs,
) -> list[RunOutput | TeamRunOutput]:
    """Return one completed run per folded exchange, oldest first, the first led by the prompt and the run's metadata.

    Separate runs let the summary chunker size the turn with the summary model's own estimator and summarize it in
    as many chunks as it needs, without truncating any exchange that fits a summary input by itself.
    """
    origin = run_response.run_id or ""
    snapshots: list[RunOutput | TeamRunOutput] = []
    budget_tokens = inputs.execution_plan.summary_input_budget_tokens or 0
    for index, exchange in enumerate(layout.exchanges):
        lead = (_prompt_context(layout.prompt, budget_tokens),) if index == 0 and layout.prompt is not None else ()
        run_messages = [*lead, *(message.model_copy(deep=True) for message in exchange)]
        run_id = archive.snapshot_run_id(origin)
        # The run's metadata (provenance for redaction) is the same for every exchange, so the first snapshot holds it.
        metadata = deepcopy(run_response.metadata) if index == 0 else None
        if isinstance(run_response, TeamRunOutput):
            snapshot: RunOutput | TeamRunOutput = TeamRunOutput(
                run_id=run_id,
                team_id=run_response.team_id,
                session_id=run_response.session_id,
                status=RunStatus.completed,
                messages=run_messages,
                metadata=metadata,
                created_at=run_response.created_at,
            )
        else:
            snapshot = RunOutput(
                run_id=run_id,
                agent_id=run_response.agent_id,
                session_id=run_response.session_id,
                status=RunStatus.completed,
                messages=run_messages,
                metadata=metadata,
                created_at=run_response.created_at,
            )
        snapshots.append(snapshot)
    return snapshots


def _history_snapshot(run_response: RunOutput | TeamRunOutput, layout: _Layout) -> list[RunOutput | TeamRunOutput]:
    """Return the request's replayed history as one completed run to summarize, or nothing when there is none."""
    if not layout.history:
        return []
    messages = [message.model_copy(deep=True) for message in layout.history]
    if isinstance(run_response, TeamRunOutput):
        return [
            TeamRunOutput(
                run_id=archive.snapshot_run_id(run_response.run_id or ""),
                team_id=run_response.team_id,
                session_id=run_response.session_id,
                status=RunStatus.completed,
                messages=messages,
            ),
        ]
    return [
        RunOutput(
            run_id=archive.snapshot_run_id(run_response.run_id or ""),
            agent_id=run_response.agent_id,
            session_id=run_response.session_id,
            status=RunStatus.completed,
            messages=messages,
        ),
    ]


def _prompt_context(prompt: Message, budget_tokens: int) -> Message:
    """Return a copy of the prompt for the summarizer's context, bounded so the exchange beside it always fits.

    The prompt stays in the request verbatim, so the summary only needs enough of it to know what the work was for.
    A quarter as many characters as budget tokens keeps it within a quarter of the input even when the summary
    model counts bytes.
    """
    context = prompt.model_copy(deep=True)
    limit = max(budget_tokens // 4, 1)
    if isinstance(context.content, str) and len(context.content) > limit:
        context.content = context.content[:limit] + "\n[The rest of this request is unchanged in the conversation.]"
    return context


async def _summarize_run_locally(
    binding: _MidTurnCompaction,
    inputs: HistoryPreparationInputs,
    layout: _Layout,
    run_response: RunOutput | TeamRunOutput,
) -> Message:
    scope = HistoryScope(
        kind="team" if isinstance(run_response, TeamRunOutput) else "agent",
        scope_id=binding.target.id or "",
    )
    # Without a stored session to archive into, replayed history is summarized together with the turn's exchanges.
    history = _history_snapshot(run_response, layout)
    summary = await summarize_run_locally(
        resolved_inputs=inputs,
        previous_summary=layout.previous_run_local_summary,
        snapshots=[*history, *_snapshots(run_response, layout, inputs)],
        scope=scope,
        config=binding.config,
        runtime_paths=binding.runtime_paths,
        on_response=_summary_usage_recorder(binding, run_response),
    )
    return compaction_summary_message(summary, run_local=True)


def _summary_usage_recorder(
    binding: _MidTurnCompaction,
    run_response: RunOutput | TeamRunOutput,
) -> Callable[[Model, ModelResponse], Awaitable[None]] | None:
    """Record each summary response under the reply's usage owner, else in the target's own session storage."""
    owner = get_helper_usage_owner()
    storage = binding.target.db if isinstance(binding.target.db, BaseDb) else None
    if owner is None and (storage is None or not run_response.session_id):
        logger.warning("Mid-turn summary usage has no storage owner", run_id=run_response.run_id)
        return None

    async def record(model: Model, response: ModelResponse) -> None:
        if response.response_usage is None:
            return
        save = partial(
            save_compaction_usage,
            requester_id=run_response.user_id,
            model_provider=model.get_provider(),
            model=model.id,
            metrics=response.response_usage.to_dict(),
        )
        if owner is not None:
            await run_session_storage_operation(
                owner.storage_factory,
                partial(save, session_id=owner.session_id, initial_session=owner.initial_session),
            )
            return
        assert storage is not None
        assert run_response.session_id is not None
        # The run's own session row may not exist yet while its first turn is still running.
        initial_session = new_scope_session(
            session_id=run_response.session_id,
            scope_id=binding.target.id or "",
            is_team=isinstance(run_response, TeamRunOutput),
        )
        await run_blocking_until_complete(
            partial(save, storage, session_id=run_response.session_id, initial_session=initial_session),
        )

    return record


def _rewrite(messages: list[Message], layout: _Layout, summary_message: Message) -> None:
    """Replace the folded history and the turn's exchanges with the summary, keeping the kept messages in order."""
    leading = messages[: layout.leading]
    for message in leading:
        strip_embedded_summary(message)
    messages[:] = [*leading, summary_message, *layout.kept]


def _carry_request_usage(run_response: RunOutput | TeamRunOutput, folded: Sequence[Message]) -> None:
    """Keep the usage of folded requests in the run, since their messages leave it."""
    requests = project_requests([message.to_dict() for message in folded if message.role == "assistant"])
    if not requests:
        return
    metadata = dict(run_response.metadata or {})
    carried = metadata.get(COMPACTED_REQUESTS_METADATA_KEY)
    metadata[COMPACTED_REQUESTS_METADATA_KEY] = [*(carried if isinstance(carried, list) else []), *requests]
    run_response.metadata = metadata
