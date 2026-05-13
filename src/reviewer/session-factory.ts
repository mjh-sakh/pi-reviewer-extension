import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

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
Only use the read-only tools available in this reviewer session.

IMPORTANT: File contents are not preserved across session compactions. Never assume you can recall
file contents from memory. Always use the read tool to re-read files when you need their contents.`;

export const REVIEWER_PROVIDER = "github-copilot";
export const REVIEWER_OPUS_MODEL_ID = "claude-opus-4.7";
export const REVIEWER_GPT_MODEL_ID = "gpt-5.4";
export const REVIEWER_READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

const REVIEWER_DEFAULT_THINKING_LEVEL = "high" as const;
const REVIEWER_FALLBACK_THINKING_LEVEL = "off" as const;

type ReviewerThinkingLevel = typeof REVIEWER_DEFAULT_THINKING_LEVEL | typeof REVIEWER_FALLBACK_THINKING_LEVEL;

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
  createModelRegistry: (authStorage) => ModelRegistry.create(authStorage),
  createResourceLoader: (options) => new DefaultResourceLoader(options),
  createInMemorySessionManager: () => SessionManager.inMemory(),
  createReadOnlyTools: () => [...REVIEWER_READ_ONLY_TOOL_NAMES],
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

export function selectReviewerThinkingLevel(model: unknown): ReviewerThinkingLevel {
  if (!model || typeof model !== "object") {
    return REVIEWER_DEFAULT_THINKING_LEVEL;
  }

  const record = model as {
    reasoning?: unknown;
  };

  return record.reasoning === false ? REVIEWER_FALLBACK_THINKING_LEVEL : REVIEWER_DEFAULT_THINKING_LEVEL;
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
    const reviewerThinkingLevel = selectReviewerThinkingLevel(reviewerModel);
    const result = await dependencies.createAgentSession({
      cwd: ctx.cwd,
      authStorage,
      modelRegistry,
      model: reviewerModel,
      thinkingLevel: reviewerThinkingLevel,
      resourceLoader,
      sessionManager: dependencies.createInMemorySessionManager(),
      tools: dependencies.createReadOnlyTools(ctx.cwd),
    });

    state.session = result.session;
    // Disable SDK auto-compaction: reviewer-maintenance.ts handles compaction
    // exclusively using REVIEWER_STATIC_COMPACTION_INSTRUCTIONS. If SDK auto-compaction
    // runs first (with generic instructions), reviewer-maintenance's subsequent
    // compact() call throws "Already compacted" → erroneously triggers a hard reset,
    // wiping the reviewer's entire context and causing "I wasn't able to retrieve the
    // file contents in this session" errors on the next call.
    state.session.setAutoCompactionEnabled(false);
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
