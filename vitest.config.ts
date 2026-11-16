import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["tests/**/*.test.ts", "tests/**/*.spec.ts", "tests/**/*.test.tsx"], coverage: { provider: "v8", reporter: ["text", "lcov", "json-summary"], include: ["server/**/*.ts", "shared/**/*.ts"], exclude: ["shared/core/types.ts", "shared/locales/**"] } } });
