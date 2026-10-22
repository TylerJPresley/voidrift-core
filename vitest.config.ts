import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./src/test-hermetic.ts"],
    globalSetup: ["./src/test-hermetic.global.ts"],
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/test-hermetic.global.ts",
        "src/test-hermetic.ts",
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        "src/**/index.ts",
        "src/entities/ports/**",
        "src/entities/approvals.ts",
      ],
      // Floors from AGENTS.md: >=80% per package overall.
      // Per-layer floors (90% entities/use-cases, 70% adapters) are enforced
      // in review against the layer coverage breakdown.
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
