import type {
  AgentSession,
  AuthStorage,
  CreateAgentSessionOptions,
  ExtensionContext,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import {
  createReviewerBridgeTool,
  executeReviewerBridge,
  formatReviewerUsage,
  REVIEWER_BRIDGE_TOOL_NAME,
  REVIEWER_BRIDGE_TOOL_PARAMETERS,
  type ReviewerBridgeToolDetails,
  type ReviewerBridgeUsage,
} from "../../src/reviewer/reviewer-bridge-tool.ts";
import {
  buildReviewerBridgePrompt,
  extractCurrentReviewerResponseText,
  extractReviewerTextFromAssistantMessage,
} from "../../src/reviewer/reviewer-response.ts";
import {
  REVIEWER_GPT_MODEL_ID,
  REVIEWER_OPUS_MODEL_ID,
  REVIEWER_PROVIDER,
  type ReviewerSessionFactoryDependencies,
} from "../../src/reviewer/session-factory.ts";
import { createReviewerSessionState } from "../../src/reviewer/session-state.ts";

function createAssistantMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "responses",
    provider: REVIEWER_PROVIDER,
    model: REVIEWER_OPUS_MODEL_ID,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  } as const;
}

function createUserMessage(text: string) {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as const;
}

function createFakeReviewerSession(
  initialMessages: unknown[] = [],
  promptImpl?: (prompt: string, messages: unknown[]) => Promise<void> | void,
  sessionId = "reviewer-1",
) {
  const messages = [...initialMessages];
  const prompt = vi.fn(async (input: string) => {
    await promptImpl?.(input, messages);
  });

  return {
    session: {
      sessionId,
      messages,
      prompt,
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
    } as unknown as AgentSession,
    messages,
    prompt,
  };
}

type ReviewerResourceLoader = NonNullable<CreateAgentSessionOptions["resourceLoader"]>;
type ReviewerTools = NonNullable<CreateAgentSessionOptions["tools"]>;

function createDependencies(session: AgentSession): ReviewerSessionFactoryDependencies {
  return {
    createAuthStorage: () => ({}) as AuthStorage,
    createModelRegistry: () =>
      ({
        find: (provider: string, id: string) => ({ provider, id }),
      }) as unknown as ModelRegistry,
    createResourceLoader: () =>
      ({
        reload: async () => undefined,
      }) as ReviewerResourceLoader,
    createInMemorySessionManager: () => ({}) as SessionManager,
    createReadOnlyTools: () => [] as ReviewerTools,
    createAgentSession: vi.fn(async () => ({ session })),
  };
}

function createExtensionContext(modelId = "gpt-5.4") {
  return {
    ui: {
      notify: vi.fn(),
      confirm: vi.fn(),
      select: vi.fn(),
      custom: vi.fn(),
      input: vi.fn(),
      push: vi.fn(),
      pop: vi.fn(),
    },
    hasUI: false,
    cwd: "/repo",
    sessionManager: {
      getSessionFile: () => "/sessions/main-1.jsonl",
      getSessionId: () => "main-1",
    },
    modelRegistry: {} as ExtensionContext["modelRegistry"],
    model: { provider: REVIEWER_PROVIDER, id: modelId } as ExtensionContext["model"],
    isIdle: () => true,
    abort: vi.fn(),
    hasPendingMessages: () => false,
    shutdown: vi.fn(),
    getContextUsage: () => undefined,
    compact: vi.fn(),
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
}

describe("reviewer response helpers", () => {
  it("builds a focused reviewer prompt with optional context and focus", () => {
    expect(
      buildReviewerBridgePrompt({
        question: "  Is this migration plan missing anything?  ",
        context: "  We already updated backend types.  ",
        focus: "  Serialization and stale-output risks.  ",
      }),
    ).toContain("Question:\nIs this migration plan missing anything?");
    expect(
      buildReviewerBridgePrompt({
        question: "Is this migration plan missing anything?",
        context: "We already updated backend types.",
        focus: "Serialization and stale-output risks.",
      }),
    ).toContain("Context:\nWe already updated backend types.");
    expect(
      buildReviewerBridgePrompt({
        question: "Is this migration plan missing anything?",
        context: "We already updated backend types.",
        focus: "Serialization and stale-output risks.",
      }),
    ).toContain("Focus:\nSerialization and stale-output risks.");
    expect(() => buildReviewerBridgePrompt({ question: "   " })).toThrow(/non-empty question/i);
  });

  it("extracts only the final assistant text from the current invocation boundary", () => {
    const text = extractCurrentReviewerResponseText(
      [
        createAssistantMessage("stale output"),
        createUserMessage("new prompt"),
        createAssistantMessage("draft critique"),
        createAssistantMessage("final critique\n\nwith recommendation"),
      ] as AgentSession["messages"],
      1,
    );

    expect(text).toBe("final critique\n\nwith recommendation");
  });

  it("prevents stale-output leakage when no new assistant message was added", () => {
    expect(() =>
      extractCurrentReviewerResponseText(
        [createAssistantMessage("stale output"), createUserMessage("new prompt")] as AgentSession["messages"],
        1,
      ),
    ).toThrow(/no new assistant output/i);
  });

  it("throws explicit errors for malformed or empty assistant output", () => {
    expect(() =>
      extractReviewerTextFromAssistantMessage({
        ...createAssistantMessage("ignored"),
        content: [{ nope: true }],
      } as unknown as AgentSession["messages"][number]),
    ).toThrow(/malformed/i);

    expect(() =>
      extractReviewerTextFromAssistantMessage({
        ...createAssistantMessage("ignored"),
        content: [{ type: "text", text: "   " }],
      } as unknown as AgentSession["messages"][number]),
    ).toThrow(/empty assistant response/i);

    expect(() => extractCurrentReviewerResponseText([createUserMessage("new prompt")] as AgentSession["messages"], 0)).toThrow(
      /no new assistant output/i,
    );
  });
});

describe("reviewer bridge tool", () => {
  it("defines a small focused schema and prompt guidance", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);

    expect(tool.name).toBe(REVIEWER_BRIDGE_TOOL_NAME);
    expect(tool.promptSnippet).toMatch(/isolated internal reviewer/i);
    expect(tool.promptGuidelines).toHaveLength(5);
    expect(tool.promptGuidelines).toContain(
      "Set resetSession: true when switching to an unrelated review topic or when prior reviewer memory would likely mislead the answer.",
    );
    expect(tool.promptGuidelines).toContain(
      "resetSession starts a fresh reviewer session and asks the new question in the same call; it is not a reset-only mode.",
    );
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties).toHaveProperty("question");
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties).toHaveProperty("context");
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties).toHaveProperty("focus");
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties).toHaveProperty("resetSession");
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties.resetSession.type).toBe("boolean");
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties.resetSession.description).toMatch(/fresh reviewer session/i);
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties.resetSession.description).toMatch(/same call/i);
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.properties.resetSession.description).toMatch(/prior reviewer memory would mislead/i);
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.required).toEqual(["question"]);
    expect(REVIEWER_BRIDGE_TOOL_PARAMETERS.additionalProperties).toBe(false);
    expect(Value.Check(REVIEWER_BRIDGE_TOOL_PARAMETERS, { question: "Should pass", resetSession: true })).toBe(true);
    expect(Value.Check(REVIEWER_BRIDGE_TOOL_PARAMETERS, { resetSession: true })).toBe(false);
    expect(Value.Check(REVIEWER_BRIDGE_TOOL_PARAMETERS, { question: "No extras", extra: true })).toBe(false);
  });

  it("returns the current reviewer invocation output on the success path", async () => {
    const state = createReviewerSessionState();
    const reviewer = createFakeReviewerSession([createAssistantMessage("stale output")], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("concise reviewer answer"));
    });
    const ctx = createExtensionContext("claude-sonnet-4.6");

    const result = await executeReviewerBridge(state, { question: "What is the main risk?" }, ctx, createDependencies(reviewer.session));

    expect(reviewer.prompt).toHaveBeenCalledWith(expect.stringContaining("Question:\nWhat is the main risk?"));
    expect(result.content).toEqual([{ type: "text", text: "concise reviewer answer" }]);
    expect(result.details).toMatchObject({ response: "concise reviewer answer" });
    expect(state.modelTarget).toEqual({ provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID });
  });

  it("resets the reviewer session atomically before recreating and prompting when requested", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const sessionFile = ctx.sessionManager.getSessionFile();
    const preservedOwner = {
      cwd: ctx.cwd,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      stableIdentity: sessionFile ? `file:${sessionFile}` : `id:${ctx.sessionManager.getSessionId()}`,
    };
    const staleReviewer = createFakeReviewerSession([createAssistantMessage("stale output")]);
    const freshReviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("fresh reviewer answer"));
    });

    state.owner = preservedOwner;
    state.session = staleReviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    state.health = "ready";

    const prompt = buildReviewerBridgePrompt({
      question: "Should we reset first?",
      context: "Fresh topic.",
      focus: "Avoid stale memory.",
    });

    const result = await executeReviewerBridge(
      state,
      {
        question: "Should we reset first?",
        context: "Fresh topic.",
        focus: "Avoid stale memory.",
        resetSession: true,
      },
      ctx,
      createDependencies(freshReviewer.session),
    );

    expect(staleReviewer.session.dispose).toHaveBeenCalledTimes(1);
    expect(staleReviewer.prompt).not.toHaveBeenCalled();
    expect(freshReviewer.prompt).toHaveBeenCalledWith(prompt);
    expect(prompt).not.toContain("resetSession");
    expect(result.details).toMatchObject({ response: "fresh reviewer answer" });
    expect(state.owner).toBe(preservedOwner);
    expect(state.session).toBe(freshReviewer.session);
    expect(state.usage.resetCount).toBe(1);
    expect(state.usage.createdCount).toBe(1);
  });

  it("allows reset requests while idle without recording a reset or leaking the flag into the prompt", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext();
    const reviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("idle reset answer"));
    });

    const result = await executeReviewerBridge(
      state,
      { question: "Can we start fresh?", resetSession: true },
      ctx,
      createDependencies(reviewer.session),
    );

    expect(result.details).toMatchObject({ response: "idle reset answer" });
    expect(reviewer.prompt).toHaveBeenCalledWith(expect.stringContaining("Question:\nCan we start fresh?"));
    expect(reviewer.prompt).toHaveBeenCalledWith(expect.not.stringContaining("resetSession"));
    expect(state.usage.resetCount).toBe(0);
    expect(state.usage.createdCount).toBe(1);
    expect(state.health).toBe("ready");
  });

  it("preserves the existing session when resetSession is explicitly false", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const sessionFile = ctx.sessionManager.getSessionFile();
    const reviewer = createFakeReviewerSession([createAssistantMessage("prior reviewer context")], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("follow-up answer without reset"));
    }, "reviewer-existing");
    const deps = createDependencies(reviewer.session);

    state.owner = {
      cwd: ctx.cwd,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      stableIdentity: sessionFile ? `file:${sessionFile}` : `id:${ctx.sessionManager.getSessionId()}`,
    };
    state.session = reviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    state.health = "ready";

    const result = await executeReviewerBridge(
      state,
      { question: "Can we keep the same reviewer?", resetSession: false },
      ctx,
      deps,
    );

    expect(result.details).toMatchObject({ response: "follow-up answer without reset" });
    expect(reviewer.session.dispose).not.toHaveBeenCalled();
    expect(deps.createAgentSession).not.toHaveBeenCalled();
    expect(reviewer.prompt).toHaveBeenCalledTimes(1);
    expect(reviewer.prompt).toHaveBeenCalledWith(expect.stringContaining("Question:\nCan we keep the same reviewer?"));
    expect(state.session).toBe(reviewer.session);
    expect(state.usage.resetCount).toBe(0);
    expect(state.usage.createdCount).toBe(0);
  });

  it("replaces stale reviewer output and reviewer session identity when resetSession is true", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const sessionFile = ctx.sessionManager.getSessionFile();
    const preservedOwner = {
      cwd: ctx.cwd,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      stableIdentity: sessionFile ? `file:${sessionFile}` : `id:${ctx.sessionManager.getSessionId()}`,
    };
    const staleReviewer = createFakeReviewerSession(
      [createAssistantMessage("stale reviewer memory")],
      async () => {
        throw new Error("stale reviewer should never be prompted again");
      },
      "reviewer-stale",
    );
    const freshReviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("fresh reviewer output"));
    }, "reviewer-fresh");

    state.owner = preservedOwner;
    state.session = staleReviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    state.health = "ready";

    const result = await executeReviewerBridge(
      state,
      { question: "What is the risk now?", resetSession: true },
      ctx,
      createDependencies(freshReviewer.session),
    );

    expect(result.details).toMatchObject({ response: "fresh reviewer output" });
    expect(result.details.response).not.toContain("stale reviewer memory");
    expect(staleReviewer.prompt).not.toHaveBeenCalled();
    expect(staleReviewer.session.dispose).toHaveBeenCalledTimes(1);
    expect(state.owner).toBe(preservedOwner);
    expect(state.session).toBe(freshReviewer.session);
    expect(state.session?.sessionId).toBe("reviewer-fresh");
    expect(state.session?.sessionId).not.toBe("reviewer-stale");
  });

  it("does not double-count resets when an explicit reset is followed by a no-op owner/model path", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const sessionFile = ctx.sessionManager.getSessionFile();
    state.owner = {
      cwd: ctx.cwd,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      stableIdentity: sessionFile ? `file:${sessionFile}` : `id:${ctx.sessionManager.getSessionId()}`,
    };
    const staleReviewer = createFakeReviewerSession([createAssistantMessage("old answer")], undefined, "reviewer-before-reset");
    const freshReviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("reset counted once"));
    }, "reviewer-after-reset");

    state.session = staleReviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    state.health = "ready";

    const deps = createDependencies(freshReviewer.session);

    const result = await executeReviewerBridge(
      state,
      { question: "Did we only reset once?", resetSession: true },
      ctx,
      deps,
    );

    expect(result.details).toMatchObject({ response: "reset counted once" });
    expect(staleReviewer.session.dispose).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(state.usage.resetCount).toBe(1);
    expect(state.usage.createdCount).toBe(1);
    expect(state.modelTarget).toEqual({ provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID });
  });

  it("does not double-count resets when an explicit reset is followed by an owner-change reset path", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const staleReviewer = createFakeReviewerSession(
      [createAssistantMessage("answer from a different main session")],
      undefined,
      "reviewer-old-owner",
    );
    const freshReviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("owner change still counts once"));
    }, "reviewer-new-owner");
    const deps = createDependencies(freshReviewer.session);

    state.owner = {
      cwd: ctx.cwd,
      sessionFile: "/sessions/other-main.jsonl",
      sessionId: "other-main",
      stableIdentity: "file:/sessions/other-main.jsonl",
    };
    state.session = staleReviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    state.health = "ready";

    const result = await executeReviewerBridge(
      state,
      { question: "Did the owner handoff stay single-reset?", resetSession: true },
      ctx,
      deps,
    );

    expect(result.details).toMatchObject({ response: "owner change still counts once" });
    expect(staleReviewer.session.dispose).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(state.usage.resetCount).toBe(1);
    expect(state.usage.createdCount).toBe(1);
    expect(state.owner?.stableIdentity).toBe("file:/sessions/main-1.jsonl");
    expect(state.session).toBe(freshReviewer.session);
  });

  it("applies only the explicit reset when resetSession is combined with a model-family change", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const sessionFile = ctx.sessionManager.getSessionFile();
    state.owner = {
      cwd: ctx.cwd,
      sessionFile,
      sessionId: ctx.sessionManager.getSessionId(),
      stableIdentity: sessionFile ? `file:${sessionFile}` : `id:${ctx.sessionManager.getSessionId()}`,
    };
    const staleReviewer = createFakeReviewerSession([createAssistantMessage("answer from previous model family")], undefined, "reviewer-gpt-main");
    const freshReviewer = createFakeReviewerSession([], async (prompt, messages) => {
      messages.push(createUserMessage(prompt));
      messages.push(createAssistantMessage("fresh answer after model change"));
    }, "reviewer-claude-main");

    state.session = staleReviewer.session;
    state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID };
    state.health = "ready";

    const deps = createDependencies(freshReviewer.session);

    const result = await executeReviewerBridge(
      state,
      { question: "What changed with the new main model?", resetSession: true },
      ctx,
      deps,
    );

    expect(result.details).toMatchObject({ response: "fresh answer after model change" });
    expect(staleReviewer.session.dispose).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(state.usage.resetCount).toBe(1);
    expect(state.usage.createdCount).toBe(1);
    expect(state.modelTarget).toEqual({ provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID });
    expect(state.session).toBe(freshReviewer.session);
  });

  it("keeps bridge execution serialized through the reviewer critical section", async () => {
    const state = createReviewerSessionState();
    let promptCount = 0;
    let releaseFirst!: () => void;
    const reviewer = createFakeReviewerSession([], async (_prompt, messages) => {
      promptCount += 1;
      if (promptCount === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        messages.push(createAssistantMessage("first response"));
        return;
      }

      messages.push(createAssistantMessage("second response"));
    });
    const ctx = createExtensionContext();
    const deps = createDependencies(reviewer.session);

    const first = executeReviewerBridge(state, { question: "first" }, ctx, deps);
    await vi.waitFor(() => {
      expect(reviewer.prompt).toHaveBeenCalledTimes(1);
    });

    const second = executeReviewerBridge(state, { question: "second" }, ctx, deps);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(reviewer.prompt).toHaveBeenCalledTimes(1);
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.details).toMatchObject({ response: "first response" });
    expect(secondResult.details).toMatchObject({ response: "second response" });
    expect(reviewer.prompt).toHaveBeenCalledTimes(2);
  });

  it("does not count initialization failures as reviewer invocation failures", async () => {
    const state = createReviewerSessionState();
    const reviewer = createFakeReviewerSession();
    const deps = createDependencies(reviewer.session);
    deps.createAgentSession = vi.fn(async () => {
      throw new Error("init boom");
    });

    await expect(executeReviewerBridge(state, { question: "Will init fail?" }, createExtensionContext(), deps)).rejects.toThrow(
      /reviewer bridge failed: init boom/i,
    );

    expect(state.usage.initializationFailureCount).toBe(1);
    expect(state.usage.invocationFailureCount).toBe(0);
    expect(state.usage.consecutiveInvocationFailureCount).toBe(0);
  });

  it("surfaces empty or malformed reviewer output and missing main-model errors explicitly", async () => {
    const state = createReviewerSessionState();
    const malformedReviewer = createFakeReviewerSession([], async (_prompt, messages) => {
      messages.push({ ...createAssistantMessage("ignored"), content: [{ nope: true }] });
    });

    await expect(
      executeReviewerBridge(
        state,
        { question: "Is this malformed?" },
        createExtensionContext(),
        createDependencies(malformedReviewer.session),
      ),
    ).rejects.toThrow(/reviewer bridge failed: reviewer assistant message content was malformed/i);

    const emptyReviewer = createFakeReviewerSession([], async (_prompt, messages) => {
      messages.push({ ...createAssistantMessage("ignored"), content: [{ type: "text", text: "   " }] });
    });

    await expect(
      executeReviewerBridge(
        createReviewerSessionState(),
        { question: "Is this empty?" },
        createExtensionContext(),
        createDependencies(emptyReviewer.session),
      ),
    ).rejects.toThrow(/reviewer bridge failed: reviewer invocation produced an empty assistant response/i);

    await expect(
      executeReviewerBridge(
        createReviewerSessionState(),
        { question: "Will this fail?" },
        { ...createExtensionContext(), model: undefined } as ExtensionContext,
        createDependencies(createFakeReviewerSession().session),
      ),
    ).rejects.toThrow(/reviewer bridge failed: reviewer session requires an active main-session model/i);
  });
});

// ---------------------------------------------------------------------------
// Helpers for usage-tracking and render tests
// ---------------------------------------------------------------------------

function createFakeReviewerSessionWithTurnEvents(
  turnEvents: Array<{ input: number; output: number; cacheRead: number; totalTokens: number }>,
  responseText: string,
  modelId = REVIEWER_OPUS_MODEL_ID,
  thinkingLevel = "high",
) {
  const messages: unknown[] = [];
  let capturedListener: ((event: unknown) => void) | undefined;

  const subscribe = vi.fn((listener: (event: unknown) => void) => {
    capturedListener = listener;
    return vi.fn(); // returns unsubscribe fn
  });

  const prompt = vi.fn(async (input: string) => {
    for (const usage of turnEvents) {
      capturedListener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "thinking..." }],
          usage: { ...usage, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
    }
    messages.push({ role: "user", content: input, timestamp: Date.now() });
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: responseText }],
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });
  });

  return {
    session: {
      sessionId: "reviewer-with-turns",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: { id: modelId, provider: REVIEWER_PROVIDER },
      thinkingLevel,
    } as unknown as AgentSession,
    messages,
    prompt,
    subscribe,
  };
}

function createRenderContext() {
  return {
    args: {},
    toolCallId: "test-call",
    invalidate: vi.fn(),
    lastComponent: undefined,
    state: {},
    cwd: "/repo",
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: false,
    showImages: false,
    isError: false,
  };
}

describe("reviewer bridge usage tracking", () => {
  it("accumulates usage from turn_end events and calls onUpdate per turn", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const turnEvents = [
      { input: 1000, output: 200, cacheRead: 500, totalTokens: 1700 },
      { input: 500, output: 100, cacheRead: 200, totalTokens: 800 },
    ];
    const reviewer = createFakeReviewerSessionWithTurnEvents(turnEvents, "review done");
    const updates: Array<{ text: string; details: ReviewerBridgeToolDetails }> = [];
    const onUpdate = vi.fn((r: { content: Array<{ type: string; text: string }>; details: ReviewerBridgeToolDetails }) => {
      updates.push({ text: r.content[0]?.text ?? "", details: r.details });
    });

    const result = await executeReviewerBridge(
      state,
      { question: "Are there risks?" },
      ctx,
      createDependencies(reviewer.session),
      onUpdate,
    );

    expect(onUpdate).toHaveBeenCalledTimes(2);

    // After first turn
    expect(updates[0]!.details).toMatchObject({ turns: 1, usage: { input: 1000, output: 200, cacheRead: 500 } });
    expect(updates[0]!.text).toContain("1 turn");
    expect(updates[0]!.text).toContain("in:1k");

    // After second turn — cumulative
    expect(updates[1]!.details).toMatchObject({ turns: 2, usage: { input: 1500, output: 300, cacheRead: 700 } });
    expect(updates[1]!.text).toContain("2 turns");

    // Final result carries full accumulated stats
    expect(result.details).toMatchObject({
      response: "review done",
      turns: 2,
      usage: { input: 1500, output: 300, cacheRead: 700 },
    });
  });

  it("includes the reviewer model label in the stats line", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents(
      [{ input: 2000, output: 500, cacheRead: 0, totalTokens: 2500 }],
      "answer with model",
      REVIEWER_OPUS_MODEL_ID,
      "high",
    );
    const updates: string[] = [];
    const onUpdate = vi.fn((r: { content: Array<{ type: string; text: string }>; details: ReviewerBridgeToolDetails }) => {
      updates.push(r.content[0]?.text ?? "");
    });

    const result = await executeReviewerBridge(
      state,
      { question: "Does model appear?" },
      ctx,
      createDependencies(reviewer.session),
      onUpdate,
    );

    const expectedModel = `${REVIEWER_OPUS_MODEL_ID}:high`;
    expect(updates[0]).toContain(expectedModel);
    expect(result.details.model).toBe(expectedModel);
  });

  it("shows no stats when the reviewer completes in zero turns", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents([], "instant answer");
    const onUpdate = vi.fn();

    const result = await executeReviewerBridge(
      state,
      { question: "Quick check" },
      ctx,
      createDependencies(reviewer.session),
      onUpdate,
    );

    expect(onUpdate).not.toHaveBeenCalled();
    expect(result.details.turns).toBe(0);
    expect(result.details.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0 });
  });

  it("unsubscribes from the reviewer session after execution", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents(
      [{ input: 100, output: 50, cacheRead: 0, totalTokens: 150 }],
      "done",
    );

    await executeReviewerBridge(state, { question: "Check unsubscribe" }, ctx, createDependencies(reviewer.session));

    const unsubscribeFn = reviewer.subscribe.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(reviewer.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it("does not count maintenance/compaction turn events in usage stats", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");

    // Simulate: one real reviewer turn, then a maintenance turn fired after prompt() returns
    let capturedListener: ((event: unknown) => void) | undefined;
    const messages: unknown[] = [];

    const subscribe = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return vi.fn();
    });

    const fireTurnEnd = (input: number) =>
      capturedListener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "..." }],
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: {} },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });

    const prompt = vi.fn(async (input: string) => {
      fireTurnEnd(1000); // real reviewer turn
      messages.push({ role: "user", content: input, timestamp: Date.now() });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "review answer" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      // NOTE: maintenance turn fired AFTER prompt resolves but before unsubscribe
      // (simulates compaction emitting turn_end during runReviewerMaintenanceLocked)
    });

    const session = {
      sessionId: "test",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: { id: REVIEWER_OPUS_MODEL_ID, provider: REVIEWER_PROVIDER },
      thinkingLevel: "high",
    } as unknown as AgentSession;

    // Intercept runReviewerMaintenanceLocked by firing a spurious turn_end after prompt returns
    // We do this via the subscribe — the unsubscribe should already be called before maintenance
    const deps = createDependencies(session);
    const result = await executeReviewerBridge(state, { question: "Compaction check" }, ctx, deps);

    // Fire a maintenance turn after the call completes (unsubscribe should have been called already)
    fireTurnEnd(99999);

    // Stats should only reflect the 1 real turn — not the post-unsubscribe maintenance event
    expect(result.details.turns).toBe(1);
    expect(result.details.usage?.input).toBe(1000);
  });

  it("does not expose totalTokens on the public usage object", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents(
      [{ input: 500, output: 100, cacheRead: 0, totalTokens: 600 }],
      "answer",
    );

    const result = await executeReviewerBridge(state, { question: "Check shape" }, ctx, createDependencies(reviewer.session));

    expect(result.details.usage).not.toHaveProperty("totalTokens");
    expect(result.details.usage).toEqual({ input: 500, output: 100, cacheRead: 0 });
  });

  it("partial onUpdate details.usage does not contain totalTokens", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents(
      [{ input: 200, output: 50, cacheRead: 0, totalTokens: 250 }],
      "answer",
    );
    const partialUpdates: ReviewerBridgeToolDetails[] = [];
    const onUpdate = vi.fn((r: { content: unknown; details: ReviewerBridgeToolDetails }) => {
      partialUpdates.push(r.details);
    });

    await executeReviewerBridge(state, { question: "Check partial shape" }, ctx, createDependencies(reviewer.session), onUpdate);

    expect(partialUpdates).toHaveLength(1);
    expect(partialUpdates[0]!.usage).not.toHaveProperty("totalTokens");
    expect(partialUpdates[0]!.usage).toEqual({ input: 200, output: 50, cacheRead: 0 });
  });

  it("preserves the original error when extraction throws after prompt — unsubscribe is still called", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    const subscribe = vi.fn(() => vi.fn());
    const prompt = vi.fn(async (input: string) => {
      // Push a user message but NO assistant message — extractCurrentReviewerResponseText will throw
      messages.push({ role: "user", content: input, timestamp: Date.now() });
    });
    const session = {
      sessionId: "test-extract-throw",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    await expect(
      executeReviewerBridge(state, { question: "Will extraction fail?" }, ctx, createDependencies(session)),
    ).rejects.toThrow(/reviewer bridge failed/i);

    const unsubscribeFn = subscribe.mock.results[0]?.value as ReturnType<typeof vi.fn>;
    expect(unsubscribeFn).toHaveBeenCalledTimes(1);
  });

  it("does not abort execution when unsubscribe throws", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    const throwingUnsubscribe = vi.fn(() => { throw new Error("unsubscribe exploded"); });
    const subscribe = vi.fn(() => throwingUnsubscribe);
    const prompt = vi.fn(async (input: string) => {
      messages.push({ role: "user", content: input, timestamp: Date.now() });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "answer despite unsubscribe throw" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    });
    const session = {
      sessionId: "test-unsub-throw",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    const result = await executeReviewerBridge(
      state, { question: "Does unsubscribe throw matter?" }, ctx, createDependencies(session),
    );

    expect(result.details.response).toBe("answer despite unsubscribe throw");
    expect(throwingUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("clamps NaN, Infinity, and negative usage values to zero", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    let capturedListener: ((event: unknown) => void) | undefined;
    const subscribe = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return vi.fn();
    });
    const prompt = vi.fn(async (input: string) => {
      capturedListener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [],
          usage: { input: NaN, output: Infinity, cacheRead: -500, cacheWrite: 0, totalTokens: NaN, cost: {} },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });
      messages.push({ role: "user", content: input, timestamp: Date.now() });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    });
    const session = {
      sessionId: "test-bad-usage",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    const result = await executeReviewerBridge(
      state, { question: "Malformed usage values" }, ctx, createDependencies(session),
    );

    expect(result.details.turns).toBe(1);
    expect(result.details.usage?.input).toBe(0);   // NaN clamped
    expect(result.details.usage?.output).toBe(0);  // Infinity clamped
    expect(result.details.usage?.cacheRead).toBe(0); // negative clamped
  });

  it("does not count late turn_end events when unsubscribe threw and failed to detach", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    let capturedListener: ((event: unknown) => void) | undefined;

    const throwingUnsubscribe = vi.fn(() => { throw new Error("unsubscribe exploded"); });
    const subscribe = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return throwingUnsubscribe;
    });

    const fireTurnEnd = (input: number) =>
      capturedListener?.({
        type: "turn_end",
        message: {
          role: "assistant",
          content: [],
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: {} },
          stopReason: "stop",
          timestamp: Date.now(),
        },
      });

    const prompt = vi.fn(async (input: string) => {
      fireTurnEnd(500); // real turn
      messages.push({ role: "user", content: input, timestamp: Date.now() });
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: "real answer" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
        stopReason: "stop",
        timestamp: Date.now(),
      });
    });

    const session = {
      sessionId: "test-late-event",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    const onUpdate = vi.fn();
    const result = await executeReviewerBridge(
      state, { question: "Late event guard" }, ctx, createDependencies(session), onUpdate,
    );

    // Fire a late event after execution completed (unsubscribe threw, but trackingActive blocks it)
    fireTurnEnd(99999);

    expect(result.details.turns).toBe(1);
    expect(result.details.usage?.input).toBe(500);
    expect(onUpdate).toHaveBeenCalledTimes(1); // only the real turn, not the late event
  });

  it("records invocation failure and wraps error when subscribe itself throws", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    const subscribe = vi.fn(() => { throw new Error("subscribe exploded"); });
    const prompt = vi.fn();
    const session = {
      sessionId: "test-sub-throw",
      messages,
      prompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    await expect(
      executeReviewerBridge(state, { question: "Does subscribe throw propagate?" }, ctx, createDependencies(session)),
    ).rejects.toThrow(/reviewer bridge failed.*subscribe exploded/i);

    expect(prompt).not.toHaveBeenCalled();
    expect(state.usage.invocationFailureCount).toBe(1);
  });

  it("stops tracking turns before failure handling so dispose-time events are not counted", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const messages: unknown[] = [];
    let capturedListener: ((event: unknown) => void) | undefined;

    const unsubscribe = vi.fn(() => { throw new Error("unsubscribe boom"); });
    const subscribe = vi.fn((listener: (event: unknown) => void) => {
      capturedListener = listener;
      return unsubscribe;
    });

    const fireTurnEnd = (input: number) =>
      capturedListener?.({
        type: "turn_end",
        message: {
          role: "assistant", content: [],
          usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: {} },
          stopReason: "stop", timestamp: Date.now(),
        },
      });

    const onUpdate = vi.fn();
    const failingPrompt = vi.fn(async (input: string) => {
      fireTurnEnd(1000); // a real turn fires
      messages.push({ role: "user", content: input, timestamp: Date.now() });
      throw new Error("prompt blew up");
    });

    const session = {
      sessionId: "test-failure-cleanup",
      messages,
      prompt: failingPrompt,
      subscribe,
      dispose: vi.fn(),
      model: undefined,
      thinkingLevel: "off",
    } as unknown as AgentSession;

    await expect(
      executeReviewerBridge(state, { question: "Failure cleanup order" }, ctx, createDependencies(session), onUpdate),
    ).rejects.toThrow(/reviewer bridge failed.*prompt blew up/i);

    // Fire a spurious event to simulate session dispose emitting during failure handling
    fireTurnEnd(99999);

    // Only the 1 real turn should be in onUpdate; the post-failure event is blocked
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(state.usage.invocationFailureCount).toBe(1);
  });

  it("does not abort execution when initial onUpdate throws", async () => {
    const state = createReviewerSessionState();
    const ctx = createExtensionContext("claude-sonnet-4.6");
    const reviewer = createFakeReviewerSessionWithTurnEvents([], "answer");
    const tool = createReviewerBridgeTool(state, createDependencies(reviewer.session));

    let callCount = 0;
    const throwingOnUpdate = vi.fn((_r: unknown) => {
      callCount++;
      throw new Error("onUpdate exploded");
    });

    const result = await tool.execute(
      "test-id",
      { question: "Does initial onUpdate throw matter?" },
      undefined,
      throwingOnUpdate,
      ctx,
    );

    expect(result.details?.response).toBe("answer");
    expect(callCount).toBe(1); // initial update fired once, threw, execution continued
  });
});

describe("formatReviewerUsage", () => {
  it("formats turns, tokens, cache, and model into a compact stats line", () => {
    const usage: ReviewerBridgeUsage = { input: 23000, output: 1500, cacheRead: 90000 };
    expect(formatReviewerUsage(7, usage, "gpt-5.4:medium")).toBe("7 turns in:23k out:1.5k R90k gpt-5.4:medium");
  });

  it("omits zero fields", () => {
    const usage: ReviewerBridgeUsage = { input: 5000, output: 0, cacheRead: 0 };
    expect(formatReviewerUsage(1, usage)).toBe("1 turn in:5k");
  });

  it("omits model when not provided", () => {
    const usage: ReviewerBridgeUsage = { input: 1000, output: 200, cacheRead: 0 };
    expect(formatReviewerUsage(2, usage)).toBe("2 turns in:1k out:200");
  });
});

describe("reviewer bridge rendering", () => {
  it("renderCall shows truncated question after 'reviewer' label", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
    const ctx = createRenderContext();

    const long = "A".repeat(80);
    const component = tool.renderCall!({ question: long }, theme as never, ctx as never);
    const lines = component.render(200);

    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("A".repeat(60));
    expect(lines[0]).not.toContain("A".repeat(61));
    expect(lines[0]).toContain("…");
  });

  it("renderCall shows full question when short", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
    const ctx = createRenderContext();

    const component = tool.renderCall!({ question: "Short question?" }, theme as never, ctx as never);
    const lines = component.render(200);

    expect(lines[0]).toContain("Short question?");
    expect(lines[0]).not.toContain("…");
  });

  it("renderResult with isPartial shows spinner and stats line", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
    const ctx = createRenderContext();

    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "" }],
        details: {
          turns: 3,
          usage: { input: 5000, output: 1500, cacheRead: 90000 },
          model: "gpt-5.4:medium",
        },
      },
      { isPartial: true, expanded: false },
      theme as never,
      ctx as never,
    );
    const rendered = component.render(200).join("\n");

    expect(rendered).toContain("...");
    expect(rendered).toContain("3 turns");
    expect(rendered).toContain("in:5k");
    expect(rendered).toContain("out:1.5k");
    expect(rendered).toContain("R90k");
    expect(rendered).toContain("gpt-5.4:medium");
  });

  it("renderResult with isPartial shows 'thinking...' when no turns yet", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
    const ctx = createRenderContext();

    const component = tool.renderResult!(
      { content: [{ type: "text", text: "Consulting reviewer..." }], details: { response: "Consulting reviewer..." } },
      { isPartial: true, expanded: false },
      theme as never,
      ctx as never,
    );
    const rendered = component.render(200).join("\n");

    expect(rendered).toContain("thinking…");
  });

  it("renderResult without isPartial shows response text and stats", () => {
    const state = createReviewerSessionState();
    const tool = createReviewerBridgeTool(state);
    const theme = { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t, bold: (t: string) => t, dim: (t: string) => t };
    const ctx = createRenderContext();

    const component = tool.renderResult!(
      {
        content: [{ type: "text", text: "Risk: the migration is unsafe." }],
        details: {
          response: "Risk: the migration is unsafe.",
          turns: 2,
          usage: { input: 3000, output: 400, cacheRead: 0 },
          model: "claude-opus-4.6:high",
        },
      },
      { isPartial: false, expanded: false },
      theme as never,
      ctx as never,
    );
    const rendered = component.render(200).join("\n");

    expect(rendered).toContain("Risk: the migration is unsafe.");
    expect(rendered).toContain("2 turns");
    expect(rendered).toContain("in:3k");
    expect(rendered).toContain("out:400");
  });
});
