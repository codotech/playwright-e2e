import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [
  statusFile,
  runnerDownloadOutcome,
  runnerLoadOutcome,
  requestedRunnerExitCode,
  actualRunnerImageId,
  requestedPlaywrightExitCode,
  requestedPlaywrightFailureKind,
  outputFile,
] = process.argv.slice(2);
const parseExitCode = (requestedValue, label) => {
  if (requestedValue === "") return null;
  const value = Number(requestedValue);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid ${label} exit code: ${requestedValue}`);
  }
  return value;
};

const runnerExitCode = parseExitCode(
  requestedRunnerExitCode,
  "runner image verification",
);
const playwrightExitCode = parseExitCode(
  requestedPlaywrightExitCode,
  "Playwright",
);

const status = JSON.parse(readFileSync(statusFile, "utf8"));
const finishedAt = new Date();
const startedAt = new Date(status.startedAt);

const failures = [];
const runnerTransportSucceeded =
  runnerDownloadOutcome === "success" && runnerLoadOutcome === "success";
if (runnerDownloadOutcome !== "success") {
  failures.push({
    kind: "infrastructure",
    phase: "runner-image-download",
    message: `E2E runner image download outcome was ${runnerDownloadOutcome}`,
  });
}
if (runnerLoadOutcome !== "success") {
  failures.push({
    kind: "infrastructure",
    phase: "runner-image-load",
    message: `E2E runner image load outcome was ${runnerLoadOutcome}`,
  });
}
if (runnerTransportSucceeded && runnerExitCode === null) {
  failures.push({
    kind: "infrastructure",
    phase: "runner-image",
    message: "E2E runner image verification did not report an exit code",
  });
} else if (runnerTransportSucceeded && runnerExitCode !== 0) {
  failures.push({
    kind: "infrastructure",
    phase: "runner-image",
    message: `E2E runner image verification exited with ${runnerExitCode}`,
  });
}
if (
  runnerTransportSucceeded &&
  runnerExitCode === 0 &&
  playwrightExitCode === null
) {
  failures.push({
    kind: "infrastructure",
    phase: "playwright-execution",
    message: "Playwright execution did not report an exit code",
  });
} else if (
  playwrightExitCode !== null &&
  playwrightExitCode > 0 &&
  requestedPlaywrightFailureKind !== "test"
) {
  failures.push({
    kind: "infrastructure",
    phase:
      requestedPlaywrightFailureKind === "selection"
        ? "playwright-selection"
        : requestedPlaywrightFailureKind === "runtime-environment"
          ? "runtime-environment"
          : "runner-container",
    message:
      requestedPlaywrightFailureKind === "selection"
        ? `Playwright selection preparation exited with ${playwrightExitCode}`
        : requestedPlaywrightFailureKind === "runtime-environment"
          ? "Runtime environment validation failed; the test container was not started"
          : `E2E runner container exited with ${playwrightExitCode}`,
  });
} else if (playwrightExitCode !== null && playwrightExitCode > 0) {
  failures.push({
    kind: "test",
    phase: "playwright",
    message: `Playwright exited with ${playwrightExitCode}`,
  });
}
const testFailure = failures.find((failure) => failure.kind === "test");
const infrastructureFailure = failures.find(
  (failure) => failure.kind === "infrastructure",
);
status.primaryFailure = testFailure ?? infrastructureFailure ?? null;
status.secondaryFailures = failures.filter(
  (failure) => failure !== status.primaryFailure,
);
status.result = testFailure
  ? "failed"
  : infrastructureFailure
    ? "infrastructure-error"
    : "passed";

const exitCodeForFailure = (failure) => {
  switch (failure?.phase) {
    case "playwright":
    case "playwright-selection":
    case "runtime-environment":
    case "runner-container":
      return playwrightExitCode ?? 1;
    case "runner-image":
      return runnerExitCode ?? 1;
    default:
      return failure ? 1 : 0;
  }
};
const effectiveExitCode = exitCodeForFailure(status.primaryFailure);
status.exitCode = effectiveExitCode;
status.lifecycle.runner.verificationExitCode = runnerExitCode;
status.lifecycle.runner.actualImageId = actualRunnerImageId || null;
status.lifecycle.playwright = {
  exitCode: playwrightExitCode,
  started:
    playwrightExitCode !== null &&
    requestedPlaywrightFailureKind !== "runtime-environment",
};
status.finishedAt = finishedAt.toISOString();
status.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);

for (const [name, value] of [
  ["result", status.result],
  ["exit-code", effectiveExitCode],
  ["shard-directory", dirname(statusFile)],
  ["status-file", statusFile],
]) {
  appendFileSync(outputFile, `${name}=${value}\n`);
}

if (status.primaryFailure) {
  console.error(
    `${status.primaryFailure.kind}: ${status.primaryFailure.message}`,
  );
}
for (const failure of status.secondaryFailures) {
  console.error(`additional ${failure.kind}: ${failure.message}`);
}

if (status.result !== "passed") {
  process.exit(effectiveExitCode || 1);
}
