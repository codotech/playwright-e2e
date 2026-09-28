import { appendFileSync, readFileSync } from "node:fs";

const [resultFile, artifactName, publicationOutcome, summaryFile, outputFile] =
  process.argv.slice(2);
const result = JSON.parse(readFileSync(resultFile, "utf8"));
const summary = result.summary ?? {};
const enforcedResult =
  result.result === "passed" && publicationOutcome !== "success"
    ? "infrastructure-error"
    : result.result;
const publicationFailure =
  publicationOutcome === "success"
    ? null
    : `Results artifact publication finished with ${publicationOutcome || "unknown"}`;
const primaryFailure = result.primaryFailure?.message ?? publicationFailure;

appendFileSync(
  summaryFile,
  [
    "## E2E Gate",
    "",
    `**Result:** ${enforcedResult}`,
    "",
    "| Result | Count |",
    "| --- | ---: |",
    `| Total | ${summary.total ?? 0} |`,
    `| Passed | ${summary.passed ?? 0} |`,
    `| Failed | ${summary.failed ?? 0} |`,
    `| Skipped | ${summary.skipped ?? 0} |`,
    "",
    `**Shards:** ${(result.observedShards ?? []).length}/${result.expectedShards ?? 0}`,
    "",
    `**Results artifact:** \`${artifactName}\``,
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
appendOutput("result", enforcedResult);
appendOutput("total", Number(summary.total ?? 0));
appendOutput("passed", Number(summary.passed ?? 0));
appendOutput("failed", Number(summary.failed ?? 0));
appendOutput("skipped", Number(summary.skipped ?? 0));
appendOutput("primary-failure", primaryFailure ?? "");

if (enforcedResult !== "passed" || publicationOutcome !== "success") {
  console.error(`E2E results did not complete successfully: ${enforcedResult}`);
  if (primaryFailure) console.error(primaryFailure);
  if (publicationFailure && publicationFailure !== primaryFailure) {
    console.error(publicationFailure);
  }
  process.exit(1);
}
