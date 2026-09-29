import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createSelection } from "./playwright-selection.mjs";

const [
  workspace,
  requestedWorkingDirectory,
  requestedConfig,
  requestedComposeFile,
  requestedBaseUrl,
  requestedRunnerImageName,
  requestedRunnerImageId,
  requestedRunnerDownloadOutcome,
  requestedRunnerLoadOutcome,
  requestedProjects,
  requestedLabels,
  requestedLabelMatch,
  requestedShardIndex,
  requestedShardTotal,
  requestedResultsDirectory,
] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(message);
};

const assertRelative = (value, label) => {
  if (!value || isAbsolute(value)) {
    fail(`${label} must be a non-empty relative path`);
  }

  const normalized = resolve("/contract-root", value);
  const relativePath = relative("/contract-root", normalized);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    fail(`${label} must resolve below its parent directory`);
  }
};

assertRelative(requestedWorkingDirectory, "working-directory");
assertRelative(requestedConfig, "playwright-config");
const managesSut = requestedComposeFile !== "";
if (managesSut) assertRelative(requestedComposeFile, "compose-file");
assertRelative(requestedResultsDirectory, "results-directory");

let baseUrl;
try {
  baseUrl = new URL(requestedBaseUrl);
} catch {
  fail(`base-url must be a valid URL: ${requestedBaseUrl}`);
}
if (!["http:", "https:"].includes(baseUrl.protocol)) {
  fail("base-url must use HTTP or HTTPS");
}
if (baseUrl.username || baseUrl.password || baseUrl.hash) {
  fail("base-url must not contain credentials or a fragment");
}
if (!requestedRunnerImageName || /[\s\0]/.test(requestedRunnerImageName)) {
  fail(
    "runner-image-name must be a non-empty Docker reference without whitespace",
  );
}
if (!/^sha256:[a-f0-9]{64}$/.test(requestedRunnerImageId)) {
  fail(
    `runner-image-id must be a sha256 image ID; received ${requestedRunnerImageId}`,
  );
}
const allowedStepOutcomes = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
]);
for (const [label, outcome] of [
  ["runner-download-outcome", requestedRunnerDownloadOutcome],
  ["runner-load-outcome", requestedRunnerLoadOutcome],
]) {
  if (!allowedStepOutcomes.has(outcome)) {
    fail(
      `${label} must be success, failure, cancelled, or skipped; received ${outcome}`,
    );
  }
}
const selection = createSelection(
  requestedProjects,
  requestedLabels,
  requestedLabelMatch,
);

const shardIndex = Number(requestedShardIndex);
const shardTotal = Number(requestedShardTotal);
if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardTotal)) {
  fail("shard-index and shard-total must be integers");
}
if (shardTotal < 1 || shardIndex < 1 || shardIndex > shardTotal) {
  fail(`Invalid shard ${requestedShardIndex}/${requestedShardTotal}`);
}

const workspacePath = realpathSync(workspace);
const workingDirectory = resolve(workspacePath, requestedWorkingDirectory);
if (!existsSync(workingDirectory)) {
  fail(`E2E working directory does not exist: ${requestedWorkingDirectory}`);
}

const resolvedWorkingDirectory = realpathSync(workingDirectory);
const relativeWorkingDirectory = relative(
  workspacePath,
  resolvedWorkingDirectory,
);
if (
  relativeWorkingDirectory.startsWith("..") ||
  isAbsolute(relativeWorkingDirectory)
) {
  fail("working-directory must not escape GITHUB_WORKSPACE");
}

const configPath = resolve(resolvedWorkingDirectory, requestedConfig);
if (!existsSync(configPath)) {
  fail(`Playwright configuration does not exist: ${requestedConfig}`);
}

let resolvedComposeFile = "";
if (managesSut) {
  const composeFile = resolve(workspacePath, requestedComposeFile);
  if (!existsSync(composeFile)) {
    fail(`Docker Compose file does not exist: ${requestedComposeFile}`);
  }
  resolvedComposeFile = realpathSync(composeFile);
  const relativeComposeFile = relative(workspacePath, resolvedComposeFile);
  if (relativeComposeFile.startsWith("..") || isAbsolute(relativeComposeFile)) {
    fail("compose-file must not escape GITHUB_WORKSPACE");
  }
}

const resultsRoot = resolve(
  resolvedWorkingDirectory,
  requestedResultsDirectory,
);
const resultsRelativePath = relative(resolvedWorkingDirectory, resultsRoot);
if (resultsRelativePath.startsWith("..") || isAbsolute(resultsRelativePath)) {
  fail("results-directory must remain inside working-directory");
}

const shardDirectory = resolve(resultsRoot, `shard-${shardIndex}`);
rmSync(shardDirectory, { recursive: true, force: true });
mkdirSync(resolve(shardDirectory, "blob-report"), { recursive: true });
mkdirSync(resolve(shardDirectory, "ctrf"), { recursive: true });
mkdirSync(resolve(shardDirectory, "test-results"), { recursive: true });
const selectionFile = resolve(shardDirectory, "playwright-selection.json");
writeFileSync(selectionFile, `${JSON.stringify(selection, null, 2)}\n`);

const statusFile = resolve(shardDirectory, "shard-status.json");
const status = {
  schemaVersion: 2,
  shard: { index: shardIndex, total: shardTotal },
  result: "running",
  exitCode: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  primaryFailure: null,
  secondaryFailures: [],
  selection: {
    projects: selection.projects,
    labels: selection.labels,
    labelMatch: selection.labelMatch,
    grep: selection.grep,
  },
  lifecycle: {
    runner: {
      imageName: requestedRunnerImageName,
      expectedImageId: requestedRunnerImageId,
      actualImageId: null,
      downloadOutcome: requestedRunnerDownloadOutcome,
      loadOutcome: requestedRunnerLoadOutcome,
      verificationExitCode: null,
    },
    sut: {
      mode: managesSut ? "compose" : "external",
      composeFile: managesSut ? requestedComposeFile : null,
      baseUrl: baseUrl.toString(),
      projectName: null,
      startupExitCode: null,
    },
    playwright: { exitCode: null, started: false },
    results: { logCaptureExitCode: null },
    cleanup: { teardownExitCode: null },
  },
  github: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
  },
};
writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);

const composeProject = managesSut
  ? [
      "e2e",
      process.env.GITHUB_RUN_ID ?? "local",
      process.env.GITHUB_RUN_ATTEMPT ?? "1",
      shardIndex,
    ]
      .join("-")
      .toLowerCase()
      .replaceAll(/[^a-z0-9_-]/g, "-")
  : "";
status.lifecycle.sut.projectName = composeProject || null;
writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);

const quoteForShell = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const variables = {
  E2E_ABSOLUTE_WORKING_DIRECTORY: resolvedWorkingDirectory,
  E2E_ABSOLUTE_CONFIG: configPath,
  E2E_CONTAINER_CONFIG: requestedConfig,
  E2E_ABSOLUTE_COMPOSE_FILE: resolvedComposeFile,
  E2E_BASE_URL: baseUrl.toString(),
  E2E_COMPOSE_PROJECT: composeProject,
  E2E_RUNNER_IMAGE_NAME: requestedRunnerImageName,
  E2E_RUNNER_IMAGE_ID: requestedRunnerImageId,
  E2E_SELECTION_FILE: selectionFile,
  E2E_SHARD_DIRECTORY: shardDirectory,
  E2E_STATUS_FILE: statusFile,
};

for (const [name, value] of Object.entries(variables)) {
  process.stdout.write(`${name}=${quoteForShell(value)}\n`);
}
