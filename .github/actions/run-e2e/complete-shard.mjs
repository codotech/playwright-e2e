import { readFileSync, writeFileSync } from "node:fs";

const [statusFile, requestedExitCode] = process.argv.slice(2);
const exitCode = Number(requestedExitCode);

if (!Number.isSafeInteger(exitCode) || exitCode < 0) {
  throw new Error(`Invalid Playwright exit code: ${requestedExitCode}`);
}

const status = JSON.parse(readFileSync(statusFile, "utf8"));
const finishedAt = new Date();
const startedAt = new Date(status.startedAt);

status.result = exitCode === 0 ? "passed" : "failed";
status.exitCode = exitCode;
status.finishedAt = finishedAt.toISOString();
status.durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

writeFileSync(statusFile, `${JSON.stringify(status, null, 2)}\n`);
