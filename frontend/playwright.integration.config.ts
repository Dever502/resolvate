import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.CONSOLE_TEST_PORT ?? 4174);
const python = process.env.CONSOLE_TEST_PYTHON ?? "../.venv/bin/python";

export default defineConfig({
  testDir: "integration",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  outputDir: "test-results/integration",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  webServer: {
    command: `${python} ../scripts/console_integration_server.py`,
    env: { PYTHONPATH: "../src:../tests" },
    url: `http://127.0.0.1:${port}/health/live`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
