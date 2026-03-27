# ESC-ESC Interrupt Support for Reviewer Bridge

## Overview

When the user presses ESC-ESC in pi, the framework aborts the `AbortSignal` it passes to the currently running
tool's `execute` function. The reviewer bridge tool currently ignores this signal entirely (`_signal`), so the
reviewer's `session.prompt()` keeps running until the LLM finishes — making the reviewer uninterruptible.

**The fix:** thread the signal from `execute` → `executeReviewerBridge` → `session.abort()` when the signal fires,
and skip failure accounting when the abort is user-initiated.

## Context

**Files involved:**
- `src/reviewer/reviewer-bridge-tool.ts` — only file that needs to change
- `specs/unit/reviewer-bridge-tool.spec.ts` — test coverage lives here (1 274 lines, vitest)

**Key facts from the codebase:**
- `execute(_toolCallId, params, _signal, onUpdate, ctx)` — `_signal` is intentionally unused today
- `executeReviewerBridge` has no signal parameter at all
- `session.abort(): Promise<void>` exists on `AgentSession` and is the correct interrupt lever
- The `SerializedReviewerLock.runExclusive()` is a chain-promise mutex with no built-in abort-while-waiting API
- `handleReviewerInvocationFailureLocked` increments `consecutiveInvocationFailureCount` — must NOT be called on
  user-initiated abort (would eventually trigger a hard session reset)
- Existing fake session in tests already has `abort: vi.fn()` but the mock `prompt` is not yet interruptible

**Signal placement constraint:**
The abort listener must be registered *inside* the `runExclusive` callback (after acquiring the lock), not before.
Registering it outside could call `session.abort()` while a different concurrent invocation holds the lock.

## Development Approach

- Testing approach: **Regular** (test after implementation)
- Single task (logic change + tests are one coherent unit)
- All tests must pass before marking done

## Testing Strategy

New test cases in `specs/unit/reviewer-bridge-tool.spec.ts`:

- Signal already aborted before `executeReviewerBridge` is called → immediate abort, no failure recorded
- Signal fires during `session.prompt()` → `session.abort()` called, error propagates, no failure recorded
- Signal fires during `session.prompt()` → listener cleaned up after prompt resolves/rejects
- Normal (no signal / signal never aborts) → behaviour unchanged, no regression

The fake session needs an `abort` method that rejects the pending `prompt` promise to enable async interrupt testing.

## External Review Strategy

- Reviewer check after the task is complete (before marking done)

## Implementation Approach

- Main agent, single task

## Progress Tracking

- Mark completed items with `[x]` immediately
- Add newly discovered tasks with ➕
- Add blockers with ⚠️

## What Goes Where

- **Implementation Steps** — all in-repo work with checkboxes below
- **Post-Completion** — manual smoke test (no automation path for real ESC-ESC)

## Implementation Steps

### Task 1: Thread signal and suppress abort-as-failure

**Files:**
- Modify: `src/reviewer/reviewer-bridge-tool.ts`
- Modify: `specs/unit/reviewer-bridge-tool.spec.ts`

#### Production changes (`reviewer-bridge-tool.ts`)

- [ ] Add `signal?: AbortSignal` as the last parameter of `executeReviewerBridge`
- [ ] Inside `state.lock.runExclusive`, after `ensureReviewerSessionLocked` resolves, register an abort listener:
  ```ts
  const onAbort = () => { void session.abort(); };
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
  }
  ```
- [ ] Wrap the `session.prompt(prompt)` call in a try/finally that always calls
  `signal?.removeEventListener("abort", onAbort)` (covers both success and error paths)
- [ ] In the catch block, skip `handleReviewerInvocationFailureLocked` when the parent signal is already
  aborted (`if (signal?.aborted) { throw error; }`); only record failure for genuine errors
- [ ] Change `execute(_toolCallId, params, _signal, onUpdate, ctx)` to accept `signal` (remove underscore prefix)
  and pass it as the last argument to `executeReviewerBridge`

#### Test changes (`reviewer-bridge-tool.spec.ts`)

- [ ] Enhance `createFakeReviewerSession` (or add a new helper) so it supports an interruptible `prompt`:
  the mock holds the in-flight promise and `session.abort()` rejects it with an `AbortError`
- [ ] Test: signal already aborted on entry → `session.abort()` called, error propagates,
  `handleReviewerInvocationFailureLocked` is NOT called (i.e. `state.usage.invocationFailureCount === 0`)
- [ ] Test: signal fires mid-prompt → `session.abort()` called, error propagates, no failure recorded
- [ ] Test: signal fires mid-prompt → abort listener is removed after the call settles (no listener leak)
- [ ] Test: no signal provided → behaviour identical to current (no regression)
- [ ] Test: signal provided but never aborted → success path unchanged, no failure recorded

- [ ] Run `pnpm test` — all tests green
- [ ] Run `pnpm typecheck` — no type errors

### Task 2: Verify acceptance criteria

- [ ] Confirm `executeReviewerBridge` signature has `signal?: AbortSignal`
- [ ] Confirm `execute` no longer uses `_signal` (underscore removed)
- [ ] Confirm catch block guards `handleReviewerInvocationFailureLocked` with `signal?.aborted`
- [ ] Confirm abort listener is always cleaned up (finally block present)
- [ ] Run `pnpm validate` (runs both test and typecheck): `pnpm validate`
- [ ] No new `any` casts or `@ts-ignore` introduced

### Task 3: [Final] Housekeeping

- [ ] Update `docs/architecture.md` or `docs/runtime-behavior.md` if they describe the interrupt model
- [ ] Move this plan to `docs/plans/completed/`

## Technical Details

**Why inside the lock?**
`state.session` is set by `ensureReviewerSessionLocked` while the lock is held. Accessing it from outside the
lock (e.g., in a listener registered before `runExclusive`) would race against another invocation that might
replace `state.session`. Registering the listener inside the lock guarantees we target the session that *this*
invocation is running against.

**What error does `session.abort()` produce?**
Unknown from types alone — assumed to be some error (possibly `AbortError`). The guard `signal?.aborted` is used
rather than inspecting the error shape, which is robust regardless of what `AgentSession.abort()` throws.

**Lock wait + abort (acknowledged gap):**
If signal fires while queued behind another invocation in `SerializedReviewerLock`, the wait cannot be
short-circuited — we'd need to extend the lock API. This is out of scope: in practice the reviewer is called
sequentially by the main agent, and the worst case is a delayed ESC response, not a hang.

**Session health after abort:**
`session.abort()` is a supported lifecycle call. After abort, `state.session` is kept; the next invocation will
reuse it via `ensureReviewerSessionLocked`. No hard reset triggered.

## Post-Completion

- Manual smoke test: trigger a reviewer call, press ESC-ESC mid-flight, verify the tool result appears quickly
  with an error/cancelled state and the next reviewer call works normally
