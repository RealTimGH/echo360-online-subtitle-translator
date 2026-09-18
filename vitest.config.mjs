import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Extension-only: tests live under tests/ and load extension/*.js via evalModule().
    include: ["tests/unit/**/*.test.js", "tests/property/**/*.test.js"],
    globals: true,
    // Property tests re-evaluate extension modules on hundreds of fast-check
    // runs and can take several seconds under CPU contention.
    testTimeout: 20000,
    coverage: {
      // IIFE modules are instrumented by tests/helpers/load-module.js because
      // native V8 coverage cannot attribute new Function() code reliably.
      provider: "istanbul",
      reporter: ["text", "html"],
      include: ["extension/**/*.js"],
      exclude: ["extension/icons/**"],
      thresholds: {
        statements: 65,
        branches: 50,
        functions: 65,
        lines: 65,
      },
    },
  },
});
