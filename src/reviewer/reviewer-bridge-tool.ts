import type { AgentSessionEvent, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";

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

export interface ReviewerBridgeUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface ReviewerBridgeToolDetails {
  response?: string;
  turns?: number;
  usage?: ReviewerBridgeUsage;
  model?: string;
}

// ---------------------------------------------------------------------------
// Formatting helpers (style mirrors pi-subagents/formatters.ts)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) {
    const k = n / 1000;
    return k === Math.floor(k) ? `${Math.floor(k)}k` : `${k.toFixed(1)}k`;
  }
  return `${Math.round(n / 1000)}k`;
}

export function formatReviewerUsage(turns: number, usage: ReviewerBridgeUsage, model?: string): string {
  const parts: string[] = [];
  if (turns) parts.push(`${turns} turn${turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`in:${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`out:${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------

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
  onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: ReviewerBridgeToolDetails }) => void,
  signal?: AbortSignal,
) {
  const { resetSession, ...promptInput } = params;
  const prompt = buildReviewerBridgePrompt(promptInput);

  try {
    return await state.lock.runExclusive(async () => {
      // Early abort check: before any side effects (session reset or creation)
      if (signal?.aborted) {
        throw new Error("Reviewer bridge aborted before session setup");
      }

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

      // Second abort check: after session setup, before subscribe/prompt
      if (signal?.aborted) {
        throw new Error("Reviewer bridge aborted after session setup");
      }

      // Set up abort forwarding: when signal fires, abort the reviewer session.
      // Registered inside the lock so it always targets the session this invocation holds.
      let abortRequested = false;
      const onAbort = () => {
        abortRequested = true;
        void session.abort().catch(() => {});
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const modelLabel = session.model
          ? `${session.model.id}:${session.thinkingLevel}`
          : undefined;

        let turns = 0;
        const accumulated: ReviewerBridgeUsage = { input: 0, output: 0, cacheRead: 0 };

        let unsubscribeCalled = false;
        let rawUnsubscribe: (() => void) | undefined;
        let trackingActive = true;
        const safeUnsubscribe = () => {
          if (unsubscribeCalled) return;
          unsubscribeCalled = true;
          trackingActive = false;
          try { rawUnsubscribe?.(); } catch { /* ignore unsubscribe errors */ }
        };

        const publicUsage = () => ({
          input: accumulated.input,
          output: accumulated.output,
          cacheRead: accumulated.cacheRead,
        });

        try {
          rawUnsubscribe = session.subscribe((event: AgentSessionEvent) => {
            if (!trackingActive) return;
            if (event.type !== "turn_end") return;
            // Assumes: (1) subscribe delivers future events only (no replay), and
            // (2) all turn_end events for this prompt arrive before session.prompt() resolves.
            const msg = event.message;
            if (!msg || typeof msg !== "object" || !("role" in msg) || !("usage" in msg)) return;
            const { role, usage } = msg as { role: unknown; usage: unknown };
            if (role !== "assistant" || !usage || typeof usage !== "object") return;
            const u = usage as Record<string, unknown>;
            const safeNum = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
            accumulated.input += safeNum(u.input);
            accumulated.output += safeNum(u.output);
            accumulated.cacheRead += safeNum(u.cacheRead);
            turns++;
            try {
              onUpdate?.({
                content: [{ type: "text", text: formatReviewerUsage(turns, accumulated, modelLabel) }],
                details: { turns, usage: publicUsage(), model: modelLabel },
              });
            } catch {
              // onUpdate errors must not interrupt reviewer execution
            }
          });

          const messageBoundary = session.messages.length;
          await session.prompt(prompt);

          // Post-prompt abort guard: session.abort() may cause prompt() to resolve rather than reject.
          // Do not record success or extract a potentially partial response.
          if (abortRequested) {
            throw new Error("Reviewer bridge aborted during prompt");
          }

          const response = extractCurrentReviewerResponseText(session.messages, messageBoundary);
          safeUnsubscribe(); // stop before maintenance so compaction turns are not counted

          // Remove listener before maintenance: a late abort must not call session.abort()
          // during compaction. The outer finally is a no-op after this.
          signal?.removeEventListener("abort", onAbort);

          recordReviewerInvocationSuccess(state);
          await runReviewerMaintenanceLocked(state, session);

          return {
            content: [{ type: "text" as const, text: response }],
            details: {
              response,
              turns,
              usage: publicUsage(),
              model: modelLabel,
            } satisfies ReviewerBridgeToolDetails,
          };
        } catch (error) {
          safeUnsubscribe(); // stop tracking before failure handling, which may reset/dispose session
          if (!abortRequested) {
            // Only record genuine failures — user-initiated aborts must not degrade session health.
            await handleReviewerInvocationFailureLocked(state, error);
          }
          throw error;
        } finally {
          safeUnsubscribe(); // no-op if catch already ran; guards the success early-return path too
        }
      } finally {
        signal?.removeEventListener("abort", onAbort); // always remove listener regardless of outcome
      }
    });
  } catch (error) {
    throw new Error(`Reviewer bridge failed: ${toErrorMessage(error)}`, { cause: error });
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

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        onUpdate?.({
          content: [{ type: "text", text: "Consulting reviewer..." }],
          details: {},
        });
      } catch {
        // best-effort initial notification
      }

      return executeReviewerBridge(state, params, ctx, dependencies, onUpdate, signal);
    },

    renderCall(args, theme) {
      const question = args.question ?? "";
      const preview = question.length > 60 ? `${question.slice(0, 60)}…` : question;
      return new Text(
        `${theme.fg("toolTitle", theme.bold("reviewer "))}${theme.fg("muted", preview)}`,
        0, 0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      const d = result.details;
      const emptyUsage: ReviewerBridgeUsage = { input: 0, output: 0, cacheRead: 0 };
      if (isPartial) {
        const statsText = d?.turns
          ? formatReviewerUsage(d.turns, d.usage ?? emptyUsage, d.model)
          : "thinking…";
        return new Text(theme.fg("warning", `... ${statsText}`), 0, 0);
      }

      const statsLine = d?.turns
        ? formatReviewerUsage(d.turns, d.usage ?? emptyUsage, d.model)
        : "";

      const response = d?.response ?? (result.content[0] as { text?: string })?.text ?? "";
      const lines = [response, ...(statsLine ? [theme.fg("dim", statsLine)] : [])].join("\n");
      return new Text(lines, 0, 0);
    },
  };
}
