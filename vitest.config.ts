import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["specs/unit/**/*.spec.ts"],
  },
});
