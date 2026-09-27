import { appendFileSync, readFileSync } from "node:fs";

const [verdictFile, artifactName, publicationOutcome, summaryFile, outputFile] =
  process.argv.slice(2);
const verdict = JSON.parse(readFileSync(verdictFile, "utf8"));
const summary = verdict.summary ?? {};
const enforcedResult =
  verdict.result === "passed" && publicationOutcome !== "success"
    ? "infrastructure-error"
    : verdict.result;
const publicationFailure =
  publicationOutcome === "success"
    ? null
    : `Evidence artifact publication finished with ${publicationOutcome || "unknown"}`;
const primaryFailure = verdict.primaryFailure?.message ?? publicationFailure;

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
    ...(primaryFailure ? ["", `**Primary failure:** ${primaryFailure}`] : []),
    ...(publicationFailure && publicationFailure !== primaryFailure
      ? ["", `**Publication failure:** ${publicationFailure}`]
      : []),
    "",
  ].join("\n"),
);

const appendOutput = (name, value) => {
  const escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  appendFileSync(outputFile, `${name}=${escaped}\n`);
};
appendOutput("verdict", enforcedResult);
appendOutput("total", Number(summary.total ?? 0));
appendOutput("passed", Number(summary.passed ?? 0));
appendOutput("failed", Number(summary.failed ?? 0));
appendOutput("skipped", Number(summary.skipped ?? 0));
appendOutput("primary-failure", primaryFailure ?? "");

if (enforcedResult !== "passed" || publicationOutcome !== "success") {
  console.error(`E2E evidence is not healthy: ${enforcedResult}`);
  if (primaryFailure) console.error(primaryFailure);
  if (publicationFailure && publicationFailure !== primaryFailure) {
    console.error(publicationFailure);
  }
  process.exit(1);
}
