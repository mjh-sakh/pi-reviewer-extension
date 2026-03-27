import type { AgentSession } from "@mariozechner/pi-coding-agent";

import {
  REVIEWER_STATIC_COMPACTION_INSTRUCTIONS,
  decideReviewerPostInvocationFailureAction,
  decideReviewerPostInvocationSuccessAction,
  type ReviewerLifecycleDecision,
} from "./lifecycle-policy.ts";
import { resetReviewerSessionStateLocked, type ReviewerSessionState } from "./session-state.ts";

type ReviewerMaintenanceSession = Pick<AgentSession, "dispose"> & {
  getContextUsage?: AgentSession["getContextUsage"];
  compact?: AgentSession["compact"];
};

export interface ReviewerMaintenanceResult extends ReviewerLifecycleDecision {
  fallbackFrom?: "compact";
}

function now() {
  return new Date().toISOString();
}

async function hardResetReviewerSessionLocked(state: ReviewerSessionState, reason: string) {
  await resetReviewerSessionStateLocked(state, {
    clearOwner: false,
    health: "idle",
    reason,
  });
}

export function recordReviewerInvocationSuccess(state: ReviewerSessionState) {
  state.health = "ready";
  state.lastError = undefined;
  state.usage.consecutiveInvocationFailureCount = 0;
}

export function recordReviewerInvocationFailure(state: ReviewerSessionState, error: unknown) {
  state.lastError = error;
  state.usage.invocationFailureCount += 1;
  state.usage.consecutiveInvocationFailureCount += 1;
  state.usage.lastInvocationFailedAt = now();
}

export function isReviewerSessionCompactionViable(session: ReviewerMaintenanceSession) {
  return typeof session.getContextUsage === "function" && typeof session.compact === "function";
}

export async function runReviewerMaintenanceLocked(
  state: ReviewerSessionState,
  session: ReviewerMaintenanceSession,
): Promise<ReviewerMaintenanceResult> {
  const contextUsage = typeof session.getContextUsage === "function" ? session.getContextUsage() : undefined;
  const action = decideReviewerPostInvocationSuccessAction({
    contextUsage,
    compactionViable: isReviewerSessionCompactionViable(session),
  });

  if (action.type === "none") {
    return action;
  }

  if (action.type === "hard_reset") {
    await hardResetReviewerSessionLocked(state, action.reason);
    return action;
  }

  try {
    await session.compact?.(REVIEWER_STATIC_COMPACTION_INSTRUCTIONS);
    state.usage.compactionCount += 1;
    state.usage.lastCompactedAt = now();
    return action;
  } catch (_error) {
    await hardResetReviewerSessionLocked(state, "compaction_failed");
    return {
      type: "hard_reset",
      reason: action.reason,
      contextUsageRatio: action.contextUsageRatio,
      fallbackFrom: "compact",
    };
  }
}

export async function handleReviewerInvocationFailureLocked(
  state: ReviewerSessionState,
  error: unknown,
): Promise<ReviewerMaintenanceResult> {
  recordReviewerInvocationFailure(state, error);

  const action = decideReviewerPostInvocationFailureAction(state.usage.consecutiveInvocationFailureCount);
  if (action.type === "hard_reset") {
    await hardResetReviewerSessionLocked(state, action.reason);
  }

  return action;
}
