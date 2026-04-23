import {
  AuthStorage,
  createAgentSession,
  createReadOnlyTools,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@mariozechner/pi-coding-agent";

import {
  getReviewerSessionOwner,
  isSameReviewerSessionOwner,
  resetReviewerSessionStateLocked,
  type ReviewerSessionModelTarget,
  type ReviewerSessionOwnerContext,
  type ReviewerSessionState,
} from "./session-state.ts";

export const REVIEWER_SYSTEM_PROMPT = `You are an internal reviewer supporting another Pi coding agent.

Your job is to critique plans, identify risks, spot missing constraints, and suggest concrete improvements.
Prefer precise, decision-useful feedback. Be skeptical, concise, and actionable.
You are isolated from the parent session state except for prompts explicitly sent to you.
Only use the read-only tools available in this reviewer session.`;

export const REVIEWER_PROVIDER = "github-copilot";
export const REVIEWER_OPUS_MODEL_ID = "claude-opus-4.6";
export const REVIEWER_GPT_MODEL_ID = "gpt-5.4";

export interface ReviewerMainModel {
  provider: string;
  id: string;
}

export type ReviewerModelTarget = ReviewerSessionModelTarget;

export interface ReviewerSessionFactoryContext extends ReviewerSessionOwnerContext {
  model: ReviewerMainModel | undefined;
}

type ReviewerResourceLoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0];
type ReviewerResourceLoader = NonNullable<CreateAgentSessionOptions["resourceLoader"]>;
type ReviewerBuiltInTools = NonNullable<CreateAgentSessionOptions["tools"]>;

export interface ReviewerSessionFactoryDependencies {
  createAgentSession(options: CreateAgentSessionOptions): Promise<{ session: AgentSession }>;
  createAuthStorage(): AuthStorage;
  createModelRegistry(authStorage: AuthStorage): ModelRegistry;
  createResourceLoader(options: ReviewerResourceLoaderOptions): ReviewerResourceLoader;
  createInMemorySessionManager(): SessionManager;
  createReadOnlyTools(cwd: string): ReviewerBuiltInTools;
}

export const defaultReviewerSessionFactoryDependencies: ReviewerSessionFactoryDependencies = {
  createAgentSession,
  createAuthStorage: () => AuthStorage.create(),
  createModelRegistry: (authStorage) => new ModelRegistry(authStorage),
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createInMemorySessionManager: () => SessionManager.inMemory(),
  createReadOnlyTools,
};

function emptyAgentsFiles() {
  return { agentsFiles: [] };
}

export function buildReviewerResourceLoaderOptions(cwd: string): ReviewerResourceLoaderOptions {
  return {
    cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => REVIEWER_SYSTEM_PROMPT,
    appendSystemPromptOverride: () => [],
    agentsFilesOverride: () => emptyAgentsFiles(),
  };
}

export function assertReviewerResourceLoaderIsolation(options: ReviewerResourceLoaderOptions) {
  if (options.noExtensions !== true) {
    throw new Error("Reviewer resource loader must prevent extension loading up front via noExtensions: true.");
  }

  if (options.noSkills !== true) {
    throw new Error("Reviewer resource loader must prevent skill loading up front via noSkills: true.");
  }

  if (options.noPromptTemplates !== true) {
    throw new Error(
      "Reviewer resource loader must prevent prompt-template loading up front via noPromptTemplates: true.",
    );
  }

  if (options.noThemes !== true) {
    throw new Error("Reviewer resource loader must prevent theme loading up front via noThemes: true.");
  }

  const systemPrompt = options.systemPromptOverride?.(undefined);
  if (!systemPrompt || systemPrompt.trim().length === 0) {
    throw new Error("Reviewer resource loader must provide a non-empty systemPromptOverride.");
  }

  if ((options.appendSystemPromptOverride?.(["append-me"]) ?? ["append-me"]).length !== 0) {
    throw new Error("Reviewer resource loader must suppress appended system prompt content.");
  }

  const agentsFiles = options.agentsFilesOverride?.({
    agentsFiles: [{ path: "AGENTS.md", content: "test" }],
  });
  if (!agentsFiles || agentsFiles.agentsFiles.length !== 0) {
    throw new Error("Reviewer resource loader must strip inherited AGENTS/context files.");
  }
}

export function selectReviewerModelTarget(mainModel: ReviewerMainModel | undefined): ReviewerModelTarget {
  if (!mainModel) {
    throw new Error("Reviewer session requires an active main-session model.");
  }

  if (mainModel.provider !== REVIEWER_PROVIDER) {
    throw new Error(
      `Reviewer session only supports ${REVIEWER_PROVIDER} main models. Received ${mainModel.provider}/${mainModel.id}.`,
    );
  }

  const modelId = mainModel.id.toLowerCase();
  if (modelId.startsWith("gpt-")) {
    return { provider: REVIEWER_PROVIDER, id: REVIEWER_OPUS_MODEL_ID };
  }

  if (modelId.startsWith("claude-")) {
    if (modelId.includes("haiku")) {
      throw new Error(
        `Reviewer session does not support ${mainModel.provider}/${mainModel.id}. Haiku main models are explicitly rejected; use a GitHub Copilot GPT, Sonnet, or Opus model.`,
      );
    }

    if (modelId.includes("sonnet") || modelId.includes("opus")) {
      return { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    }

    throw new Error(
      `Reviewer session does not support ${mainModel.provider}/${mainModel.id}. Only GitHub Copilot GPT, Sonnet, or Opus main models are allowed.`,
    );
  }

  throw new Error(
    `Reviewer session does not support ${mainModel.provider}/${mainModel.id}. Expected a GitHub Copilot GPT, Sonnet, or Opus model.`,
  );
}

export function isSameReviewerModelTarget(
  left: ReviewerModelTarget | undefined,
  right: ReviewerModelTarget | undefined,
) {
  return left?.provider === right?.provider && left?.id === right?.id;
}

export function resolveReviewerModel(target: ReviewerModelTarget, modelRegistry: Pick<ModelRegistry, "find">) {
  const reviewerModel = modelRegistry.find(target.provider, target.id);

  if (!reviewerModel) {
    throw new Error(
      `Reviewer session requires ${target.provider}/${target.id}, but that model is not available in the registry.`,
    );
  }

  return reviewerModel;
}

export async function ensureReviewerSessionLocked(
  state: ReviewerSessionState,
  ctx: ReviewerSessionFactoryContext,
  dependencies: ReviewerSessionFactoryDependencies = defaultReviewerSessionFactoryDependencies,
) {
  const nextOwner = getReviewerSessionOwner(ctx);
  if (!isSameReviewerSessionOwner(state.owner, nextOwner)) {
    await resetReviewerSessionStateLocked(state, {
      health: "idle",
      clearOwner: false,
    });
    state.owner = nextOwner;
  }

  const target = selectReviewerModelTarget(ctx.model);
  if (state.session && !isSameReviewerModelTarget(state.modelTarget, target)) {
    await resetReviewerSessionStateLocked(state, {
      health: "idle",
      clearOwner: false,
    });
  }

  if (state.session) {
    return state.session;
  }

  state.health = "initializing";
  state.lastError = undefined;

  try {
    const authStorage = dependencies.createAuthStorage();
    const modelRegistry = dependencies.createModelRegistry(authStorage);
    const resourceLoaderOptions = buildReviewerResourceLoaderOptions(ctx.cwd);
    assertReviewerResourceLoaderIsolation(resourceLoaderOptions);
    const resourceLoader = dependencies.createResourceLoader(resourceLoaderOptions);
    await resourceLoader.reload();

    const reviewerModel = resolveReviewerModel(target, modelRegistry);
    const result = await dependencies.createAgentSession({
      cwd: ctx.cwd,
      authStorage,
      modelRegistry,
      model: reviewerModel,
      thinkingLevel: "high",
      resourceLoader,
      sessionManager: dependencies.createInMemorySessionManager(),
      tools: dependencies.createReadOnlyTools(ctx.cwd),
    });

    state.session = result.session;
    state.modelTarget = target;
    state.health = "ready";
    state.lastError = undefined;
    state.usage.createdCount += 1;
    state.usage.lastCreatedAt = new Date().toISOString();

    return result.session;
  } catch (error) {
    state.session = undefined;
    state.modelTarget = undefined;
    state.health = "failed";
    state.lastError = error;
    state.usage.initializationFailureCount += 1;
    throw error;
  }
}

export async function withReviewerSession<T>(
  state: ReviewerSessionState,
  ctx: ReviewerSessionFactoryContext,
  operation: (session: AgentSession) => Promise<T> | T,
  dependencies: ReviewerSessionFactoryDependencies = defaultReviewerSessionFactoryDependencies,
): Promise<T> {
  return state.lock.runExclusive(async () => {
    const session = await ensureReviewerSessionLocked(state, ctx, dependencies);
    return operation(session);
  });
}

export async function ensureReviewerSession(
  state: ReviewerSessionState,
  ctx: ReviewerSessionFactoryContext,
  dependencies: ReviewerSessionFactoryDependencies = defaultReviewerSessionFactoryDependencies,
) {
  return withReviewerSession(state, ctx, (session) => session, dependencies);
}
