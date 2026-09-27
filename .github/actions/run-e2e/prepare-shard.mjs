import {
  appendFileSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  requestedWorkingDirectory,
  requestedConfig,
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
assertRelative(requestedResultsDirectory, "results-directory");

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

const statusFile = resolve(shardDirectory, "shard-status.json");
const status = {
  schemaVersion: 1,
  shard: { index: shardIndex, total: shardTotal },
  result: "running",
  exitCode: null,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  durationMs: null,
  github: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    sha: process.env.GITHUB_SHA ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    job: process.env.GITHUB_JOB ?? null,
  },
};
writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);

const quoteForShell = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
const variables = {
  E2E_ABSOLUTE_WORKING_DIRECTORY: resolvedWorkingDirectory,
  E2E_ABSOLUTE_CONFIG: configPath,
  E2E_SHARD_DIRECTORY: shardDirectory,
  E2E_STATUS_FILE: statusFile,
};

for (const [name, value] of Object.entries(variables)) {
  process.stdout.write(`${name}=${quoteForShell(value)}\n`);
}
