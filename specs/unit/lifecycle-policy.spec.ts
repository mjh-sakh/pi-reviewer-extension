import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  COMPACTION_CONTEXT_PERCENT_THRESHOLD,
  MAX_CONSECUTIVE_INVOCATION_FAILURES,
  REVIEWER_STATIC_COMPACTION_INSTRUCTIONS,
  decideReviewerPostInvocationFailureAction,
  decideReviewerPostInvocationSuccessAction,
  getReviewerContextUsageRatio,
} from "../../src/reviewer/lifecycle-policy.ts";
import {
  handleReviewerInvocationFailureLocked,
  isReviewerSessionCompactionViable,
  recordReviewerInvocationSuccess,
  runReviewerMaintenanceLocked,
} from "../../src/reviewer/reviewer-maintenance.ts";
import { createReviewerSessionState } from "../../src/reviewer/session-state.ts";

function createMaintenanceSession(options?: {
  percent?: number | null;
  compactImpl?: (instructions: string) => Promise<void> | void;
  includeCompact?: boolean;
}) {
  const dispose = vi.fn();
  const getContextUsage = vi.fn(() =>
    options?.percent === undefined
      ? undefined
      : {
          tokens: 100,
          contextWindow: 1000,
          percent: options.percent,
        },
  );
  const compact = vi.fn(async (instructions: string) => {
    await options?.compactImpl?.(instructions);
  });

  const session = {
    sessionId: "reviewer-1",
    dispose,
    getContextUsage,
    ...(options?.includeCompact === false ? {} : { compact }),
  } as unknown as AgentSession;

  return {
    session,
    dispose,
    getContextUsage,
    compact,
  };
}

describe("reviewer lifecycle policy", () => {
  it("treats missing or unknown context usage as no action", () => {
    expect(getReviewerContextUsageRatio(undefined)).toBeUndefined();
    expect(getReviewerContextUsageRatio({ percent: null })).toBeUndefined();

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: undefined,
        compactionViable: true,
      }),
    ).toEqual({ type: "none", reason: "context_usage_unavailable" });

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: { percent: null },
        compactionViable: true,
      }),
    ).toEqual({ type: "none", reason: "context_usage_unavailable" });
  });

  it("uses an explicit >= 80% threshold and resets when compaction is not viable", () => {
    expect(COMPACTION_CONTEXT_PERCENT_THRESHOLD).toBe(0.8);
    expect(getReviewerContextUsageRatio({ percent: 80 })).toBe(0.8);
    expect(getReviewerContextUsageRatio({ percent: 1 })).toBe(0.01);
    expect(getReviewerContextUsageRatio({ percent: 0.8 })).toBe(0.8);

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: { percent: 1 },
        compactionViable: true,
      }),
    ).toEqual({
      type: "none",
      reason: "context_usage_below_threshold",
      contextUsageRatio: 0.01,
    });

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: { percent: 79 },
        compactionViable: true,
      }),
    ).toEqual({
      type: "none",
      reason: "context_usage_below_threshold",
      contextUsageRatio: 0.79,
    });

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: { percent: 80 },
        compactionViable: true,
      }),
    ).toEqual({
      type: "compact",
      reason: "context_threshold_reached",
      contextUsageRatio: 0.8,
    });

    expect(
      decideReviewerPostInvocationSuccessAction({
        contextUsage: { percent: 80 },
        compactionViable: false,
      }),
    ).toEqual({
      type: "hard_reset",
      reason: "context_threshold_without_compaction",
      contextUsageRatio: 0.8,
    });
  });

  it("hard-resets after 3 consecutive invocation failures", () => {
    expect(MAX_CONSECUTIVE_INVOCATION_FAILURES).toBe(3);
    expect(decideReviewerPostInvocationFailureAction(2)).toEqual({
      type: "none",
      reason: "invocation_failure_recorded",
    });
    expect(decideReviewerPostInvocationFailureAction(3)).toEqual({
      type: "hard_reset",
      reason: "consecutive_invocation_failures",
    });
  });
});

describe("reviewer maintenance", () => {
  it("compacts with extension-owned static instructions when threshold is reached", async () => {
    const state = createReviewerSessionState();
    const reviewer = createMaintenanceSession({ percent: 80 });
    state.session = reviewer.session;
    state.health = "ready";

    const result = await runReviewerMaintenanceLocked(state, reviewer.session);

    expect(isReviewerSessionCompactionViable(reviewer.session)).toBe(true);
    expect(result.type).toBe("compact");
    expect(reviewer.compact).toHaveBeenCalledWith(REVIEWER_STATIC_COMPACTION_INSTRUCTIONS);
    expect(state.usage.compactionCount).toBe(1);
    expect(state.usage.lastCompactedAt).toBeDefined();
    expect(state.session).toBe(reviewer.session);
  });

  it("does nothing when context usage is unavailable", async () => {
    const state = createReviewerSessionState();
    const reviewer = createMaintenanceSession({ includeCompact: false });
    state.session = reviewer.session;
    state.health = "ready";

    const result = await runReviewerMaintenanceLocked(state, reviewer.session);

    expect(result).toEqual({ type: "none", reason: "context_usage_unavailable" });
    expect(state.usage.resetCount).toBe(0);
    expect(reviewer.dispose).not.toHaveBeenCalled();
  });

  it("hard-resets instead of depending on compaction when viability is missing", async () => {
    const state = createReviewerSessionState();
    const reviewer = createMaintenanceSession({ percent: 80, includeCompact: false });
    state.session = reviewer.session;
    state.health = "ready";

    const result = await runReviewerMaintenanceLocked(state, reviewer.session);

    expect(isReviewerSessionCompactionViable(reviewer.session)).toBe(false);
    expect(result).toEqual({
      type: "hard_reset",
      reason: "context_threshold_without_compaction",
      contextUsageRatio: 0.8,
    });
    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(state.session).toBeUndefined();
    expect(state.usage.resetCount).toBe(1);
  });

  it("falls back to a hard reset when compaction fails", async () => {
    const state = createReviewerSessionState();
    const reviewer = createMaintenanceSession({
      percent: 80,
      compactImpl: async () => {
        throw new Error("compact boom");
      },
    });
    state.session = reviewer.session;
    state.health = "ready";

    const result = await runReviewerMaintenanceLocked(state, reviewer.session);

    expect(result).toEqual({
      type: "hard_reset",
      reason: "context_threshold_reached",
      contextUsageRatio: 0.8,
      fallbackFrom: "compact",
    });
    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(state.session).toBeUndefined();
    expect(state.usage.compactionCount).toBe(0);
    expect(state.usage.resetCount).toBe(1);
  });

  it("tracks invocation failures separately and resets after the threshold", async () => {
    const state = createReviewerSessionState();
    const reviewer = createMaintenanceSession({ percent: 10 });
    state.session = reviewer.session;
    state.health = "ready";

    await expect(handleReviewerInvocationFailureLocked(state, new Error("boom-1"))).resolves.toEqual({
      type: "none",
      reason: "invocation_failure_recorded",
    });
    await expect(handleReviewerInvocationFailureLocked(state, new Error("boom-2"))).resolves.toEqual({
      type: "none",
      reason: "invocation_failure_recorded",
    });

    expect(state.usage.initializationFailureCount).toBe(0);
    expect(state.usage.invocationFailureCount).toBe(2);
    expect(state.usage.consecutiveInvocationFailureCount).toBe(2);
    expect(state.session).toBe(reviewer.session);

    await expect(handleReviewerInvocationFailureLocked(state, new Error("boom-3"))).resolves.toEqual({
      type: "hard_reset",
      reason: "consecutive_invocation_failures",
    });

    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(state.session).toBeUndefined();
    expect(state.usage.invocationFailureCount).toBe(MAX_CONSECUTIVE_INVOCATION_FAILURES);
    expect(state.usage.consecutiveInvocationFailureCount).toBe(0);
    expect(state.usage.resetCount).toBe(1);
    expect(state.usage.lastInvocationFailedAt).toBeDefined();
  });

  it("clears consecutive invocation failures after a successful reviewer call", () => {
    const state = createReviewerSessionState();
    state.health = "ready";
    state.lastError = new Error("old");
    state.usage.consecutiveInvocationFailureCount = 2;

    recordReviewerInvocationSuccess(state);

    expect(state.lastError).toBeUndefined();
    expect(state.health).toBe("ready");
    expect(state.usage.consecutiveInvocationFailureCount).toBe(0);
  });
});
