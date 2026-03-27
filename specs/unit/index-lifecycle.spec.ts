import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { registerReviewerExtension } from "../../src/index.ts";
import { REVIEWER_BRIDGE_TOOL_NAME } from "../../src/reviewer/reviewer-bridge-tool.ts";
import { REVIEWER_GPT_MODEL_ID, REVIEWER_PROVIDER } from "../../src/reviewer/session-factory.ts";

type LifecycleHandler = (event: unknown, ctx: ReturnType<typeof createLifecycleContext>) => Promise<void> | void;

function createLifecycleContext(sessionId: string, sessionFile = `/sessions/${sessionId}.jsonl`) {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionFile: () => sessionFile,
      getSessionId: () => sessionId,
    },
  };
}

function createExtensionApi() {
  const handlers = new Map<string, LifecycleHandler>();
  const registerTool = vi.fn();
  const on = vi.fn((event: string, handler: LifecycleHandler) => {
    handlers.set(event, handler);
  });

  return {
    pi: {
      registerTool,
      on,
    } as unknown as ExtensionAPI,
    handlers,
    registerTool,
    on,
  };
}

function createReviewerSessionDouble() {
  return {
    sessionId: "reviewer-1",
    dispose: vi.fn(),
  };
}

describe("reviewer extension lifecycle wiring", () => {
  it("registers the reviewer bridge and all lifecycle handlers without eager session creation", () => {
    const api = createExtensionApi();

    const runtime = registerReviewerExtension(api.pi);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool.mock.calls[0]?.[0].name).toBe(REVIEWER_BRIDGE_TOOL_NAME);
    expect(api.on).toHaveBeenCalledTimes(4);
    expect([...api.handlers.keys()].sort()).toEqual([
      "session_fork",
      "session_shutdown",
      "session_start",
      "session_switch",
    ]);
    expect(runtime.state.session).toBeUndefined();
    expect(runtime.state.health).toBe("idle");
    expect(runtime.state.usage.createdCount).toBe(0);
  });

  it("claims the active session owner on session_start and ignores repeated initialization for the same owner", async () => {
    const api = createExtensionApi();
    const runtime = registerReviewerExtension(api.pi);
    const sessionStart = api.handlers.get("session_start");
    const ctx = createLifecycleContext("main-1");
    const reviewer = createReviewerSessionDouble();

    expect(sessionStart).toBeTypeOf("function");

    await sessionStart?.({}, ctx);
    runtime.state.session = reviewer as never;
    runtime.state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    runtime.state.health = "ready";

    await sessionStart?.({}, ctx);

    expect(runtime.state.owner).toEqual({
      cwd: "/repo",
      sessionFile: "/sessions/main-1.jsonl",
      sessionId: "main-1",
      stableIdentity: "file:/sessions/main-1.jsonl",
    });
    expect(reviewer.dispose).not.toHaveBeenCalled();
    expect(runtime.state.session).toBe(reviewer);
    expect(runtime.state.usage.resetCount).toBe(0);
  });

  it("resets reviewer state when session_switch moves to a different main session", async () => {
    const api = createExtensionApi();
    const runtime = registerReviewerExtension(api.pi);
    const sessionStart = api.handlers.get("session_start");
    const sessionSwitch = api.handlers.get("session_switch");
    const reviewer = createReviewerSessionDouble();

    await sessionStart?.({}, createLifecycleContext("main-1"));
    runtime.state.session = reviewer as never;
    runtime.state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    runtime.state.health = "ready";

    await sessionSwitch?.({}, createLifecycleContext("main-2"));

    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.state.session).toBeUndefined();
    expect(runtime.state.modelTarget).toBeUndefined();
    expect(runtime.state.health).toBe("idle");
    expect(runtime.state.owner?.stableIdentity).toBe("file:/sessions/main-2.jsonl");
    expect(runtime.state.usage.resetCount).toBe(1);
  });

  it("resets reviewer state when session_fork creates a new owner boundary", async () => {
    const api = createExtensionApi();
    const runtime = registerReviewerExtension(api.pi);
    const sessionStart = api.handlers.get("session_start");
    const sessionFork = api.handlers.get("session_fork");
    const reviewer = createReviewerSessionDouble();

    await sessionStart?.({}, createLifecycleContext("main-1"));
    runtime.state.session = reviewer as never;
    runtime.state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    runtime.state.health = "ready";

    await sessionFork?.({}, createLifecycleContext("fork-1", "/sessions/fork-1.jsonl"));

    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.state.session).toBeUndefined();
    expect(runtime.state.owner?.stableIdentity).toBe("file:/sessions/fork-1.jsonl");
    expect(runtime.state.usage.resetCount).toBe(1);
  });

  it("cleans up reviewer state on session_shutdown and keeps repeated shutdown cleanup safe", async () => {
    const api = createExtensionApi();
    const runtime = registerReviewerExtension(api.pi);
    const sessionStart = api.handlers.get("session_start");
    const sessionShutdown = api.handlers.get("session_shutdown");
    const reviewer = createReviewerSessionDouble();

    await sessionStart?.({}, createLifecycleContext("main-1"));
    runtime.state.session = reviewer as never;
    runtime.state.modelTarget = { provider: REVIEWER_PROVIDER, id: REVIEWER_GPT_MODEL_ID };
    runtime.state.health = "ready";

    await sessionShutdown?.({}, createLifecycleContext("main-1"));
    await sessionShutdown?.({}, createLifecycleContext("main-1"));

    expect(reviewer.dispose).toHaveBeenCalledTimes(1);
    expect(runtime.state.session).toBeUndefined();
    expect(runtime.state.modelTarget).toBeUndefined();
    expect(runtime.state.owner).toBeUndefined();
    expect(runtime.state.health).toBe("disposed");
    expect(runtime.state.usage.resetCount).toBe(1);
    expect(runtime.state.usage.disposeCount).toBe(1);
  });
});
