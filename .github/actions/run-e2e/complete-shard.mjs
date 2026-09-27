import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const [
  statusFile,
  requestedStartupExitCode,
  requestedPlaywrightExitCode,
  requestedPlaywrightFailureKind,
  requestedLogExitCode,
  requestedTeardownExitCode,
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

const startupExitCode = parseExitCode(
  requestedStartupExitCode,
  "startup",
);
const playwrightExitCode = parseExitCode(
  requestedPlaywrightExitCode,
  "Playwright",
);
const logExitCode = parseExitCode(requestedLogExitCode, "log capture");
const teardownExitCode = parseExitCode(
  requestedTeardownExitCode,
  "teardown",
);

const status = JSON.parse(readFileSync(statusFile, "utf8"));
const finishedAt = new Date();
const startedAt = new Date(status.startedAt);

const failures = [];
if (startupExitCode === null) {
  failures.push({
    kind: "infrastructure",
    phase: "sut-startup",
    message: "Dockerized SUT startup did not report an exit code",
  });
} else if (startupExitCode !== 0) {
  failures.push({
    kind: "infrastructure",
    phase: "sut-startup",
    message: `Dockerized SUT startup exited with ${startupExitCode}`,
  });
}
if (startupExitCode === 0 && playwrightExitCode === null) {
  failures.push({
    kind: "infrastructure",
    phase: "playwright-execution",
    message: "Playwright execution did not report an exit code",
  });
} else if (
  playwrightExitCode !== null &&
  playwrightExitCode > 0 &&
  requestedPlaywrightFailureKind === "infrastructure"
) {
  failures.push({
    kind: "infrastructure",
    phase: "playwright-selection",
    message: `Playwright selection preparation exited with ${playwrightExitCode}`,
  });
} else if (playwrightExitCode !== null && playwrightExitCode > 0) {
  failures.push({
    kind: "test",
    phase: "playwright",
    message: `Playwright exited with ${playwrightExitCode}`,
  });
}
if (logExitCode === null) {
  failures.push({
    kind: "infrastructure",
    phase: "evidence",
    message: "Docker Compose log capture did not report an exit code",
  });
} else if (logExitCode !== 0) {
  failures.push({
    kind: "infrastructure",
    phase: "evidence",
    message: `Docker Compose log capture exited with ${logExitCode}`,
  });
}
if (teardownExitCode === null) {
  failures.push({
    kind: "infrastructure",
    phase: "cleanup",
    message: "Docker Compose teardown did not report an exit code",
  });
} else if (teardownExitCode !== 0) {
  failures.push({
    kind: "infrastructure",
    phase: "cleanup",
    message: `Docker Compose teardown exited with ${teardownExitCode}`,
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

const effectiveExitCode = !status.primaryFailure
  ? 0
  : status.primaryFailure.phase === "playwright"
    ? (playwrightExitCode ?? 1)
    : startupExitCode !== null && startupExitCode !== 0
      ? startupExitCode
      : logExitCode !== null && logExitCode !== 0
        ? logExitCode
        : teardownExitCode !== null && teardownExitCode !== 0
          ? teardownExitCode
          : 1;
status.exitCode = effectiveExitCode;
status.lifecycle.sut.startupExitCode = startupExitCode;
status.lifecycle.playwright = {
  exitCode: playwrightExitCode,
  started: playwrightExitCode !== null,
};
status.lifecycle.evidence.logCaptureExitCode = logExitCode;
status.lifecycle.cleanup.teardownExitCode = teardownExitCode;
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
  console.error(`${status.primaryFailure.kind}: ${status.primaryFailure.message}`);
}
for (const failure of status.secondaryFailures) {
  console.error(`additional ${failure.kind}: ${failure.message}`);
}

if (status.result !== "passed") {
  process.exit(effectiveExitCode || 1);
}
