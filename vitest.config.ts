import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["./test/global-setup.ts"],
    environment: "node",
    // Integration tests spawn child processes; give them room without hiding hangs.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
