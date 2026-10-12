# Positioned mid-turn compaction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement this plan task-by-task with the skill named in **Execution**.
> Steps use checkbox (`- [ ]`) syntax.

**Execution:** baspowers:executing-plans — the tasks share one storage contract and are mostly deletions and narrow additions, so one context with a fresh three-model review at the end fits better than per-task subagents.

**Goal:** Replace the archived snapshots of a running turn with one positioned generation per mid-turn compaction of a stored conversation, keeping the user-visible behavior.

**Architecture:** A mid-turn compaction summarizes in memory, commits one generation holding the summary, its position run, its frozen covered runs, and their event ids, sets the summary on Agno's live session object, and rewrites the request; reconcile later materializes, deletes, or rolls back each positioned generation from durable state; one invalidation operation serves rollback and retirement and removes dependent position runs.

**Tech Stack:** Python 3.13, Agno 3.0.9, SQLite archive tables beside Agno's session table, pytest.

**Spec:** `docs/dev/2026-10-10-compaction-unification-design.md`, section 5 as revised October 11, 2026.

## Global Constraints

- AGENTS.md rules apply: `LEGACY_COMPAT` markers for old-format readers, `AGNO_COMPAT` markers for private Agno access, Tach updated with imports, tests at the owning seam, failing test first, one sentence per line in Markdown.
- Archived rows written before this release carry no `run_index`; they restore by appending in archive order, as today (`LEGACY_COMPAT`).
- Existing archives gain the new columns when the conversation database opens, under the open-time migration's write lock, and replies never alter the archive; ordinary and legacy generations stay unpositioned.
- User docs do not change: the behavior a user observes is the same as the snapshot design.
- No production branch exists only to keep an old test passing; snapshot-design tests are rewritten or deleted.

## Review Focus

1. A crash between the generation commit and the position run's next save, for a new run, a resumed paused run, and a second fold: the summary and the run's record must agree after reconcile.
2. Every continuation path that reloads stored history (agent, team, member, delegated child, automatic continuation after a delegation) reconciles before Agno fetches history.
3. Redaction or edit of a covered run, of the position run, and of a run archived later, before and after materialization, including a resumed older position run that covered newer runs: no shortened run outlives its summary and no removed content replays.
4. Materialization archives exactly the frozen covered runs, once, and never a retired generation.
5. Restored runs keep their original order after reopening storage, including a history archived whole twice and an older pending approval.

---

### Task 1: Archive columns and original run order

**Files:**
- Modify: `src/mindroom/history/archive_schema.py`, `src/mindroom/history/archive.py`, `src/mindroom/session_storage/agno_compat_sqlite.py`
- Test: `tests/test_history_archive.py`

**Interfaces:**
- Produces: generations gain nullable `through_run_id TEXT`, `covered_run_ids TEXT`, `event_ids TEXT`, `seen_event_ids TEXT`; archived runs gain nullable `run_index INTEGER`; `archive_runs(..., generation_id: int | None = None)` appends to an existing generation when given and records each run's stored `run_index`; `insert_run_row(..., run_index: int | None = None)` writes an explicit index.

- [ ] **Step 1: Write the failing tests** `test_existing_archive_gains_the_new_columns` (create both tables with the old DDL, ensure them, assert the columns exist and old rows read as unpositioned) and `test_rollback_restores_runs_at_their_original_indexes_after_reopening` (runs `r1`, paused `p`, `x`; archive `r1`; roll back; reopen the database; assert stored order `r1, p`).
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_history_archive.py -k "new_columns or original_indexes"`.
      Expected: both FAIL.
- [ ] **Step 3: Implement** the additive DDL (check `PRAGMA table_info`, then `ALTER TABLE ... ADD COLUMN`), index capture inside `archive_runs`' transaction, and restore at the captured index in `roll_back_to`; rows without an index keep appending, under a `LEGACY_COMPAT` marker.
- [ ] **Step 4: Run** the same command.
      Expected: PASS; then `tests/test_history_archive.py` and `tests/test_compaction_redaction.py` stay green.
- [ ] **Step 5: Commit** `feat(history): keep each archived run's original index and add positioned-generation columns`.

### Task 2: Positioned generations and one invalidation operation

**Files:**
- Modify: `src/mindroom/history/archive.py`
- Test: `tests/test_history_archive.py`

**Interfaces:**
- Consumes: Task 1 columns.
- Produces:
  - `record_positioned_generation(storage, *, session_id: str, scope_key: str, summary: str, summary_model: str, through_run_id: str, covered_run_ids: Sequence[str], event_ids: Collection[str], seen_event_ids: Collection[str]) -> int`.
  - `positioned_generations(storage, *, session_id: str, scope_key: str) -> list[PositionedGeneration]` with `id`, `through_run_id`, `covered_run_ids`, `has_summary`.
  - `earliest_dependent_generation(storage, *, session_id: str, scope_key: str, run_ids: Collection[str]) -> ArchiveHit | None`, replacing `earliest_archived_run`: the earliest generation that archived, covers, or is positioned on one of `run_ids`, ignoring tombstones.
  - `roll_back_to(...)` removes the live position run (and member subtree) of every positioned generation it retires; `retire_summaries` and `clear_to_legacy` do the same and clear positions and covered lists.
  - `compacted_event_ids` and `redactable_compacted_event_ids` include the event ids of positioned generations after the latest summary-less barrier.
  - `snapshot_run_id` and `snapshot_origin` are deleted.

- [ ] **Step 1: Write the failing tests** `test_positioned_generation_counts_its_events_as_compacted`, `test_rolling_back_a_positioned_generation_removes_its_position_run`, `test_retiring_summaries_removes_shortened_position_runs`, `test_earliest_dependent_generation_finds_covering_and_positioned_generations`.
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_history_archive.py -k "positioned or dependent or shortened"`.
      Expected: FAIL (missing functions).
- [ ] **Step 3: Implement** the functions above; the invalidation helper is private and shared by `roll_back_to`, `retire_summaries`, and `clear_to_legacy`.
- [ ] **Step 4: Run** the same command.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): record positioned generations and invalidate them with their position runs`.

### Task 3: Reconcile and removal through dependencies

**Files:**
- Modify: `src/mindroom/history/storage.py`, `src/mindroom/session_storage/agno_compat_sqlite.py`
- Test: `tests/test_compaction_redaction.py`

**Interfaces:**
- Consumes: Task 2.
- Produces: `reconcile_compaction_state` derives each positioned generation's state from the position run's stored row and its `mindroom_mid_turn_generation` metadata value: applied (materialize its still-live covered runs into it), unapplied (delete it, keep the run), orphaned (invalidate from it); `remove_runs_for_sources` and redaction roll back from `earliest_dependent_generation` of the removed runs; `roll_back_running_turn`, the `keep_last` parameter, and `move_run_to_end` are deleted.

- [ ] **Step 1: Rewrite the snapshot tests as positioned-generation tests**, failing first: edit of the position run, redaction of an event the run consumed before and after the fold and of its reply, redaction of a covered run, each before and after materialization and after a later generation archived the position run; an older paused run survives in order; the round-11 and Greptile scenarios; crash states (no stored position run, older paused row, row reflecting only an earlier fold).
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_compaction_redaction.py`.
      Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the reconcile states and dependency-based removal.
- [ ] **Step 4: Run** `/work/tmp/pt.sh tests/test_compaction_redaction.py tests/test_history_archive.py tests/test_edit_response_regeneration.py`.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): reconcile positioned generations and roll back through dependencies`.

### Task 4: Mid-turn commit of a positioned generation

**Files:**
- Modify: `src/mindroom/history/mid_turn_compaction.py`, `src/mindroom/history/runtime.py`, `src/mindroom/history/compaction.py`
- Test: `tests/test_mid_turn_compaction.py`

**Interfaces:**
- Consumes: Tasks 2 and 3; `summarize_runs` for the chunk loop; `built_request_session(target, run_id)` for Agno's live session.
- Produces: `compact_scope_mid_turn(*, storage, session, scope, resolved_inputs, covered_runs, snapshots, through_run_id, before_tokens, config, runtime_paths, compaction_lifecycle) -> CompactionOutcome | None`, which summarizes, emits hooks and notices, records usage, and commits; the hook then sets the summary on Agno's session object, rewrites the request, and records `mindroom_mid_turn_generation`; `compact_scope_history` loses `in_progress`.

- [ ] **Step 1: Update the scoped tests first**: the next reply replays `[summary, position run prompt and tail]` with no summary call and its reconcile archives exactly the covered runs; the session row Agno writes at the run's end holds the new summary; a second fold covers no run twice; a resumed older run covering newer runs; a failure in any chunk leaves request and storage unchanged; a cancellation after the commit leaves the request and the run's record whole, and the next reconcile discards the fold; folded unseen thread context of a stopped run stays seen; hooks and notice counts.
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_mid_turn_compaction.py`.
      Expected: the updated tests FAIL.
- [ ] **Step 3: Implement** the new commit path and delete `_turn_committed`, member-run restore, snapshot archiving, and the `in_progress` plumbing.
- [ ] **Step 4: Run** `/work/tmp/pt.sh tests/test_mid_turn_compaction.py tests/test_history_compaction_rewrite.py tests/test_compaction_redaction.py`.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): commit one positioned generation per mid-turn compaction`.

### Task 5: Reconcile before every continuation

**Files:**
- Modify: `src/mindroom/history/agno_compat_message_builder.py`, `src/mindroom/approval/execution.py`, `src/mindroom/teams.py`, `src/mindroom/delegation/execution.py`
- Test: `tests/test_mid_turn_compaction.py`, `tests/test_history_summary_message.py`

**Interfaces:**
- Consumes: `reconcile_compaction_state`.
- Produces: the continuation builders reconcile the session Agno loaded before calling Agno's builder when the target replays persisted history and has storage; the three recovery paths reconcile before `restore_native_history`.

- [ ] **Step 1: Write the failing tests**: an agent approval resume, a team approval resume, and an automatic continuation after a delegation, each after a mid-turn compaction before the pause, replay one summary and no covered run.
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_mid_turn_compaction.py -k continuation`.
      Expected: FAIL.
- [ ] **Step 3: Implement** the builder reconcile (off the event loop in the async builders) and the three recovery calls.
- [ ] **Step 4: Run** the same command plus `tests/test_history_summary_message.py tests/test_approval_receipt.py`.
      Expected: PASS.
- [ ] **Step 5: Commit** `feat(history): reconcile stored history before every continuation`.

### Task 6: Fuzz, docs, markers, and Tach

**Files:**
- Modify: `tests/test_compaction_fuzz.py`, `docs/architecture/compaction.md`, `docs/architecture/migrations.md`, `docs/architecture/agno-compatibility.md`, `docs/architecture/code-map.md`, `tach.toml`

- [ ] **Step 1: Extend the fuzz test** with positioned compactions, materialization, edits, redactions, retirements, and reopen; invariants: replay is the latest summary plus uncovered runs, no shortened run without its generation, stored order matches creation order.
- [ ] **Step 2: Run** `/work/tmp/pt.sh tests/test_compaction_fuzz.py`.
      Expected: PASS after fixing what it finds.
- [ ] **Step 3: Update** the architecture pages and markers for the new columns, the run-index reads and writes, and the deleted snapshot code; run `uv run tach check --dependencies --interfaces`.
- [ ] **Step 4: Run** pre-commit on all files and the full suite.
      Expected: green.
- [ ] **Step 5: Commit** `docs(history): describe positioned generations` and push.

### Final verification

- Live tests over Matrix on two providers: a mid-turn compaction, the next reply, and an approval resume after a mid-turn compaction.
- Fresh full reviews by Opus 5.5, GPT-6.1 Sol, and GPT-6 Astra at the same head, plus bot triage.
