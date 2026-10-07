import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.STUB_PORT ?? 4173);

// Runs against the production build (npm run build) served by e2e/stub/server.mjs.
// The stub keeps one scenario at a time, so tests run serially.
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  webServer: {
    command: "node e2e/stub/server.mjs",
    url: `http://127.0.0.1:${PORT}/__stub/health`,
    reuseExistingServer: false,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
