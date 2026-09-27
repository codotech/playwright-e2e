import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const [evidenceDirectory, requestedExpectedShards, requestedHtmlMergeExitCode] =
  process.argv.slice(2);
const expectedShards = Number(requestedExpectedShards);
const htmlMergeExitCode = Number(requestedHtmlMergeExitCode);
const stagingDirectory = resolve(evidenceDirectory, ".merge-input");
const scanFile = resolve(stagingDirectory, "scan.json");

const infrastructureFailures = [];
let scan = { expectedShards, observedShards: [], statuses: [], errors: [] };
if (!existsSync(scanFile)) {
  infrastructureFailures.push(
    "Shard evidence staging did not produce scan.json",
  );
} else {
  try {
    scan = JSON.parse(readFileSync(scanFile, "utf8"));
    infrastructureFailures.push(...(scan.errors ?? []));
  } catch (error) {
    infrastructureFailures.push(
      `Cannot parse shard evidence scan: ${error.message}`,
    );
  }
}

if (!Number.isSafeInteger(htmlMergeExitCode) || htmlMergeExitCode !== 0) {
  infrastructureFailures.push(
    `Playwright HTML report merge exited with ${requestedHtmlMergeExitCode}`,
  );
}

const summaryKeys = [
  "tests",
  "passed",
  "failed",
  "pending",
  "skipped",
  "other",
];
const summary = Object.fromEntries(summaryKeys.map((key) => [key, 0]));
const combinedTests = [];
const ctrfDirectory = resolve(stagingDirectory, "ctrf");
const ctrfFiles = existsSync(ctrfDirectory)
  ? readdirSync(ctrfDirectory)
      .filter((name) => name.endsWith(".json"))
      .sort()
  : [];
const starts = [];
const stops = [];

if (ctrfFiles.length !== expectedShards) {
  infrastructureFailures.push(
    `Expected ${expectedShards} CTRF reports; found ${ctrfFiles.length}`,
  );
}

for (const fileName of ctrfFiles) {
  try {
    const report = JSON.parse(
      readFileSync(resolve(ctrfDirectory, fileName), "utf8"),
    );
    const reportSummary = report?.results?.summary;
    if (!reportSummary || !Array.isArray(report?.results?.tests)) {
      throw new Error("missing results.summary or results.tests");
    }
    for (const key of summaryKeys) {
      const value = Number(reportSummary[key] ?? 0);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`invalid summary.${key}`);
      }
      summary[key] += value;
    }
    if (Number.isFinite(Number(reportSummary.start)))
      starts.push(Number(reportSummary.start));
    if (Number.isFinite(Number(reportSummary.stop)))
      stops.push(Number(reportSummary.stop));
    combinedTests.push(...report.results.tests);
  } catch (error) {
    infrastructureFailures.push(
      `Cannot aggregate CTRF report ${fileName}: ${error.message}`,
    );
  }
}

if (summary.tests === 0 && combinedTests.length > 0) {
  summary.tests = combinedTests.length;
}
if (summary.tests === 0) {
  infrastructureFailures.push("No Playwright tests were executed");
}
if (starts.length > 0) summary.start = Math.min(...starts);
if (stops.length > 0) summary.stop = Math.max(...stops);

const ctrfReport = {
  reportFormat: "CTRF",
  specVersion: "0.0.0",
  results: {
    tool: { name: "playwright" },
    summary,
    tests: combinedTests,
    environment: {
      reportName: "Merged Playwright E2E",
      expectedShards,
      observedShards: scan.observedShards ?? [],
    },
  },
};
writeFileSync(
  resolve(evidenceDirectory, "ctrf-report.json"),
  `${JSON.stringify(ctrfReport, null, 2)}\n`,
);

const failedShards = (scan.statuses ?? []).filter(
  (status) => status.result === "failed",
);
const infrastructureErrorShards = (scan.statuses ?? []).filter(
  (status) => status.result === "infrastructure-error",
);
const incompleteShards = (scan.statuses ?? []).filter(
  (status) =>
    !["passed", "failed", "infrastructure-error"].includes(status.result),
);
const shardInfrastructureFailures = (scan.statuses ?? []).flatMap((status) =>
  [status.primaryFailure, ...(status.secondaryFailures ?? [])]
    .filter((failure) => failure?.kind === "infrastructure")
    .map(
      (failure) =>
        `Shard ${status.shard.index} ${failure.phase ?? "infrastructure"}: ${failure.message}`,
    ),
);
if (infrastructureErrorShards.length > 0 && shardInfrastructureFailures.length === 0) {
  shardInfrastructureFailures.push(
    ...infrastructureErrorShards.map(
      (status) => `Shard ${status.shard.index} reported an infrastructure error`,
    ),
  );
}
for (const status of incompleteShards) {
  shardInfrastructureFailures.push(
    `Shard ${status.shard.index} did not complete; last state is ${status.result ?? "unknown"}`,
  );
}
infrastructureFailures.unshift(...shardInfrastructureFailures);

const hasTestFailure = failedShards.length > 0 || summary.failed > 0;
let primaryFailure = null;
const secondaryFailures = [];
if (hasTestFailure) {
  primaryFailure = {
    kind: "test",
    message: `${failedShards.length} shard(s) and ${summary.failed} reported test(s) failed`,
  };
  secondaryFailures.push(
    ...infrastructureFailures.map((message) => ({
      kind: "infrastructure",
      message,
    })),
  );
} else if (infrastructureFailures.length > 0) {
  primaryFailure = {
    kind: "infrastructure",
    message: infrastructureFailures[0],
  };
  secondaryFailures.push(
    ...infrastructureFailures
      .slice(1)
      .map((message) => ({ kind: "infrastructure", message })),
  );
}

const verdict = {
  schemaVersion: 1,
  result: hasTestFailure
    ? "failed"
    : infrastructureFailures.length > 0
      ? "infrastructure-error"
      : "passed",
  primaryFailure,
  secondaryFailures,
  expectedShards,
  observedShards: scan.observedShards ?? [],
  summary: {
    total: summary.tests,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    pending: summary.pending,
    other: summary.other,
  },
  shards: scan.statuses ?? [],
  github: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  },
  reports: {
    playwrightHtml: "playwright-report/index.html",
    ctrf: "ctrf-report.json",
    shardStatus: "shard-status/",
  },
  generatedAt: new Date().toISOString(),
};
writeFileSync(
  resolve(evidenceDirectory, "verdict.json"),
  `${JSON.stringify(verdict, null, 2)}\n`,
);

rmSync(stagingDirectory, { recursive: true, force: true });
