import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "cli/test/**/*.test.ts"],
    environment: "node",
  },
});
