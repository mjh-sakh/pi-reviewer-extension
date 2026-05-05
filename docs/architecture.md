# Architecture

## Why this is an internal bridge, not a subprocess subagent

Pi's subprocess-style `subagent` pattern is useful for isolated one-off work, but it is the wrong primitive for a reviewer that must remember prior review turns during the current main session. A subprocess invocation starts a separate Pi process, so it does not keep a persistent in-memory `AgentSession` alive between calls.

This extension instead keeps the reviewer in-process via:
- `createAgentSession(...)`
- `SessionManager.inMemory()`
- `createReadOnlyTools(ctx.cwd)`

That gives the extension a real reviewer session it can reuse across bridge calls in the same main Pi session.

## Main pieces

- `src/index.ts`
  - registers the `reviewer_bridge` tool
  - reacts to `session_start`, `session_switch`, `session_fork`, and `session_shutdown`
- `src/reviewer/session-factory.ts`
  - creates the isolated reviewer session lazily
  - chooses the reviewer model deterministically
  - exposes `ensureReviewerSessionLocked(...)` and `withReviewerSession(...)`
- `src/reviewer/session-state.ts`
  - owns current reviewer session, owner identity, health, and usage counters
- `src/reviewer/reviewer-bridge-tool.ts`
  - gives the main agent a minimal tool surface for consultation
  - keeps ensure + prompt + response extraction inside one serialized critical section
- `src/reviewer/reviewer-maintenance.ts`
  - applies post-call maintenance: usually no-op, sometimes compact, otherwise hard reset

## Reviewer isolation

The reviewer intentionally runs with a separate resource loader so it does not inherit the parent Pi runtime by accident.

Current isolation choices:
- `noExtensions: true`
- `noSkills: true`
- `noPromptTemplates: true`
- `noThemes: true`
- `systemPromptOverride`: reviewer-specific prompt
- `appendSystemPromptOverride: () => []`: suppress appended prompt content
- `agentsFilesOverride: () => ({ agentsFiles: [] })`: strip inherited `AGENTS.md` / context files
- `createReadOnlyTools(ctx.cwd)`: read-only tool surface scoped to the active cwd

This is what prevents reviewer recursion and avoids write-capable behavior leaking into the reviewer.

## Critical-section model

Reviewer access is serialized on purpose.

`withReviewerSession(...)` and `ensureReviewerSessionLocked(...)` are the core primitives:
- exactly one reviewer operation runs at a time
- session creation, reuse, reset, prompting, response extraction, maintenance, and disposal do not race
- the bridge can keep `ensure + prompt + extract current output` inside one lock without nested-lock deadlocks

That makes behavior deterministic and prevents stale-output leakage when multiple bridge calls happen close together.

## Session ownership and lifecycle

Reviewer state is owned by the active main Pi session, not by the whole Node process.

Ownership identity is derived from:
- session file when available, otherwise session id
- current cwd

V1 lifecycle rules:
- reviewer memory is runtime-only
- reviewer resets first; it does not try to preserve state aggressively
- session boundary changes claim a new owner and reset old reviewer state
- switching the main model can also reset the reviewer if the required reviewer target changes, but that target check happens lazily on the next bridge call rather than eagerly at `set_model` time
- `session_shutdown` disposes reviewer state and is intentionally idempotent
- a disposed state can be claimed again later and moved back to `idle`

The shutdown/disposed guard matters because Pi lifecycle hooks may fire cleanup more than once; repeated shutdown should not double-dispose or corrupt counters.

## Strict reviewer model policy

The reviewer is intentionally narrow and deterministic.

Rules:
- provider must be `github-copilot`
- thinking level is always `high`
- reviewer model must be the opposite family from the active main model
- unsupported main models or missing reviewer models fail explicitly during reviewer-session creation
- no fallback path exists

Current routing:
- main `github-copilot/gpt-*` -> reviewer `github-copilot/claude-opus-4.7`
- main `github-copilot/claude-sonnet-*` or `github-copilot/claude-opus-*` -> reviewer `github-copilot/gpt-5.4`
- Haiku and non-Copilot models fail explicitly

The point is to force an actual second-opinion model, not a loosely similar fallback.

## Why `REVIEWER_EXTENSION_ID` exists

`REVIEWER_EXTENSION_ID` is a stable exported identifier for this extension package. In v1 it mainly helps with tests and stable extension identity; it is not used as a dynamic selector for reviewer sessions.

## Expected v1.1 persistence direction

V1 deliberately keeps reviewer memory in memory only. That keeps lifecycle simple and avoids inventing persistence semantics too early.

Expected v1.1 direction:
- add disk-backed reviewer session persistence across Pi restarts
- keep ownership scoped to the main session identity rather than global process lifetime
- persist only extension-owned reviewer state, not arbitrary subprocess state
- preserve the same isolation and reset rules

Disk-backed persistence should be added behind the existing session-state/session-factory boundaries, not by replacing the bridge architecture with subprocess subagents.
