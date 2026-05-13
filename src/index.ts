import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createReviewerBridgeTool } from "./reviewer/reviewer-bridge-tool.ts";
import {
  claimReviewerSessionOwner,
  createReviewerSessionState,
  disposeReviewerSessionState,
  type ReviewerSessionState,
} from "./reviewer/session-state.ts";

export const REVIEWER_EXTENSION_ID = "pi-reviewer-extension";

export interface ReviewerExtensionRuntime {
  state: ReviewerSessionState;
}

export function registerReviewerExtension(
  pi: ExtensionAPI,
  reviewerState: ReviewerSessionState = createReviewerSessionState(),
): ReviewerExtensionRuntime {
  pi.registerTool(createReviewerBridgeTool(reviewerState));

  pi.on("session_start", async (_event, ctx) => {
    await claimReviewerSessionOwner(reviewerState, ctx, "session_start");
  });

  pi.on("session_shutdown", async () => {
    await disposeReviewerSessionState(reviewerState, {
      clearOwner: true,
      health: "disposed",
      reason: "session_shutdown",
    });
  });

  return { state: reviewerState };
}

export default function reviewerExtension(pi: ExtensionAPI) {
  registerReviewerExtension(pi);
}
