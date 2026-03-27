import type { ContextUsage } from "@mariozechner/pi-coding-agent";

export const COMPACTION_CONTEXT_PERCENT_THRESHOLD = 0.8;
export const MAX_CONSECUTIVE_INVOCATION_FAILURES = 3;

export const REVIEWER_STATIC_COMPACTION_INSTRUCTIONS = `You are compacting an internal reviewer session owned by this extension.
Create a concise continuation summary for future reviewer turns.
Preserve only durable review context: active artifact names, open risks, important constraints, decisions already made, and unresolved questions.
Do not add new work, do not ask the user for anything, and do not include transient chit-chat.`;

export interface ReviewerLifecycleDecision {
  type: "none" | "compact" | "hard_reset";
  reason:
    | "context_usage_unavailable"
    | "context_usage_below_threshold"
    | "context_threshold_reached"
    | "context_threshold_without_compaction"
    | "invocation_failure_recorded"
    | "consecutive_invocation_failures";
  contextUsageRatio?: number;
}

export interface ReviewerPostInvocationSuccessPolicyInput {
  contextUsage: Pick<ContextUsage, "percent"> | undefined;
  compactionViable: boolean;
  compactionContextPercentThreshold?: number;
}

function normalizeContextUsagePercent(percent: number) {
  return percent >= 1 ? percent / 100 : percent;
}

export function getReviewerContextUsageRatio(contextUsage: Pick<ContextUsage, "percent"> | undefined) {
  if (!contextUsage || contextUsage.percent === null || contextUsage.percent === undefined) {
    return undefined;
  }

  return normalizeContextUsagePercent(contextUsage.percent);
}

export function decideReviewerPostInvocationSuccessAction(
  input: ReviewerPostInvocationSuccessPolicyInput,
): ReviewerLifecycleDecision {
  const threshold = input.compactionContextPercentThreshold ?? COMPACTION_CONTEXT_PERCENT_THRESHOLD;
  const contextUsageRatio = getReviewerContextUsageRatio(input.contextUsage);

  if (contextUsageRatio === undefined) {
    return {
      type: "none",
      reason: "context_usage_unavailable",
    };
  }

  if (contextUsageRatio < threshold) {
    return {
      type: "none",
      reason: "context_usage_below_threshold",
      contextUsageRatio,
    };
  }

  if (!input.compactionViable) {
    return {
      type: "hard_reset",
      reason: "context_threshold_without_compaction",
      contextUsageRatio,
    };
  }

  return {
    type: "compact",
    reason: "context_threshold_reached",
    contextUsageRatio,
  };
}

export function decideReviewerPostInvocationFailureAction(
  consecutiveInvocationFailureCount: number,
  maxConsecutiveInvocationFailures = MAX_CONSECUTIVE_INVOCATION_FAILURES,
): ReviewerLifecycleDecision {
  if (consecutiveInvocationFailureCount >= maxConsecutiveInvocationFailures) {
    return {
      type: "hard_reset",
      reason: "consecutive_invocation_failures",
    };
  }

  return {
    type: "none",
    reason: "invocation_failure_recorded",
  };
}
