# Stateful Internal Reviewer for Pi

## Overview
- Build a dedicated TypeScript project at `~/ai/pi-reviewer-extension` that implements a Pi extension for a stateful reviewer.
- The main Pi agent should be able to invoke the reviewer dynamically during its own reasoning flow, without requiring user commands or a user-managed workflow.
- The reviewer should keep conversational context alive for the active main Pi session, use read-only tools for independent inspection, and be managed entirely by the extension.
- The implementation should align with Pi’s real extension and SDK APIs, not the subprocess-based `subagent` example.
- V1 should prioritize correctness and determinism: isolated reviewer loader, serialized reviewer access, simple reset policy, and only minimal compaction if clearly needed.

## Context
- Pi extensions are discovered from `~/.pi/agent/extensions/` or `.pi/extensions/` and can register tools, commands, lifecycle hooks, and UI behaviors.
- Dynamic reviewer consultation in Pi needs a first-class LLM invocation surface. In practice, that means a custom extension tool, even if it is architecturally internal and not intended as a user workflow primitive.
- The built-in `examples/extensions/subagent/` pattern uses separate `pi` subprocesses and therefore does not preserve reviewer conversation state between invocations.
- The correct persistent-session primitive is `createAgentSession(...)` with `SessionManager.inMemory()`.
- A reviewer-specific system prompt should be provided through `DefaultResourceLoader({ systemPromptOverride })`, not as a direct `createAgentSession` option.
- The reviewer should use `createReadOnlyTools(ctx.cwd)` so file access is read-only and scoped correctly to the active working directory.
- The reviewer loader should be isolated from normal Pi discovery to avoid inheriting unrelated extensions, prompts, skills, or recursive self-loading.
- The repo directory now exists only because this plan file was created there first, so repo bootstrap is still required.

## Architecture Invariants
- Reviewer state is scoped to the active main Pi session, not the whole process lifetime.
- Reviewer state resets on main-session boundary changes such as session switch or fork unless a later design explicitly proves reuse is safe.
- Reviewer access is serialized through a single queue/mutex; prompt, reset, compact, and dispose operations must not race.
- Reviewer uses read-only tools only and must not inherit write-capable behavior accidentally.
- Reviewer resource loading is isolated: no recursive reviewer extension loading, no unintended extension inheritance, and prompt composition is explicit.
- Reviewer output returned to the main agent must come only from the current reviewer invocation, not from stale prior messages.
- Runtime-only reviewer memory is a deliberate v1 limitation; cross-restart persistence is future work.

## Development Approach
- testing approach: Light tests only for core session behavior
- complete each task fully before moving on
- make small, focused changes
- every task must include tests for the code changed in that task
- all tests must pass before starting the next task
- update the plan if scope changes

## Testing Strategy
- use lightweight unit tests for core reviewer session behavior, bridge behavior, session-boundary reset logic, and lifecycle policy decisions
- avoid broad integration/e2e coverage in v1 unless runtime behavior proves hard to validate with unit tests
- add one early real-Pi smoke validation step to catch SDK/runtime integration issues that unit tests may miss
- cover success and error scenarios for session creation, reuse, serialization, response extraction, reset conditions, and any minimal compaction behavior kept in v1
- add a minimal typecheck command to catch SDK/API drift early

## Progress Tracking
- mark completed items with `[x]` immediately
- add newly discovered tasks with ➕
- add blockers with ⚠️
- keep the plan synchronized with actual work

## What Goes Where
- Implementation Steps: actionable in-repo work with checkboxes
- Post-Completion: external/manual follow-up without checkboxes

## Implementation Steps

### Task 1: Bootstrap the dedicated extension repository

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `README.md`
- Create: `src/index.ts`
- Create: `specs/unit/`
- Modify: `docs/plans/completed/20260327-stateful-internal-reviewer-for-pi.md`

- [x] bootstrap `~/ai/pi-reviewer-extension` as a dedicated TypeScript package for a Pi extension around the existing plan scaffold
- [x] add scripts for test, typecheck, and local development validation
- [x] add base dependency set for `@mariozechner/pi-coding-agent`, `@sinclair/typebox`, `typescript`, and `vitest`
- [x] define a minimal extension entrypoint scaffold in `src/index.ts`
- [x] avoid unnecessary build/publish complexity in v1; local TypeScript loading via Pi should work without a compile step
- [x] add a smoke-level test scaffold proving the test runner works
- [x] run tests before moving on

### Task 2: Implement reviewer session creation, isolation, and ownership

**Files:**
- Create: `src/reviewer/session-factory.ts`
- Create: `src/reviewer/session-state.ts`
- Create: `src/reviewer/reviewer-lock.ts`
- Modify: `src/index.ts`
- Create: `specs/unit/reviewer-session-factory.spec.ts`

- [x] implement lazy creation of a reviewer `AgentSession` using `createAgentSession(...)`
- [x] configure the reviewer session with `SessionManager.inMemory()` for v1 runtime-only persistence
- [x] scope reviewer state to the active main Pi session rather than raw process lifetime
- [x] reset reviewer state on main-session boundary events such as session switch and fork
- [x] serialize reviewer operations with a single queue or mutex so prompt, reset, compact, and dispose cannot race
- [x] create an isolated reviewer `DefaultResourceLoader` configuration with explicit decisions for extensions, prompt templates, skills, AGENTS/context files, and appended prompt content
- [x] set reviewer-specific system prompt via `DefaultResourceLoader({ systemPromptOverride })`
- [x] use `createReadOnlyTools(ctx.cwd)` for reviewer capabilities
- [x] define strict reviewer model selection behavior: GitHub Copilot provider only, opposite model family from the active main model, no fallback
- [x] define in-memory extension state for current reviewer session, session owner identity, health state, and usage metadata needed for lifecycle decisions
- [x] write tests for session creation, session reuse, session-boundary reset behavior, serialization, and disposal behavior
- [x] write tests for edge/error cases such as failed initialization, isolated loader misconfiguration, and safe recovery paths
- [x] run tests before moving on

### Task 3: Implement the internal reviewer bridge for dynamic agent-triggered consultation

➕ Supporting primitive: use `withReviewerSession(...)` / `ensureReviewerSessionLocked(...)` so Task 3 can keep ensure + prompt + extraction inside one critical section without nested-lock deadlocks.

**Files:**
- Create: `src/reviewer/reviewer-bridge-tool.ts`
- Create: `src/reviewer/reviewer-response.ts`
- Modify: `src/index.ts`
- Create: `specs/unit/reviewer-bridge-tool.spec.ts`

- [x] implement an internal LLM-facing extension tool that allows the main Pi agent to consult the reviewer dynamically
- [x] shape the bridge as architectural infrastructure rather than a user-managed workflow primitive
- [x] keep the bridge schema small and focused on review consultation
- [x] extract only the current invocation’s final reviewer output by tracking the message boundary before and after `session.prompt(...)`
- [x] add `promptSnippet` and `promptGuidelines` so the main agent knows when to use reviewer consultation and how to incorporate reviewer feedback
- [x] ensure reviewer replies are returned in a compact, decision-useful format suitable for iterative back-and-forth
- [x] reset and recreate the reviewer session when the active main-session reviewer target model changes
- [x] write tests for successful reviewer round-trips, message-boundary tracking, and response extraction
- [x] write tests for edge/error cases such as empty assistant output, malformed message content, stale-output leakage, and reviewer execution failures
- [x] run tests before moving on

### Task 4: Validate the bridge in a real Pi runtime

**Files:**
- Modify: `README.md`
- Create: `docs/manual-smoke-checklist.md`

- [x] manually validate package/directory loading via `pi -e .` before running bridge checks in a real Pi session
- [x] manually validate in a real Pi session that the main agent can invoke the reviewer bridge and receive a response
- [x] confirm reviewer state persists across at least two consultations in the same main session
- [x] confirm reviewer does not recurse by loading this extension again inside itself
- [x] confirm reviewer does not expose write-capable tools
- [x] capture any runtime surprises before investing further in lifecycle complexity
- [x] update the plan if the real-runtime behavior differs from assumptions

Runtime notes from the 2026-03-27 smoke run:
- reviewer persistence probes should use legitimate review artifacts; a “memorize this secret token” probe was treated as prompt injection and correctly refused
- for RPC model switching, keep `high` thinking explicit with `set_thinking_level` after `set_model`
- reviewer isolation probes should prefer question-only bridge calls and verify `tool_execution_start.args`, because the main agent may otherwise add helpful-but-misleading context of its own

### Task 5: Add reset policy and minimal compaction behavior

**Files:**
- Create: `src/reviewer/lifecycle-policy.ts`
- Create: `src/reviewer/reviewer-maintenance.ts`
- Modify: `src/index.ts`
- Create: `specs/unit/lifecycle-policy.spec.ts`

- [x] define hard-reset conditions such as repeated reviewer failures, main-session boundary changes, or clearly unhealthy session state
- [x] implement reset behavior as the primary v1 lifecycle control path
- [x] add a small compaction-viability check for the in-memory reviewer session before depending on compaction in policy logic
- [x] if compaction remains in v1, keep it minimal, explicit, and triggered only by clear thresholds such as `>= 80%` context usage or equivalent history-growth bounds
- [x] track consecutive reviewer invocation failures separately from initialization failures and hard-reset after a clear threshold such as `3` consecutive invocation failures
- [x] treat undefined reviewer context-usage readings as "no action needed" rather than triggering compaction/reset
- [x] keep compaction instructions extension-owned and static; do not derive them from user-supplied reviewer prompts
- [x] implement compaction fallback to hard reset if compaction fails
- [x] ensure reset and any kept compaction behavior are extension-managed with no user interaction required
- [x] make lifecycle behavior deterministic enough to test without needing full interactive Pi runtime coverage
- [x] note that runtime validation of `session_start` / `session_switch` event firing under normal persisted sessions is deferred to Task 6
- [x] write tests for reset decision logic and any compaction decision logic kept in v1
- [x] write tests for edge/error cases such as compaction failure fallback to hard reset
- [x] run tests before moving on

### Task 6: Wire extension startup, shutdown, and installation ergonomics

**Files:**
- Modify: `src/index.ts`
- Modify: `README.md`
- Create: `scripts/link-extension.sh`
- Create: `specs/unit/index-lifecycle.spec.ts`

- [x] wire extension initialization cleanly at load time without eagerly creating the reviewer session
- [x] clean up reviewer state on Pi shutdown via extension lifecycle hooks
- [x] document how to link or symlink the extension directory/package into `~/.pi/agent/extensions/`
- [x] document how to reload Pi and validate the extension is active
- [x] add a helper script or documented command for local install/symlink workflow
- [x] write behavioral tests for `session_start`, `session_switch`, `session_fork`, and `session_shutdown` lifecycle orchestration
- [x] write tests for edge/error cases around repeated initialization or shutdown cleanup
- [x] run tests before moving on

### Task 7: Document architecture and operator expectations

**Files:**
- Modify: `README.md`
- Create: `docs/architecture.md`
- Create: `docs/runtime-behavior.md`

- [x] document why the implementation uses an internal bridge instead of the subprocess `subagent` model
- [x] document reviewer lifecycle expectations: runtime-only memory, reset-first lifecycle control, and any minimal compaction kept in v1
- [x] document limitations and tradeoffs, especially token cost and context growth
- [x] document strict reviewer model policy: GitHub Copilot only, opposite-family reviewer selection, no fallback, high thinking level
- [x] document expected future v1.1 path for disk-backed persistence across Pi restarts
- [x] add concise examples of when the main agent should consult the reviewer
- [x] add/update lightweight documentation checks if introduced
- [x] run tests before moving on

### Task 8: Verify acceptance criteria

**Files:**
- Modify: `README.md` if verification reveals usage gaps
- Modify: `docs/architecture.md` if behavior differs from plan

- [x] verify the main agent can dynamically consult the reviewer without user commands
- [x] verify reviewer context is preserved across multiple review exchanges during a single main Pi session
- [x] verify reviewer state resets correctly when the main Pi session changes
- [x] verify reviewer uses read-only tools only
- [x] verify reviewer session does not recursively load this extension or inherit unintended runtime behavior
- [x] verify concurrent bridge calls are serialized safely
- [x] verify the bridge returns only the current reviewer invocation output
- [x] verify reset behavior and any kept compaction behavior match the defined lifecycle policy
- [x] verify strict reviewer model selection behavior is deterministic, documented, and fails explicitly when unsupported
- [x] verify edge cases are handled
- [x] run full test suite: `pnpm test && pnpm typecheck`
- [x] run e2e tests if applicable: `n/a for v1 unless lightweight runtime validation is added`

### Task 9: [Final] Update documentation

**Files:**
- Modify: `README.md` if needed
- Modify: `CLAUDE.md` or project guidance files if new patterns were discovered
- Move: `docs/plans/20260327-stateful-internal-reviewer-for-pi.md` -> `docs/plans/completed/20260327-stateful-internal-reviewer-for-pi.md`

- [x] review `README.md`; no further changes were needed because Tasks 4/6/7/8 already captured the runtime/install/architecture guidance
- [x] review `CLAUDE.md` / project guidance needs; no update was needed because no such project guidance file exists in this repo and no new reusable project pattern was discovered in Task 9
- [x] move this plan to `docs/plans/completed/`

## Technical Details
- The extension should be structured as a normal TypeScript repo, but the runtime entrypoint should remain compatible with Pi’s extension loading model.
- The reviewer session should be created lazily and stored in extension-managed state keyed to the active main Pi session.
- Reviewer session creation should use:
  - `AuthStorage.create()`
  - `ModelRegistry`
  - an isolated `DefaultResourceLoader` with reviewer prompt override and explicit inheritance decisions
  - `SessionManager.inMemory()`
  - `createReadOnlyTools(ctx.cwd)`
- The dynamic reviewer mechanism should be implemented through a custom extension tool callable by the main agent, because Pi’s extension model needs a first-class invocation surface for LLM-driven delegation.
- The bridge is architecturally internal, but still a real tool from Pi’s perspective; usage should be guided through description, `promptSnippet`, and `promptGuidelines`.
- The bridge should not rely on subprocess execution, since that would destroy the persistent reviewer conversation.
- Reviewer output extraction must return only the current invocation’s final assistant output, using explicit message-boundary tracking rather than a loose scan of all `session.messages`.
- Reviewer operations should be serialized so prompt, reset, compact, and dispose cannot interleave unsafely.
- Reviewer loader isolation should be explicit enough to prevent recursive extension loading and unintended inheritance of prompts, skills, or tool behavior.
- Model behavior should be deterministic and documented: use GitHub Copilot provider only, choose the opposite model family from the active main model, use high thinking level for the reviewer, and fail explicitly with no fallback when unsupported.
- Reset policy should be the primary v1 lifecycle mechanism. If compaction remains in v1, it should be minimal, explicit, and always fall back to hard reset on failure.
- Hard reset conditions should be conservative and extension-owned, for example:
  - main-session boundary changes
  - repeated reviewer invocation failures
  - reviewer compaction failure
  - invalid or empty assistant responses across consecutive attempts
- Main-model routing policy for v1:
  - if the active main model is a GitHub Copilot GPT model, reviewer must use the GitHub Copilot Opus model
  - if the active main model is a GitHub Copilot Sonnet or Opus model, reviewer must use the GitHub Copilot GPT model
  - no fallback path is allowed
  - unsupported main models must fail explicitly with a clear error
- Keep v1 focused on runtime-only persistence. Cross-restart persistence should be documented as a future enhancement rather than folded into current implementation.

## Post-Completion
- manually symlink the extension directory/package into `~/.pi/agent/extensions/`
- validate behavior in a real Pi session with a short implementation/review loop
- decide whether to publish the repo or keep it as a personal local extension package
- evaluate whether v1.1 should add disk-backed reviewer session persistence across Pi restarts
- evaluate whether reviewer consultation guidance needs prompt tuning after real usage
