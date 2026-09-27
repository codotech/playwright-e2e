import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const [
  workspace,
  requestedVerdictFile,
  shardJobResult,
  mergeJobResult,
  publicationResult,
  summaryFile,
  outputFile,
] = process.argv.slice(2);

const workspacePath = realpathSync(workspace);
const verdictFile = isAbsolute(requestedVerdictFile)
  ? requestedVerdictFile
  : resolve(workspacePath, requestedVerdictFile);
const verdictRelativePath = relative(workspacePath, verdictFile);

const orchestrationFailures = [];
if (
  verdictRelativePath === ".." ||
  verdictRelativePath.startsWith(
    `..${process.platform === "win32" ? "\\" : "/"}`,
  ) ||
  isAbsolute(verdictRelativePath)
) {
  orchestrationFailures.push("verdict-file must be inside GITHUB_WORKSPACE");
}

let verdict = null;
if (orchestrationFailures.length === 0 && existsSync(verdictFile)) {
  try {
    verdict = JSON.parse(readFileSync(verdictFile, "utf8"));
  } catch (error) {
    orchestrationFailures.push(`Cannot parse verdict.json: ${error.message}`);
  }
} else if (orchestrationFailures.length === 0) {
  orchestrationFailures.push(`Missing verdict.json at ${verdictRelativePath}`);
}

const upstreamResults = [
  ["Shard job", shardJobResult],
  ["Merge job", mergeJobResult],
  ["Publication", publicationResult],
];
for (const [label, result] of upstreamResults) {
  if (result !== "success") {
    orchestrationFailures.push(`${label} finished with ${result || "unknown"}`);
  }
}

let primaryFailure = verdict?.primaryFailure ?? null;
const secondaryFailures = [...(verdict?.secondaryFailures ?? [])];
for (const message of orchestrationFailures) {
  const failure = { kind: "infrastructure", message };
  if (!primaryFailure) primaryFailure = failure;
  else if (!secondaryFailures.some((entry) => entry.message === message))
    secondaryFailures.push(failure);
}

const recordedResult = verdict?.result ?? "infrastructure-error";
const finalResult =
  recordedResult === "failed"
    ? "failed"
    : recordedResult !== "passed" || orchestrationFailures.length > 0
      ? "infrastructure-error"
      : "passed";
const primaryMessage = primaryFailure?.message ?? "";

appendFileSync(
  summaryFile,
  [
    "## Final E2E Gate",
    "",
    `**Verdict:** ${finalResult}`,
    "",
    `- Shard job: ${shardJobResult}`,
    `- Merge job: ${mergeJobResult}`,
    `- Publication: ${publicationResult}`,
    ...(primaryMessage ? ["", `**Primary failure:** ${primaryMessage}`] : []),
    ...(secondaryFailures.length > 0
      ? [
          "",
          "**Additional failures:**",
          ...secondaryFailures.map((failure) => `- ${failure.message}`),
        ]
      : []),
    "",
  ].join("\n"),
);

const escapeOutput = (value) =>
  String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
appendFileSync(outputFile, `verdict=${finalResult}\n`);
appendFileSync(outputFile, `primary-failure=${escapeOutput(primaryMessage)}\n`);

if (finalResult !== "passed") {
  console.error(`Final E2E verdict: ${finalResult}`);
  if (primaryMessage) console.error(`Primary failure: ${primaryMessage}`);
  for (const failure of secondaryFailures)
    console.error(`Additional failure: ${failure.message}`);
  process.exit(1);
}
