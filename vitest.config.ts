import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, env: { NATALIS_PUBLIC_IP_LOOKUP: "off" } },
});
