import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  requestedResultsDirectory,
  requestedExpectedShards,
  runnerDownloadOutcome,
  runnerLoadOutcome,
  runnerVerificationOutcome,
  shardDownloadOutcome,
  mergeOutcome,
  reportPublicationOutcome,
  outputFile,
] = process.argv.slice(2);

const expectedShards = Number(requestedExpectedShards);
if (
  !Number.isSafeInteger(expectedShards) ||
  expectedShards < 1 ||
  expectedShards > 100
) {
  throw new Error("expected-shards must be an integer between 1 and 100");
}
if (!requestedResultsDirectory || isAbsolute(requestedResultsDirectory)) {
  throw new Error("results-directory must be a non-empty repository-relative path");
}

const workspacePath = realpathSync(workspace);
const resultsDirectory = resolve(workspacePath, requestedResultsDirectory);
const relativeResultsDirectory = relative(workspacePath, resultsDirectory);
if (
  relativeResultsDirectory === "" ||
  relativeResultsDirectory === ".." ||
  relativeResultsDirectory.startsWith(`..${sep}`) ||
  isAbsolute(relativeResultsDirectory)
) {
  throw new Error("results-directory must resolve below GITHUB_WORKSPACE");
}
if (
  existsSync(resultsDirectory) &&
  lstatSync(resultsDirectory).isSymbolicLink()
) {
  throw new Error("results-directory must not be a symbolic link");
}
mkdirSync(resultsDirectory, { recursive: true });

const resultFile = resolve(resultsDirectory, "result.json");
let result = null;
if (existsSync(resultFile)) {
  try {
    result = JSON.parse(readFileSync(resultFile, "utf8"));
  } catch {
    result = null;
  }
}
if (!result || typeof result !== "object") {
  result = {
    schemaVersion: 2,
    result: "infrastructure-error",
    primaryFailure: {
      kind: "infrastructure",
      phase: "results-assembly",
      message: "Results assembly did not produce a readable result.json",
    },
    secondaryFailures: [],
    expectedShards,
    observedShards: [],
    summary: {
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      other: 0,
    },
    shards: [],
    reports: {},
    generatedAt: new Date().toISOString(),
  };
}

const checks = [
  ["runner-archive-download", runnerDownloadOutcome],
  ["runner-image-load", runnerLoadOutcome],
  ["runner-image-verification", runnerVerificationOutcome],
  ["shard-results-download", shardDownloadOutcome],
  ["results-merge", mergeOutcome],
  ["report-image-publication", reportPublicationOutcome],
];
const newFailures = checks
  .filter(([, outcome]) => outcome !== "success")
  .map(([phase, outcome]) => ({
    kind: "infrastructure",
    phase,
    message: `${phase} finished with ${outcome || "unknown"}`,
  }));

result.secondaryFailures = Array.isArray(result.secondaryFailures)
  ? result.secondaryFailures
  : [];
if (newFailures.length > 0) {
  if (!result.primaryFailure) {
    result.primaryFailure = newFailures.shift();
  }
  result.secondaryFailures.push(...newFailures);
  if (result.result === "passed" || !result.result) {
    result.result = "infrastructure-error";
  }
}
result.expectedShards = expectedShards;
result.artifacts = {
  ...(result.artifacts ?? {}),
  reportImage:
    reportPublicationOutcome === "success"
      ? { published: true, name: "e2e-report-image" }
      : { published: false, name: null },
};
result.finalizedAt = new Date().toISOString();
writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);

const appendOutput = (name, value) => {
  const escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  writeFileSync(outputFile, `${name}=${escaped}\n`, { flag: "a" });
};
appendOutput("results-directory", resultsDirectory);
appendOutput("result-file", resultFile);
