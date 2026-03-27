# Fresh-session reviewer bridge flag

## Overview
- Add an optional `resetSession` boolean to the `reviewer_bridge` tool so the main agent can explicitly request a fresh reviewer session before asking a new question.
- Keep `question` required and preserve the current bridge behavior when `resetSession` is omitted or `false`.
- Implement the reset atomically inside the existing serialized bridge execution so reset, recreation, and prompting happen as one deterministic operation.
- Keep the change minimal and additive: no broader lifecycle redesign, no reset-only mode, and no extra observability fields unless implementation reveals they are necessary.

## Context
- `src/reviewer/reviewer-bridge-tool.ts` owns the tool schema, prompt construction, and the serialized `state.lock.runExclusive(...)` bridge execution path.
- `src/reviewer/session-state.ts` already exposes `resetReviewerSessionStateLocked(...)`, which is the correct primitive for an explicit in-session reset while preserving owner identity.
- `src/reviewer/session-factory.ts` already lazily recreates reviewer sessions through `ensureReviewerSessionLocked(...)`, making reset-then-recreate a natural fit.
- `src/reviewer/reviewer-response.ts` builds the reviewer prompt from `question`, `context`, and `focus`; the new flag should remain tool-only and must not be forwarded into the reviewer prompt.
- Existing coverage in `specs/unit/reviewer-bridge-tool.spec.ts` and `specs/unit/reviewer-session-factory.spec.ts` already exercises serialization, session reuse, reset behavior, and failure paths.
- Docs that explain tool usage and runtime behavior live in `README.md` and `docs/runtime-behavior.md`.

## Development Approach
- testing approach: TDD
- complete each task fully before moving on
- make small, focused changes
- every task must include tests for the code changed in that task
- all tests must pass before starting the next task
- update the plan if scope changes
- keep the change additive and minimal: only introduce `resetSession`, with no other behavior changes unless required for correctness

## Testing Strategy
- update unit tests before or alongside the implementation so the new `resetSession` contract is explicit
- cover success cases for reset-then-ask behavior and session recreation
- cover edge/error scenarios such as `resetSession: true` while already idle and `resetSession: true` combined with model-target-driven reset checks
- verify schema acceptance for the new optional boolean while preserving `additionalProperties: false`
- add/update e2e tests only if runtime-facing behavior unexpectedly cannot be validated by unit tests

## Progress Tracking
- mark completed items with `[x]` immediately
- add newly discovered tasks with ➕
- add blockers with ⚠️
- keep the plan synchronized with actual work

## What Goes Where
- Implementation Steps: actionable in-repo work with checkboxes
- Post-Completion: external/manual follow-up without checkboxes

## Implementation Steps

### Task 1: Add the `resetSession` bridge parameter and atomic reset flow

**Files:**
- Modify: `src/reviewer/reviewer-bridge-tool.ts`
- Modify: `src/reviewer/reviewer-response.ts` (only if types need separation or cleanup to keep `resetSession` out of prompt construction)
- Modify: `specs/unit/reviewer-bridge-tool.spec.ts`

- [x] add `resetSession` as an optional boolean to the `reviewer_bridge` TypeBox schema and tool params type
- [x] keep `question` required and preserve current behavior when `resetSession` is not provided
- [x] implement explicit reset inside the existing `state.lock.runExclusive(...)` block before `ensureReviewerSessionLocked(...)`
- [x] preserve owner identity during explicit resets with `clearOwner: false`
- [x] ensure the prompt sent to the reviewer still contains only `question`, `context`, and `focus`
- [x] write/update tests for success cases, including reset-then-recreate-then-prompt behavior
- [x] write/update tests for edge/error cases, including idle-state reset requests and schema acceptance of the new flag
- [x] run targeted tests before moving on

### Task 2: Harden reset invariants and accounting behavior

**Files:**
- Modify: `specs/unit/reviewer-bridge-tool.spec.ts`
- Modify: `specs/unit/reviewer-session-factory.spec.ts` (if shared reset accounting assertions fit better there)
- Modify: `src/reviewer/session-state.ts` (only if implementation needs a clarifying comment or tiny adjustment for reset accounting)

- [x] add focused coverage proving `resetSession: true` does not leak stale reviewer output or stale session identity
- [x] add focused coverage proving reset accounting does not double-increment when an explicit reset is followed by a no-op owner/model reset path
- [x] add focused coverage for `resetSession: true` combined with a model-family change so only the intended reset semantics are observed
- [x] keep any production-code adjustments minimal and limited to correctness or clarity
- [x] run the relevant unit test files before moving on

### Task 3: Document when and why to use `resetSession`

**Files:**
- Modify: `src/reviewer/reviewer-bridge-tool.ts`
- Modify: `README.md`
- Modify: `docs/runtime-behavior.md`

- [x] update tool prompt guidance so the main agent knows when to use `resetSession`
- [x] document the new optional `resetSession` flag in the tool usage guidance
- [x] explain that `resetSession` performs a fresh reviewer session in the same call rather than a reset-only operation
- [x] describe when the main agent should use it, especially when switching to an unrelated review topic or when prior reviewer memory would be misleading
- [x] confirm the docs stay aligned with the current minimal scope and do not promise extra observability or new lifecycle behavior
- [x] run tests before moving on

### Task 4: Verify acceptance criteria

**Files:**
- Modify: `specs/unit/reviewer-bridge-tool.spec.ts` if verification reveals missing assertions
- Modify: `README.md` if verification reveals a documentation gap
- Modify: `docs/runtime-behavior.md` if verification reveals a behavior-description gap

- [x] verify `reviewer_bridge` accepts `resetSession` as an optional additive field
- [x] verify `question` remains required and reset-in-a-vacuum is still unsupported
- [x] verify `resetSession: true` resets the reviewer before the question is asked
- [x] verify bridge execution remains serialized and deterministic
- [x] verify the reviewer prompt does not include the `resetSession` control flag
- [x] verify edge cases are handled
- [x] run full test suite: `pnpm validate`
- [x] run e2e tests if applicable: `n/a for this repo`

### Taks 5: Conduct a review

**Files:**
- Modify: `docs/plans/completed/20260327-fresh-session-reviewer-bridge-flag.md` if the review changes scope or sequencing
- Modify: implementation/test/doc files only if agreed review findings require changes

- [x] Use subagent or other way to conduct review with another (sub)agent and discuss findings.
- [x] Address agreed issues.

**Review outcome:**
- Reviewer subagent completed a scoped review and found no blocking issues for this feature.
- The following non-blocking/pre-existing cleanup items were intentionally deferred to keep `resetSession` minimal:
  1. `ReviewerStateResetOptions.reason` is currently accepted but not persisted/used.
  2. Blank-question validation errors are not wrapped in the standard `Reviewer bridge failed:` prefix.
  3. There is no explicit `health === "failed"` `resetSession` test.
  4. One test name says "atomically" though it more precisely means serialized under the lock.
- No production-code changes were taken from review for this scoped task.

### Task 6: [Final] Update documentation

**Files:**
- Modify: `README.md` if needed
- Modify: `docs/runtime-behavior.md` if needed
- Move: `docs/plans/20260327-fresh-session-reviewer-bridge-flag.md` -> `docs/plans/completed/20260327-fresh-session-reviewer-bridge-flag.md`

- [x] update README.md if needed
- [x] move this plan to `docs/plans/completed/`

**Documentation note:**
- No further README.md or `docs/runtime-behavior.md` edits were needed after review; the existing documentation changes already cover this minimal feature scope.

## Technical Details
- Add `resetSession?: boolean` to the `reviewer_bridge` parameter schema with `additionalProperties: false` preserved.
- Keep prompt construction decoupled from tool-only control fields so the reviewer sees only the review content, not extension control metadata.
- Execute explicit reset with `resetReviewerSessionStateLocked(state, { clearOwner: false, health: "idle", reason: "tool_requested_session_reset" })` or an equivalent explicit reason string.
- Perform reset before `ensureReviewerSessionLocked(...)` under the same lock so no other bridge call can interleave between reset and prompt.
- Preserve existing error handling: initialization failures remain initialization failures, invocation failures remain invocation failures.
- Keep the implementation additive and avoid introducing reset-only behavior, new tool names, or unrelated lifecycle changes.
- Prefer naming and docs that make the flag’s meaning obvious to the main agent: fresh reviewer session for this call, not a mutation of the string `context` field.

## Post-Completion
- optionally run a quick manual Pi smoke prompt to confirm the main agent can discover and use `resetSession` naturally
- watch for any reviewer-guidance wording issues in normal use and refine prompt guidance later if needed
- if future work needs stronger introspection, evaluate whether response details should expose reset metadata, but keep that out of this scoped change unless required
