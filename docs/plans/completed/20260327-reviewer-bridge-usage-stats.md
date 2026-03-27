# Reviewer Bridge: Usage Stats in Tool Output

## Overview

Add a compact usage stats line to `reviewer_bridge` tool output that mirrors the
subagents style: `7 turns in:23k out:1.5k R90k gpt-5.4:medium`

Currently the tool shows only `"Consulting reviewer..."` during execution and raw
text when done. The change adds:

- **Live progress** (while `isPartial: true`): turn counter + cumulative token stats
  as each reviewer turn completes
- **Final output**: same stats line appended below the response text
- **`renderCall`**: compact header showing the question being reviewed
- **`renderResult`**: renders the above using `Text` components, stats formatted
  with the same `formatTokens` / `formatUsage` helpers copied from subagents

No footer injection, no widget — just the tool row itself.

## Context

**Files involved:**
- `src/reviewer/reviewer-bridge-tool.ts` — main change: subscribe, onUpdate, render
- `specs/unit/reviewer-bridge-tool.spec.ts` — update fake session mock + new tests

**Patterns from subagents (read-only reference):**
- `pi-subagents/formatters.ts` → `formatTokens(n)`, `formatUsage(u, model?)`
- `pi-subagents/render.ts` → `renderResult` with `isPartial` guard + `Container`/`Text`
- `pi-subagents/index.ts` → `renderCall` returning a `Text` node

**Session API used:**
- `session.subscribe(listener)` → returns unsubscribe fn; fires `turn_end` with
  `event.message` (an `AssistantMessage` with `usage: Usage`)
- `session.model?.id` + `session.thinkingLevel` → model label
- `Usage`: `{ input, output, cacheRead, cacheWrite, totalTokens, cost }`

**Constraint:** subscribe/unsubscribe must happen inside `executeReviewerBridge`,
after `session` is obtained but before `session.prompt()`, and cleanup is called
unconditionally in a `finally` block.

## Development Approach

- Testing: regular (tests after implementation, not TDD)
- Complete each task fully before moving on
- All tests must pass before starting the next task

## Testing Strategy

- Unit tests in the existing spec file
- Mock `session.subscribe` in `createFakeReviewerSession`; simulate `turn_end`
  events inside `promptImpl` to verify accumulation + `onUpdate` calls
- Snapshot-free: assert stat substrings in `content[0].text`
- `renderCall` / `renderResult` are pure functions — test their text output directly

## Review Strategy

- Review at the end of the full plan

## Implementation Approach

- Main agent doing all tasks sequentially

## Progress Tracking

- mark completed items with `[x]` immediately
- add newly discovered tasks with ➕
- add blockers with ⚠️

## Implementation Steps

### Task 1: Wire live usage tracking in `executeReviewerBridge`

**Files:**
- Modify: `src/reviewer/reviewer-bridge-tool.ts`
- Modify: `specs/unit/reviewer-bridge-tool.spec.ts`

The execute path already holds `session` before calling `session.prompt()`.
Wrap that section to:
1. Subscribe to `turn_end` on the session, accumulate `Usage` fields and increment
   a turn counter; call `onUpdate` after each turn with the current stats.
2. Unsubscribe in a `finally` block (before maintenance runs).
3. Extend `ReviewerBridgeToolDetails` with optional `turns?: number` and
   `usage?: { input, output, cacheRead, totalTokens }` and `model?: string`.
4. Populate those fields in the final return value.

Inline `formatTokens` and `formatUsage` at the top of the file (copy from subagents,
no import needed — keeps the file self-contained).

- [x] add `formatTokens` + `formatUsage` helpers (inline, ~20 lines)
- [x] extend `ReviewerBridgeToolDetails` with `turns?`, `usage?`, `model?`
- [x] subscribe in execute body; accumulate on `turn_end`; call `onUpdate` with stats
- [x] unsubscribe in `finally`; populate final return details
- [x] add `subscribe: vi.fn()` returning `vi.fn()` to `createFakeReviewerSession`
- [x] write test: `onUpdate` receives correct turn count + token fields per turn
- [x] write test: final result details carry accumulated usage + model
- [x] run `pnpm test` — all pass before moving on

### Task 2: Add `renderCall` and `renderResult` to the tool definition

**Files:**
- Modify: `src/reviewer/reviewer-bridge-tool.ts`

Both are added to the object returned by `createReviewerBridgeTool`. They are pure
functions (no session access needed).

```
renderCall:
  "reviewer  <first 60 chars of question>"
  theme.fg("toolTitle", theme.bold("reviewer ")) + theme.fg("muted", truncated_question)

renderResult (isPartial = true):
  theme.fg("warning", "... ") + stats line (formatUsage style)
  e.g. "... 3 turns in:12k out:0.8k R45k claude-opus-4.6:high"

renderResult (isPartial = false):
  stats line on first row (dim)
  then: response text (plain Text, not Markdown — keeps it compact)
```

Import `Text` from `@mariozechner/pi-tui` (already a dep of pi-coding-agent).

- [x] add `renderCall` returning a `Text` with truncated question
- [x] add `renderResult`: `isPartial` path shows spinner + stats; final path shows
      stats + response
- [x] write test: `renderCall` renders correct question prefix
- [x] write test: `renderResult` with `isPartial:true` and mock details shows stats
- [x] write test: `renderResult` with `isPartial:false` shows response + stats
- [x] run `pnpm validate` — tests + typecheck pass

### Task 3: Verify acceptance criteria

- [x] `pnpm validate` passes clean
- [ ] manually smoke with `pnpm smoke:pi` and call the tool — confirm live turn
  counter updates and final stats line appears
- [ ] move this plan to `docs/plans/completed/`

## Technical Details

**`formatTokens(n)`** — mirrors subagents:
```ts
function formatTokens(n: number): string {
  return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}
```

**`formatUsage(turns, u, model)`**:
```ts
function formatUsage(turns: number, u: AccumulatedUsage, model?: string): string {
  const parts: string[] = [];
  if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
  if (u.input)     parts.push(`in:${formatTokens(u.input)}`);
  if (u.output)    parts.push(`out:${formatTokens(u.output)}`);
  if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
  if (model)       parts.push(model);
  return parts.join(" ");
}
```

**Subscribe pattern inside `executeReviewerBridge`** (inside the lock, after `ensureReviewerSessionLocked`):
```ts
let turns = 0;
const accumulated = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 };
const modelLabel = session.model
  ? `${session.model.id}:${session.thinkingLevel}`
  : undefined;

const unsubscribe = session.subscribe((event) => {
  if (event.type !== "turn_end") return;
  const msg = event.message as any;
  if (msg?.role === "assistant" && msg.usage) {
    turns++;
    accumulated.input     += msg.usage.input ?? 0;
    accumulated.output    += msg.usage.output ?? 0;
    accumulated.cacheRead += msg.usage.cacheRead ?? 0;
    accumulated.totalTokens += msg.usage.totalTokens ?? 0;
  }
  onUpdate?.({
    content: [{ type: "text", text: formatUsage(turns, accumulated, modelLabel) }],
    details: { response: "", turns, usage: accumulated, model: modelLabel },
  });
});

try {
  await session.prompt(prompt);
} finally {
  unsubscribe();
}
```

**Rendering** uses only `Text` (no `Markdown`, no `Container`) to keep it minimal —
a single line for the call and at most two lines for the result.

## Post-Completion

- Observe in real usage whether the turn counter and token counts feel useful at the
  current reviewer thinking level (`high`); if cacheRead dominates, consider showing
  cost instead.
