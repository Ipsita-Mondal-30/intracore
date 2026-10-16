import { defineConfig } from "vitest/config";
import { readFileSync } from "fs";
import { parse } from "dotenv";
import path from "path";

// Tests always use .env.test (local Postgres), never .env.
const testEnv = parse(readFileSync(path.resolve(__dirname, ".env.test")));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    env: testEnv,
    setupFiles: ["tests/setup.ts"],
    // DB tests share one database; run files serially to keep fixtures isolated.
    fileParallelism: false,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
