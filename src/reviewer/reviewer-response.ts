import type { AgentSession } from "@mariozechner/pi-coding-agent";

export interface ReviewerBridgePromptInput {
  question: string;
  context?: string;
  focus?: string;
}

type ReviewerSessionMessage = AgentSession["messages"][number];

type ReviewerAssistantMessage = Extract<ReviewerSessionMessage, { role: "assistant" }>;

interface ReviewerTextContent {
  type: "text";
  text: string;
}

function normalizeOptionalField(value: string | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function compactReviewerText(text: string) {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

export function buildReviewerBridgePrompt(input: ReviewerBridgePromptInput) {
  const question = normalizeOptionalField(input.question);
  if (!question) {
    throw new Error("Reviewer bridge requires a non-empty question.");
  }

  const context = normalizeOptionalField(input.context);
  const focus = normalizeOptionalField(input.focus);

  const sections = [
    "You are being consulted as an internal reviewer for the current task.",
    "Respond with concise, decision-useful feedback for the calling agent.",
    "Prefer concrete risks, missing constraints, and a recommended next step.",
    "",
    `Question:\n${question}`,
  ];

  if (context) {
    sections.push("", `Context:\n${context}`);
  }

  if (focus) {
    sections.push("", `Focus:\n${focus}`);
  }

  return sections.join("\n");
}

function isAssistantMessage(message: ReviewerSessionMessage): message is ReviewerAssistantMessage {
  return message?.role === "assistant";
}

function isTextContent(content: unknown): content is ReviewerTextContent {
  return Boolean(
    content &&
      typeof content === "object" &&
      "type" in content &&
      (content as { type?: unknown }).type === "text" &&
      "text" in content &&
      typeof (content as { text?: unknown }).text === "string",
  );
}

export function extractReviewerTextFromAssistantMessage(message: ReviewerSessionMessage) {
  if (!isAssistantMessage(message)) {
    throw new Error("Reviewer response extraction requires an assistant message.");
  }

  if (!Array.isArray(message.content)) {
    throw new Error("Reviewer assistant message content was malformed.");
  }

  const malformedContent = message.content.some((part) => {
    if (!part || typeof part !== "object") {
      return true;
    }

    if (!("type" in part) || typeof part.type !== "string") {
      return true;
    }

    if (part.type === "text") {
      return typeof (part as { text?: unknown }).text !== "string";
    }

    return false;
  });

  if (malformedContent) {
    throw new Error("Reviewer assistant message content was malformed.");
  }

  const text = message.content.filter(isTextContent).map((part) => part.text.trim()).filter(Boolean).join("\n\n");
  if (!text) {
    throw new Error("Reviewer invocation produced an empty assistant response.");
  }

  return compactReviewerText(text);
}

export function extractCurrentReviewerResponseText(messages: AgentSession["messages"], messageBoundary: number) {
  const currentInvocationMessages = messages.slice(messageBoundary);
  const assistantMessages = currentInvocationMessages.filter(isAssistantMessage);
  const finalAssistantMessage = assistantMessages.at(-1);

  if (!finalAssistantMessage) {
    throw new Error("Reviewer invocation produced no new assistant output.");
  }

  return extractReviewerTextFromAssistantMessage(finalAssistantMessage);
}
