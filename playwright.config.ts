import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 150000,
  expect: { timeout: 30000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4310",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node --import tsx server/index.ts",
    url: "http://127.0.0.1:4310/healthz",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      PORT: "4310",
      HOST: "127.0.0.1",
      PUBLIC_URL: "http://127.0.0.1:4310",
      AI_PROVIDER: "demo",
      AWS_MODE: "demo",
      DATA_DIR: `.data/e2e-${Date.now()}`,
      ADMIN_PASSWORD: "test-only-workspace-password",
      SESSION_SECRET: "test-only-secret-must-be-32-characters",
      RUNTIME_DRIVER: "process",
      MAX_ACTIVE_SESSIONS: "4",
      DASHBOARD_REPO_URL: "",
    },
  },
});
