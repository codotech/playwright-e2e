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
  requestedEvidenceDirectory,
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
if (!requestedEvidenceDirectory || isAbsolute(requestedEvidenceDirectory)) {
  throw new Error("evidence-directory must be a non-empty repository-relative path");
}

const workspacePath = realpathSync(workspace);
const evidenceDirectory = resolve(workspacePath, requestedEvidenceDirectory);
const relativeEvidenceDirectory = relative(workspacePath, evidenceDirectory);
if (
  relativeEvidenceDirectory === "" ||
  relativeEvidenceDirectory === ".." ||
  relativeEvidenceDirectory.startsWith(`..${sep}`) ||
  isAbsolute(relativeEvidenceDirectory)
) {
  throw new Error("evidence-directory must resolve below GITHUB_WORKSPACE");
}
if (
  existsSync(evidenceDirectory) &&
  lstatSync(evidenceDirectory).isSymbolicLink()
) {
  throw new Error("evidence-directory must not be a symbolic link");
}
mkdirSync(evidenceDirectory, { recursive: true });

const verdictFile = resolve(evidenceDirectory, "verdict.json");
let verdict = null;
if (existsSync(verdictFile)) {
  try {
    verdict = JSON.parse(readFileSync(verdictFile, "utf8"));
  } catch {
    verdict = null;
  }
}
if (!verdict || typeof verdict !== "object") {
  verdict = {
    schemaVersion: 1,
    result: "infrastructure-error",
    primaryFailure: {
      kind: "infrastructure",
      phase: "evidence-assembly",
      message: "Evidence assembly did not produce a readable verdict.json",
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
  ["shard-evidence-download", shardDownloadOutcome],
  ["evidence-merge", mergeOutcome],
  ["report-image-publication", reportPublicationOutcome],
];
const newFailures = checks
  .filter(([, outcome]) => outcome !== "success")
  .map(([phase, outcome]) => ({
    kind: "infrastructure",
    phase,
    message: `${phase} finished with ${outcome || "unknown"}`,
  }));

verdict.secondaryFailures = Array.isArray(verdict.secondaryFailures)
  ? verdict.secondaryFailures
  : [];
if (newFailures.length > 0) {
  if (!verdict.primaryFailure) {
    verdict.primaryFailure = newFailures.shift();
  }
  verdict.secondaryFailures.push(...newFailures);
  if (verdict.result === "passed" || !verdict.result) {
    verdict.result = "infrastructure-error";
  }
}
verdict.expectedShards = expectedShards;
verdict.artifacts = {
  ...(verdict.artifacts ?? {}),
  reportImage:
    reportPublicationOutcome === "success"
      ? { published: true, name: "e2e-report-image" }
      : { published: false, name: null },
};
verdict.finalizedAt = new Date().toISOString();
writeFileSync(verdictFile, `${JSON.stringify(verdict, null, 2)}\n`);

const appendOutput = (name, value) => {
  const escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  writeFileSync(outputFile, `${name}=${escaped}\n`, { flag: "a" });
};
appendOutput("evidence-directory", evidenceDirectory);
appendOutput("verdict-file", verdictFile);
