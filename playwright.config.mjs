import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests",
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:4173/",
    ...devices["iPhone 13"],
    browserName: "chromium",
    // Service workers would hide API calls from route mocks; the offline test turns them back on.
    serviceWorkers: "block",
  },
  webServer: { command: "node tests/server.mjs", url: "http://localhost:4173/", reuseExistingServer: !process.env.CI },
});
