import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";

import {
  ensureReviewerSessionLocked,
  type ReviewerMainModel,
  type ReviewerSessionFactoryDependencies,
} from "./session-factory.ts";
import { buildReviewerBridgePrompt, extractCurrentReviewerResponseText } from "./reviewer-response.ts";
import {
  handleReviewerInvocationFailureLocked,
  recordReviewerInvocationSuccess,
  runReviewerMaintenanceLocked,
} from "./reviewer-maintenance.ts";
import { resetReviewerSessionStateLocked, type ReviewerSessionState } from "./session-state.ts";

export const REVIEWER_BRIDGE_TOOL_NAME = "reviewer_bridge";

export const REVIEWER_BRIDGE_TOOL_PARAMETERS = Type.Object(
  {
    question: Type.String({ description: "The concrete review question for the reviewer." }),
    context: Type.Optional(Type.String({ description: "Optional task context the reviewer should consider." })),
    focus: Type.Optional(Type.String({ description: "Optional review lens or constraint to prioritize." })),
    resetSession: Type.Optional(
      Type.Boolean({
        description:
          "Start a fresh reviewer session for this same call before handling the question. Use it when switching to an unrelated review topic or when prior reviewer memory would mislead the answer.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type ReviewerBridgeToolParams = Static<typeof REVIEWER_BRIDGE_TOOL_PARAMETERS>;

export interface ReviewerBridgeToolDetails {
  response: string;
}

function getReviewerMainModel(ctx: ExtensionContext): ReviewerMainModel | undefined {
  if (!ctx.model) {
    return undefined;
  }

  return {
    provider: ctx.model.provider,
    id: ctx.model.id,
  };
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function executeReviewerBridge(
  state: ReviewerSessionState,
  params: ReviewerBridgeToolParams,
  ctx: ExtensionContext,
  dependencies?: ReviewerSessionFactoryDependencies,
) {
  const { resetSession, ...promptInput } = params;
  const prompt = buildReviewerBridgePrompt(promptInput);

  try {
    return await state.lock.runExclusive(async () => {
      if (resetSession) {
        await resetReviewerSessionStateLocked(state, {
          clearOwner: false,
          health: "idle",
          reason: "tool_requested_session_reset",
        });
      }

      const session = await ensureReviewerSessionLocked(
        state,
        {
          cwd: ctx.cwd,
          sessionManager: ctx.sessionManager,
          model: getReviewerMainModel(ctx),
        },
        dependencies,
      );

      try {
        const messageBoundary = session.messages.length;
        await session.prompt(prompt);
        const response = extractCurrentReviewerResponseText(session.messages, messageBoundary);

        recordReviewerInvocationSuccess(state);
        await runReviewerMaintenanceLocked(state, session);

        return {
          content: [{ type: "text" as const, text: response }],
          details: { response } satisfies ReviewerBridgeToolDetails,
        };
      } catch (error) {
        await handleReviewerInvocationFailureLocked(state, error);
        throw error;
      }
    });
  } catch (error) {
    throw new Error(`Reviewer bridge failed: ${toErrorMessage(error)}`);
  }
}

export function createReviewerBridgeTool(
  state: ReviewerSessionState,
  dependencies?: ReviewerSessionFactoryDependencies,
): ToolDefinition<typeof REVIEWER_BRIDGE_TOOL_PARAMETERS, ReviewerBridgeToolDetails> {
  return {
    name: REVIEWER_BRIDGE_TOOL_NAME,
    label: "Reviewer Bridge",
    description:
      "Consult an isolated internal reviewer for a concise critique, risk check, or second opinion during the current task.",
    promptSnippet: "Consult an isolated internal reviewer for concise critique or decision support.",
    promptGuidelines: [
      "Use this tool when you want an independent review of a plan, implementation choice, or risk-heavy change.",
      "Ask one concrete question and add only the minimal context or focus needed for a useful answer.",
      "Set resetSession: true when switching to an unrelated review topic or when prior reviewer memory would likely mislead the answer.",
      "resetSession starts a fresh reviewer session and asks the new question in the same call; it is not a reset-only mode.",
      "Treat the reviewer reply as advisory input and synthesize it into your own final judgment.",
    ],
    parameters: REVIEWER_BRIDGE_TOOL_PARAMETERS,
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: "Consulting reviewer..." }],
        details: { response: "Consulting reviewer..." },
      });

      return executeReviewerBridge(state, params, ctx, dependencies);
    },
  };
}
