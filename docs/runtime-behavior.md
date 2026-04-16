# Runtime behavior

## When the main agent should consult the reviewer

Use the reviewer for short, high-value second opinions, for example:
- sanity-checking a plan before making a risky code change
- asking for likely regressions or missing edge cases after an implementation choice
- checking whether a refactor is safe enough to proceed
- asking for a concise critique of a test strategy or migration plan
- asking for a tradeoff summary when two implementation approaches are both plausible

Do not use it for every step. It adds model cost and grows reviewer context.

When you do use it, the first call for a topic should include enough context so the reviewer can navigate quickly instead of spending its first turn figuring out where to look. Good context usually includes:
- repo/package or app area
- the goal or decision under review
- likely files/modules/entrypoints
- current approach, diff summary, or suspected issue
- hard constraints (API contract, migration limits, performance budgets, etc.)

Prefer concrete navigation anchors over generic summaries. File paths, symbol names, and entrypoints are usually more useful than broad architectural prose.

Set `resetSession: true` when you want a fresh reviewer for this call, especially if the next question is unrelated to the prior review thread or if prior reviewer memory would be more misleading than helpful.

Do **not** think of `resetSession` as a reset-only operation. The same call both resets the reviewer session and asks the new question.

## What happens on each `reviewer_bridge` call

1. The main agent calls `reviewer_bridge` with one concrete question, optional task `context`/`focus`, and optional `resetSession`.
2. The extension acquires the reviewer lock.
3. If `resetSession: true`, the extension clears reviewer session state first inside that same serialized execution.
4. `ensureReviewerSessionLocked(...)` either reuses the current reviewer session or creates one lazily.
5. The reviewer is prompted.
6. The bridge extracts only the current invocation's final reviewer output, using the message boundary from before the prompt.
7. Post-call maintenance runs.
8. The lock is released and the main agent gets a compact response.

This is why the bridge returns only current-call output rather than scanning arbitrary prior messages.

## Lifecycle expectations in v1

### Runtime-only memory

Reviewer memory survives multiple bridge calls in the same live Pi session/process.

Reviewer memory does **not** survive:
- Pi restarts
- extension reloads that rebuild in-memory state
- session owner changes
- model-target changes that require a new reviewer session
- hard resets after repeated failures

### Reset-first lifecycle control

V1 prefers reset over clever state preservation.

Hard reset is the primary control path when:
- main-session ownership changes (`session_start`, `session_switch`, `session_fork`)
- the active main model implies a different reviewer target
- repeated reviewer invocation failures hit the threshold of `3`
- compaction is needed but not viable
- compaction fails

### Minimal compaction only

Compaction exists only as a small pressure-release mechanism.

Current behavior:
- if context usage is unavailable, do nothing
- if usage is below threshold, do nothing
- if usage reaches the threshold and compaction is viable, compact with static extension-owned instructions
- if usage reaches the threshold and compaction is not viable, hard reset
- if compaction throws, hard reset

The extension does not accept user-authored compaction instructions.

## Context-usage normalization heuristic

The lifecycle policy normalizes context usage so both of these inputs behave sensibly:
- `0.83`
- `83`

Anything `>= 1` is treated as a percentage and divided by `100`, so the threshold can stay conceptually at `80%`.

Tradeoff:
- this is a practical SDK-compatibility heuristic, not a perfect contract
- if a future SDK changes semantics again, the extension could compact or reset slightly earlier/later than intended until updated

In v1 that tradeoff is acceptable because reset-first behavior is already the dominant safety mechanism.

## Model-switch behavior

Reviewer target selection depends on the active main model family.

That means a main-model switch can force a reviewer reset even inside the same live main session:
- GPT main -> Opus reviewer
- Sonnet/Opus main -> GPT reviewer

Important detail: this reset is evaluated lazily on the **next `reviewer_bridge` call**. The extension does not eagerly recreate the reviewer session at `set_model` time; instead, `ensureReviewerSessionLocked(...)` compares the required reviewer target for the current main model against the existing reviewer target and resets only if they differ.

This was validated in runtime smoke work: after switching the main model family, the next bridge call did not reuse prior reviewer memory.

## Shutdown behavior

`session_shutdown` disposes reviewer state and marks health as `disposed`.

Important details:
- shutdown cleanup is idempotent
- repeated shutdown should not double-dispose the reviewer session
- later session ownership claims can safely move state back out of `disposed`

This keeps lifecycle hooks safe even if cleanup paths are retried.

## Limitations and tradeoffs

### Token cost

Every reviewer consultation is an additional model call. If the main agent consults the reviewer too often, token cost rises quickly.

### Context growth

Because reviewer memory is intentionally preserved during a live session, repeated consultations grow reviewer context. Minimal compaction helps only a little; resets remain the real control path.

### Strict model policy means explicit failures

There is no fallback model. Unsupported main-model setups fail fast instead of silently choosing a weaker reviewer. In practice, reviewer session creation fails explicitly before prompt execution if the active main model is not a supported GitHub Copilot GPT, Sonnet, or Opus model, or if the required opposite-family reviewer model is unavailable in the registry.

### Read-only reviewer

The reviewer can inspect but not mutate. That is intentional for safety, but it also means the reviewer cannot directly run write/edit/bash workflows.

### Serialized access

Concurrent bridge calls are safe, but they are also queued. Throughput is intentionally lower than a fan-out design.

## Smoke commands: quick vs isolated

### Quick check

```bash
pnpm smoke:pi
```

Purpose:
- quick local package-loading sanity check
- good for confirming the extension starts and registers

Not sufficient for:
- proving same-session reviewer memory
- proving model-switch resets
- proving reviewer isolation in a controlled runtime

### Isolated RPC smoke validation

Use the command in `docs/manual-smoke-checklist.md` when you need stronger evidence.

Purpose:
- validate `-e .` package loading in a controlled run
- keep one live process/session for multiple prompts
- observe bridge tool events directly
- validate same-session memory, isolation, and model-switch reset behavior

## Practical consultation examples

Good examples:
- "Review this migration plan for likely rollback and data-integrity risks."
- "Give me the top two regression risks in this refactor and the tests that would reduce them."
- "Critique this implementation choice under the constraint that we cannot change the API contract."

Bad examples:
- using the reviewer for trivial factual lookups
- calling the reviewer on every small edit
- asking it to perform mutations rather than critique or inspect
