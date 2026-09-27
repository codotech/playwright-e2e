import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const [
  evidenceDirectory,
  requestedExpectedShards,
  artifactName,
  publicationOutcome,
  summaryFile,
  outputFile,
] = process.argv.slice(2);
const verdictFile = resolve(evidenceDirectory, "verdict.json");

let verdict;
if (existsSync(verdictFile)) {
  try {
    verdict = JSON.parse(readFileSync(verdictFile, "utf8"));
  } catch (error) {
    verdict = null;
  }
}

if (!verdict) {
  verdict = {
    schemaVersion: 1,
    result: "infrastructure-error",
    primaryFailure: {
      kind: "infrastructure",
      message: "Evidence assembly did not produce a readable verdict.json",
    },
    secondaryFailures: [],
    expectedShards: Number(requestedExpectedShards),
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

let enforcedResult = verdict.result;
let enforcedPrimaryFailure = verdict.primaryFailure ?? null;
if (publicationOutcome !== "success") {
  const publicationFailure = {
    kind: "infrastructure",
    message: `Evidence artifact publication finished with ${publicationOutcome || "unknown"}`,
  };
  if (!enforcedPrimaryFailure) enforcedPrimaryFailure = publicationFailure;
  if (enforcedResult === "passed") enforcedResult = "infrastructure-error";
}

const summary = verdict.summary ?? {};
appendFileSync(
  summaryFile,
  [
    "## E2E Gate",
    "",
    `**Verdict:** ${enforcedResult}`,
    "",
    "| Result | Count |",
    "| --- | ---: |",
    `| Total | ${summary.total ?? 0} |`,
    `| Passed | ${summary.passed ?? 0} |`,
    `| Failed | ${summary.failed ?? 0} |`,
    `| Skipped | ${summary.skipped ?? 0} |`,
    "",
    `**Shards:** ${(verdict.observedShards ?? []).length}/${verdict.expectedShards ?? 0}`,
    "",
    `**Evidence artifact:** \`${artifactName}\``,
    ...(enforcedPrimaryFailure
      ? ["", `**Primary failure:** ${enforcedPrimaryFailure.message}`]
      : []),
    "",
  ].join("\n"),
);

const appendOutput = (name, value) => {
  appendFileSync(outputFile, `${name}=${value}\n`);
};
appendOutput("verdict", enforcedResult);
appendOutput("total", Number(summary.total ?? 0));
appendOutput("passed", Number(summary.passed ?? 0));
appendOutput("failed", Number(summary.failed ?? 0));
appendOutput("skipped", Number(summary.skipped ?? 0));
appendOutput("verdict-file", verdictFile);

if (enforcedResult !== "passed" || publicationOutcome !== "success") {
  console.error(`E2E evidence is not healthy: ${enforcedResult}`);
  if (enforcedPrimaryFailure) console.error(enforcedPrimaryFailure.message);
  process.exit(1);
}
