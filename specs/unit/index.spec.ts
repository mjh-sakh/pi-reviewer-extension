import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import reviewerExtension, { REVIEWER_EXTENSION_ID } from "../../src/index.ts";
import { REVIEWER_BRIDGE_TOOL_NAME } from "../../src/reviewer/reviewer-bridge-tool.ts";

describe("reviewer extension bootstrap", () => {
  it("exports a stable extension identity and registers the reviewer bridge tool", () => {
    const pi = {
      registerTool: vi.fn(),
      on: vi.fn(),
    } as unknown as ExtensionAPI;

    expect(REVIEWER_EXTENSION_ID).toBe("pi-reviewer-extension");
    expect(typeof reviewerExtension).toBe("function");

    reviewerExtension(pi);

    expect((pi.registerTool as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const tool = (pi.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(tool.name).toBe(REVIEWER_BRIDGE_TOOL_NAME);
    expect((pi.on as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
