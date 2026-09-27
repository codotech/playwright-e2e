import { defineConfig, devices } from "@playwright/test";
import { basename, dirname } from "node:path";

const host = process.env.SUT_HOST ?? "127.0.0.1";
const port = process.env.SUT_PORT ?? "4173";
const localBaseUrl = `http://${host}:${port}`;
const baseURL = process.env.BASE_URL ?? localBaseUrl;
const isCi = Boolean(process.env.CI);
const testResultsDir =
  process.env.E2E_RESULTS_DIR ??
  process.env.PLAYWRIGHT_OUTPUT_DIR ??
  "test-results";
const blobOutputDir = process.env.PLAYWRIGHT_BLOB_OUTPUT_DIR ?? "blob-report";
const ctrfOutputPath = process.env.CTRF_OUTPUT_FILE ?? "ctrf/ctrf-report.json";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 2 : undefined,
  outputDir: testResultsDir,
  reporter: isCi
    ? [
        ["list"],
        ["blob", { outputDir: blobOutputDir }],
        [
          "playwright-ctrf-json-reporter",
          {
            outputDir: dirname(ctrfOutputPath),
            outputFile: basename(ctrfOutputPath),
          },
        ],
      ]
    : [
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "api",
      testMatch: /.*\.api\.spec\.ts/,
    },
    {
      name: "chromium",
      testMatch: /.*\.browser\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: "node ./sut/server.mjs",
        env: {
          SUT_HOST: host,
          SUT_PORT: port,
        },
        url: `${localBaseUrl}/health`,
        reuseExistingServer: !isCi,
        timeout: 30_000,
      },
});
