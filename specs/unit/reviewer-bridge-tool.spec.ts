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
  REVIEWER_BRIDGE_TOOL_NAME,
  REVIEWER_BRIDGE_TOOL_PARAMETERS,
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
    expect(result.details).toEqual({ response: "concise reviewer answer" });
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
    expect(result.details).toEqual({ response: "fresh reviewer answer" });
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

    expect(result.details).toEqual({ response: "idle reset answer" });
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

    expect(result.details).toEqual({ response: "follow-up answer without reset" });
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

    expect(result.details).toEqual({ response: "fresh reviewer output" });
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

    expect(result.details).toEqual({ response: "reset counted once" });
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

    expect(result.details).toEqual({ response: "owner change still counts once" });
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

    expect(result.details).toEqual({ response: "fresh answer after model change" });
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

    expect(firstResult.details).toEqual({ response: "first response" });
    expect(secondResult.details).toEqual({ response: "second response" });
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
