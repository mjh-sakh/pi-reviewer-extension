import type { AgentSession } from "@mariozechner/pi-coding-agent";

import { SerializedReviewerLock, type ReviewerLock } from "./reviewer-lock.ts";

export interface ReviewerSessionOwnerContext {
  cwd: string;
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
}

export interface ReviewerSessionOwner {
  cwd: string;
  sessionFile?: string;
  sessionId: string;
  stableIdentity: string;
}

export type ReviewerHealth = "idle" | "initializing" | "ready" | "failed" | "disposed";

export interface ReviewerSessionModelTarget {
  provider: string;
  id: string;
}

export interface ReviewerUsageMetadata {
  createdCount: number;
  resetCount: number;
  disposeCount: number;
  initializationFailureCount: number;
  invocationFailureCount: number;
  consecutiveInvocationFailureCount: number;
  compactionCount: number;
  lastCreatedAt?: string;
  lastResetAt?: string;
  lastDisposedAt?: string;
  lastInvocationFailedAt?: string;
  lastCompactedAt?: string;
}

export interface ReviewerSessionState {
  lock: ReviewerLock;
  owner?: ReviewerSessionOwner;
  session?: AgentSession;
  modelTarget?: ReviewerSessionModelTarget;
  health: ReviewerHealth;
  lastError?: unknown;
  usage: ReviewerUsageMetadata;
}

export interface ReviewerStateResetOptions {
  clearOwner?: boolean;
  health?: ReviewerHealth;
  reason?: string;
  recordWhenIdle?: boolean;
}

export interface ReviewerOwnerClaimResult {
  owner: ReviewerSessionOwner;
  previousOwner?: ReviewerSessionOwner;
  changed: boolean;
}

function now() {
  return new Date().toISOString();
}

export function createReviewerSessionState(lock: ReviewerLock = new SerializedReviewerLock()): ReviewerSessionState {
  return {
    lock,
    health: "idle",
    usage: {
      createdCount: 0,
      resetCount: 0,
      disposeCount: 0,
      initializationFailureCount: 0,
      invocationFailureCount: 0,
      consecutiveInvocationFailureCount: 0,
      compactionCount: 0,
    },
  };
}

export function getReviewerSessionOwner(ctx: ReviewerSessionOwnerContext): ReviewerSessionOwner {
  const sessionFile = ctx.sessionManager.getSessionFile();
  const sessionId = ctx.sessionManager.getSessionId();
  const stableIdentity = sessionFile ? `file:${sessionFile}` : `id:${sessionId}`;

  return {
    cwd: ctx.cwd,
    sessionFile,
    sessionId,
    stableIdentity,
  };
}

export function isSameReviewerSessionOwner(
  left: ReviewerSessionOwner | undefined,
  right: ReviewerSessionOwner | undefined,
) {
  return left?.stableIdentity === right?.stableIdentity && left?.cwd === right?.cwd;
}

export async function claimReviewerSessionOwner(
  state: ReviewerSessionState,
  ctx: ReviewerSessionOwnerContext,
  reason = "session-boundary",
): Promise<ReviewerOwnerClaimResult> {
  return state.lock.runExclusive(async () => {
    const nextOwner = getReviewerSessionOwner(ctx);
    const previousOwner = state.owner;
    const changed = !isSameReviewerSessionOwner(previousOwner, nextOwner);

    if (changed) {
      await resetReviewerSessionStateLocked(state, {
        clearOwner: false,
        health: "idle",
        reason,
      });
    }

    state.owner = nextOwner;
    if (state.health === "disposed") {
      state.health = "idle";
    }

    return {
      owner: nextOwner,
      previousOwner,
      changed,
    };
  });
}

export async function resetReviewerSessionState(state: ReviewerSessionState, options: ReviewerStateResetOptions = {}) {
  return state.lock.runExclusive(() => resetReviewerSessionStateLocked(state, options));
}

export async function disposeReviewerSessionState(state: ReviewerSessionState, options: ReviewerStateResetOptions = {}) {
  return state.lock.runExclusive(async () => {
    const hadOwner = state.owner !== undefined;
    const previousHealth = state.health;
    const didReset = await resetReviewerSessionStateLocked(state, {
      ...options,
      clearOwner: options.clearOwner ?? true,
      health: options.health ?? "disposed",
    });

    const shouldRecordDispose =
      didReset || options.recordWhenIdle || hadOwner || (previousHealth !== "idle" && previousHealth !== "disposed");
    if (shouldRecordDispose) {
      state.usage.disposeCount += 1;
      state.usage.lastDisposedAt = now();
    }

    state.health = options.health ?? "disposed";
    if (options.clearOwner ?? true) {
      state.owner = undefined;
    }
  });
}

export async function resetReviewerSessionStateLocked(
  state: ReviewerSessionState,
  options: ReviewerStateResetOptions = {},
) {
  const didReset = Boolean(state.session) || state.health === "failed";

  state.session?.dispose();
  state.session = undefined;
  state.modelTarget = undefined;
  state.lastError = undefined;
  state.usage.consecutiveInvocationFailureCount = 0;

  if (options.clearOwner) {
    state.owner = undefined;
  }

  state.health = options.health ?? "idle";

  if (didReset || options.recordWhenIdle) {
    state.usage.resetCount += 1;
    state.usage.lastResetAt = now();
  }

  return didReset;
}
