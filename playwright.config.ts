import { defineConfig, devices } from "@playwright/test";

const PORT = 5173;
const API = 8787;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  webServer: [
    {
      command: `npx tsx server/index.ts`,
      url: `http://127.0.0.1:${API}/health`,
      reuseExistingServer: true,
      timeout: 60_000,
      env: { ...process.env, API_PORT: String(API) },
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${PORT}`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
