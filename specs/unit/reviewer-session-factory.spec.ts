import {
  DefaultResourceLoader,
  type AgentSession,
  type AuthStorage,
  type CreateAgentSessionOptions,
  type ModelRegistry,
  type SessionManager,
} from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  REVIEWER_GPT_MODEL_ID,
  REVIEWER_OPUS_MODEL_ID,
  REVIEWER_PROVIDER,
  assertReviewerResourceLoaderIsolation,
  buildReviewerResourceLoaderOptions,
  ensureReviewerSession,
  isSameReviewerModelTarget,
  resolveReviewerModel,
  selectReviewerModelTarget,
  withReviewerSession,
  type ReviewerMainModel,
  type ReviewerSessionFactoryDependencies,
} from "../../src/reviewer/session-factory.ts";
import {
  claimReviewerSessionOwner,
  createReviewerSessionState,
  disposeReviewerSessionState,
  getReviewerSessionOwner,
} from "../../src/reviewer/session-state.ts";

function createFakeSession(name: string) {
  return {
    sessionId: name,
    sessionFile: undefined,
    dispose: vi.fn(),
  } as unknown as AgentSession;
}

function createOwnerContext(sessionId: string, sessionFile?: string, cwd = "/repo") {
  return {
    cwd,
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };
}

function createMainModel(id: string, provider = REVIEWER_PROVIDER): ReviewerMainModel {
  return { provider, id };
}

type ReviewerResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ReviewerResourceLoader = NonNullable<CreateAgentSessionOptions["resourceLoader"]>;
type ReviewerTools = NonNullable<CreateAgentSessionOptions["tools"]>;

function createDependencies(overrides: Partial<ReviewerSessionFactoryDependencies> = {}) {
  const createdSessions: AgentSession[] = [];
  const createAuthStorage = vi.fn(() => ({}) as AuthStorage);
  const createReadOnlyTools = vi.fn(() => [] as ReviewerTools);
  const createInMemorySessionManager = vi.fn(() => ({}) as SessionManager);
  const modelRegistry = {
    find: vi.fn((provider: string, modelId: string) => ({ provider, id: modelId })),
  } as unknown as ModelRegistry;
  const createModelRegistry = vi.fn(() => modelRegistry);
  const resourceLoader = {
    reload: vi.fn(async () => undefined),
  } as unknown as ReviewerResourceLoader;
  const createResourceLoader = vi.fn((_options: ReviewerResourceLoaderOptions) => resourceLoader);
  const createAgentSession = vi.fn(async (_options: CreateAgentSessionOptions) => {
    const session = createFakeSession(`reviewer-${createdSessions.length + 1}`);
    createdSessions.push(session);
    return { session };
  });

  return {
    createdSessions,
    createAuthStorage,
    createModelRegistry,
    createResourceLoader,
    createInMemorySessionManager,
    createReadOnlyTools,
    createAgentSession,
    modelRegistry,
    resourceLoader,
    dependencies: {
      createAuthStorage,
      createModelRegistry,
      createResourceLoader,
      createInMemorySessionManager,
      createReadOnlyTools,
      createAgentSession,
      ...overrides,
    } satisfies ReviewerSessionFactoryDependencies,
  };
}

describe("reviewer session factory", () => {
  it("creates and reuses a reviewer session for the same owner", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const ctx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("gpt-5.4"),
    };

    const first = await ensureReviewerSession(state, ctx, deps.dependencies);
    const second = await ensureReviewerSession(state, ctx, deps.dependencies);

    expect(first).toBe(second);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(1);
    expect(deps.createInMemorySessionManager).toHaveBeenCalledTimes(1);
    expect(deps.createReadOnlyTools).toHaveBeenCalledWith("/repo");
    expect(deps.resourceLoader.reload).toHaveBeenCalledTimes(1);
    expect(state.health).toBe("ready");
    expect(state.usage.createdCount).toBe(1);
    expect(state.owner?.stableIdentity).toBe("file:/sessions/main-1.jsonl");

    const createSessionOptions = deps.createAgentSession.mock.calls[0]?.[0];
    expect(createSessionOptions?.thinkingLevel).toBe("high");
    expect(createSessionOptions?.cwd).toBe("/repo");
    expect((createSessionOptions?.model as ReviewerMainModel).provider).toBe(REVIEWER_PROVIDER);
    expect((createSessionOptions?.model as ReviewerMainModel).id).toBe(REVIEWER_OPUS_MODEL_ID);

    const resourceLoaderOptions = deps.createResourceLoader.mock.calls[0]?.[0];
    expect(resourceLoaderOptions?.noExtensions).toBe(true);
    expect(resourceLoaderOptions?.noSkills).toBe(true);
    expect(resourceLoaderOptions?.noPromptTemplates).toBe(true);
    expect(resourceLoaderOptions?.noThemes).toBe(true);
  });

  it("resets and recreates the reviewer session when ownership changes", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const firstCtx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("gpt-5.4"),
    };
    const secondCtx = {
      ...createOwnerContext("main-2", "/sessions/main-2.jsonl"),
      model: createMainModel("gpt-5.4"),
    };

    const first = await ensureReviewerSession(state, firstCtx, deps.dependencies);
    const second = await ensureReviewerSession(state, secondCtx, deps.dependencies);

    expect(first).not.toBe(second);
    expect((first.dispose as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(2);
    expect(state.usage.resetCount).toBe(1);
    expect(state.owner?.stableIdentity).toBe("file:/sessions/main-2.jsonl");
  });

  it("resets and recreates the reviewer session when cwd changes for the same owner identity", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const firstCtx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl", "/repo-a"),
      model: createMainModel("gpt-5.4"),
    };
    const secondCtx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl", "/repo-b"),
      model: createMainModel("gpt-5.4"),
    };

    const first = await ensureReviewerSession(state, firstCtx, deps.dependencies);
    const second = await ensureReviewerSession(state, secondCtx, deps.dependencies);

    expect(first).not.toBe(second);
    expect((first.dispose as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(2);
    expect(state.usage.resetCount).toBe(1);
    expect(state.owner?.stableIdentity).toBe("file:/sessions/main-1.jsonl");
    expect(state.owner?.cwd).toBe("/repo-b");
    expect(deps.createReadOnlyTools).toHaveBeenNthCalledWith(1, "/repo-a");
    expect(deps.createReadOnlyTools).toHaveBeenNthCalledWith(2, "/repo-b");
  });

  it("resets and recreates the reviewer session when the main-session reviewer target model changes", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const firstCtx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("gpt-5.4"),
    };
    const secondCtx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("claude-sonnet-4.6"),
    };

    const first = await ensureReviewerSession(state, firstCtx, deps.dependencies);
    const second = await ensureReviewerSession(state, secondCtx, deps.dependencies);

    expect(first).not.toBe(second);
    expect((first.dispose as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(deps.createAgentSession).toHaveBeenCalledTimes(2);
    expect(state.usage.resetCount).toBe(1);
    expect(state.modelTarget).toEqual({
      provider: REVIEWER_PROVIDER,
      id: REVIEWER_GPT_MODEL_ID,
    });
  });

  it("serializes concurrent initialization and returns the same session", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const ctx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("claude-sonnet-4.6"),
    };

    let releaseCreate!: () => void;
    deps.dependencies.createAgentSession = vi.fn(
      () =>
        new Promise<{ session: AgentSession }>((resolve) => {
          releaseCreate = () => resolve({ session: createFakeSession("serialized-reviewer") });
        }),
    );

    const firstPromise = ensureReviewerSession(state, ctx, deps.dependencies);
    const secondPromise = ensureReviewerSession(state, ctx, deps.dependencies);

    await vi.waitFor(() => {
      expect(deps.dependencies.createAgentSession).toHaveBeenCalledTimes(1);
    });
    releaseCreate();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first).toBe(second);
    expect(deps.dependencies.createAgentSession).toHaveBeenCalledTimes(1);
    expect(state.health).toBe("ready");
    expect(state.usage.createdCount).toBe(1);
  });

  it("keeps ensure plus session work inside one serialized critical section via withReviewerSession", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const ctx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("claude-sonnet-4.6"),
    };

    const order: string[] = [];
    let releaseFirst!: () => void;
    const secondOperation = vi.fn(async () => {
      order.push("start:second");
      return "second";
    });

    const firstPromise = withReviewerSession(
      state,
      ctx,
      async (session) => {
        order.push(`start:${session.sessionId}`);
        await new Promise<void>((resolve) => {
          releaseFirst = () => {
            order.push("finish:first");
            resolve();
          };
        });
        return "first";
      },
      deps.dependencies,
    );

    await vi.waitFor(() => {
      expect(order).toEqual(["start:reviewer-1"]);
    });

    const secondPromise = withReviewerSession(state, ctx, secondOperation, deps.dependencies);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(secondOperation).not.toHaveBeenCalled();
    releaseFirst();

    const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);

    expect(firstResult).toBe("first");
    expect(secondResult).toBe("second");
    expect(order).toEqual(["start:reviewer-1", "finish:first", "start:second"]);
    expect(deps.dependencies.createAgentSession).toHaveBeenCalledTimes(1);
  });

  it("records failed initialization and safely recovers on the next attempt", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const ctx = {
      ...createOwnerContext("main-1"),
      model: createMainModel("claude-opus-4.6"),
    };

    deps.dependencies.createAgentSession = vi
      .fn<ReviewerSessionFactoryDependencies["createAgentSession"]>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ session: createFakeSession("reviewer-recovered") });

    await expect(ensureReviewerSession(state, ctx, deps.dependencies)).rejects.toThrow("boom");
    expect(state.health).toBe("failed");
    expect(state.session).toBeUndefined();
    expect(state.usage.initializationFailureCount).toBe(1);

    const recovered = await ensureReviewerSession(state, ctx, deps.dependencies);

    expect(recovered.sessionId).toBe("reviewer-recovered");
    expect(state.health).toBe("ready");
    expect(state.lastError).toBeUndefined();
    expect(state.usage.createdCount).toBe(1);
    expect(deps.dependencies.createAgentSession).toHaveBeenCalledTimes(2);
  });

  it("disposes reviewer state cleanly", async () => {
    const state = createReviewerSessionState();
    const deps = createDependencies();
    const ctx = {
      ...createOwnerContext("main-1", "/sessions/main-1.jsonl"),
      model: createMainModel("gpt-5.4"),
    };

    const session = await ensureReviewerSession(state, ctx, deps.dependencies);
    await disposeReviewerSessionState(state, { clearOwner: true, health: "disposed" });

    expect((session.dispose as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(state.session).toBeUndefined();
    expect(state.owner).toBeUndefined();
    expect(state.health).toBe("disposed");
    expect(state.usage.disposeCount).toBe(1);
  });

  it("uses session file when available and falls back to session id for ownership", async () => {
    const state = createReviewerSessionState();

    const fileOwner = getReviewerSessionOwner(createOwnerContext("main-1", "/sessions/main-1.jsonl"));
    const memoryOwner = getReviewerSessionOwner(createOwnerContext("main-2"));

    expect(fileOwner.stableIdentity).toBe("file:/sessions/main-1.jsonl");
    expect(memoryOwner.stableIdentity).toBe("id:main-2");

    const claim = await claimReviewerSessionOwner(state, createOwnerContext("main-2"), "session_start");
    expect(claim.owner.stableIdentity).toBe("id:main-2");
    expect(state.owner?.stableIdentity).toBe("id:main-2");
  });

  it("builds isolated reviewer resource-loader options with upfront prevention flags", () => {
    const options = buildReviewerResourceLoaderOptions("/repo");

    expect(options.cwd).toBe("/repo");
    expect(options.noExtensions).toBe(true);
    expect(options.noSkills).toBe(true);
    expect(options.noPromptTemplates).toBe(true);
    expect(options.noThemes).toBe(true);
    expect(options.systemPromptOverride?.(undefined)).toContain("internal reviewer");
    expect(options.appendSystemPromptOverride?.(["extra"]) ?? ["extra"]).toEqual([]);
    expect(options.agentsFilesOverride?.({ agentsFiles: [{ path: "AGENTS.md", content: "x" }] })).toEqual({
      agentsFiles: [],
    });

    expect(() => assertReviewerResourceLoaderIsolation(options)).not.toThrow();
  });

  it("fails explicitly for unsupported model policy and missing reviewer target model", () => {
    expect(() => selectReviewerModelTarget(createMainModel("gpt-5.4", "openai"))).toThrow(
      /only supports github-copilot main models/i,
    );
    expect(() => selectReviewerModelTarget(createMainModel("gemini-2.5-pro"))).toThrow(/does not support/i);
    expect(() => selectReviewerModelTarget(createMainModel("claude-haiku-4.5"))).toThrow(/haiku main models are explicitly rejected/i);
    expect(() => selectReviewerModelTarget(createMainModel("claude-3.7"))).toThrow(
      /only github copilot gpt, sonnet, or opus main models are allowed/i,
    );

    expect(selectReviewerModelTarget(createMainModel("gpt-5.4"))).toEqual({
      provider: REVIEWER_PROVIDER,
      id: REVIEWER_OPUS_MODEL_ID,
    });
    expect(selectReviewerModelTarget(createMainModel("claude-sonnet-4.6"))).toEqual({
      provider: REVIEWER_PROVIDER,
      id: REVIEWER_GPT_MODEL_ID,
    });
    expect(selectReviewerModelTarget(createMainModel("claude-opus-4.6"))).toEqual({
      provider: REVIEWER_PROVIDER,
      id: REVIEWER_GPT_MODEL_ID,
    });

    expect(isSameReviewerModelTarget(undefined, undefined)).toBe(true);
    expect(
      isSameReviewerModelTarget(
        { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID },
        { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID },
      ),
    ).toBe(true);
    expect(
      isSameReviewerModelTarget(
        { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID },
        { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID },
      ),
    ).toBe(false);

    const modelRegistry = {
      find: vi.fn(() => undefined),
    } as unknown as Pick<ModelRegistry, "find">;
    expect(
      () =>
        resolveReviewerModel(
          { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID },
          modelRegistry,
        ),
    ).toThrow(`${REVIEWER_PROVIDER}/${REVIEWER_OPUS_MODEL_ID}`);
  });

  it("detects isolated loader misconfiguration via upfront prevention assertions", () => {
    expect(() =>
      assertReviewerResourceLoaderIsolation({
        noExtensions: false,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => "ok",
        appendSystemPromptOverride: () => [],
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      }),
    ).toThrow(/noExtensions: true/i);

    expect(() =>
      assertReviewerResourceLoaderIsolation({
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPromptOverride: () => "ok",
        appendSystemPromptOverride: () => ["should-not-be-here"],
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      }),
    ).toThrow(/suppress appended system prompt content/i);
  });
});
