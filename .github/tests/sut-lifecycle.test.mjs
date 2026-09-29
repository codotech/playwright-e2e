import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const imageId = `sha256:${"a".repeat(64)}`;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  assert.ifError(result.error);
  return result;
}

function workspace(t, compose = false) {
  const directory = mkdtempSync(join(tmpdir(), "playwright-sut-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "e2e"));
  writeFileSync(join(directory, "e2e/Dockerfile"), "FROM scratch\n");
  writeFileSync(
    join(directory, "e2e/playwright.config.ts"),
    "export default {};\n",
  );
  writeFileSync(
    join(directory, "e2e/ci.yml"),
    `version: 1
runner:
  dockerfile: Dockerfile
playwright:
  config: playwright.config.ts
sut:
  baseUrl: https://staging.example.com/api
${compose ? "  composeFile: compose.e2e.yml\n" : ""}execution:
  shards: 1
  artifactRetentionDays: 10
profiles:
  pull-request:
    projects: [api]
    labels: []
    labelMatch: all
`,
  );
  if (compose)
    writeFileSync(join(directory, "compose.e2e.yml"), "services: {}\n");
  assert.equal(run("git", ["init", "--quiet", directory]).status, 0);
  return directory;
}

function plan(directory) {
  return run("ruby", [
    join(root, ".github/actions/plan-e2e/plan.rb"),
    directory,
    "pull-request",
    "",
    "",
    "",
    join(directory, "plan-output"),
  ]);
}

function prepare(
  directory,
  compose = "",
  baseUrl = "https://staging.example.com/api",
) {
  return run(process.execPath, [
    join(root, ".github/actions/run-e2e/prepare-shard.mjs"),
    directory,
    "e2e",
    "playwright.config.ts",
    compose,
    baseUrl,
    "playwright-e2e-runner:test",
    imageId,
    "success",
    "success",
    "api",
    "",
    "all",
    "1",
    "1",
    "test-results",
  ]);
}

function finish(directory, overrides = {}) {
  const codes = {
    download: "success",
    load: "success",
    runner: "0",
    startup: "",
    playwright: "0",
    kind: "test",
    logs: "",
    teardown: "",
    ...overrides,
  };
  const statusFile = join(
    directory,
    "e2e/test-results/shard-1/shard-status.json",
  );
  const result = run(process.execPath, [
    join(root, ".github/actions/run-e2e/complete-shard.mjs"),
    statusFile,
    codes.download,
    codes.load,
    codes.runner,
    imageId,
    codes.startup,
    codes.playwright,
    codes.kind,
    codes.logs,
    codes.teardown,
    join(directory, "output"),
  ]);
  return { ...result, report: JSON.parse(readFileSync(statusFile, "utf8")) };
}

test("URL-only planning succeeds without a Compose file and preserves the runner identity", (t) => {
  const directory = workspace(t);
  const remote = plan(directory);
  assert.equal(remote.status, 0, remote.stderr);
  const remoteOutput = readFileSync(join(directory, "plan-output"), "utf8");
  assert.match(remoteOutput, /^compose-file=$/m);
  assert.match(remoteOutput, /^base-url=https:\/\/staging.example.com\/api$/m);

  const config = join(directory, "e2e/ci.yml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "sut:\n",
      "sut:\n  composeFile: compose.e2e.yml\n",
    ),
  );
  writeFileSync(join(directory, "compose.e2e.yml"), "services: {}\n");
  const managed = plan(directory);
  assert.equal(managed.status, 0, managed.stderr);
  const hashes = readFileSync(join(directory, "plan-output"), "utf8").match(
    /^runner-content-hash=.+$/gm,
  );
  assert.equal(
    hashes[0],
    hashes[1],
    "Changing SUT ownership must not rebuild the test runner",
  );
});

for (const value of [
  "missing.yml",
  "../outside.yml",
  "/tmp/outside.yml",
  "''",
  "null",
]) {
  test(`Reject an explicitly invalid Compose configuration: ${value}`, (t) => {
    const directory = workspace(t);
    const config = join(directory, "e2e/ci.yml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "sut:\n",
        `sut:\n  composeFile: ${value}\n`,
      ),
    );
    assert.notEqual(plan(directory).status, 0);
  });
}

test("External shard metadata records no Compose ownership", (t) => {
  const directory = workspace(t);
  const prepared = prepare(directory);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.match(prepared.stdout, /E2E_ABSOLUTE_COMPOSE_FILE=''/);
  assert.match(prepared.stdout, /E2E_COMPOSE_PROJECT=''/);
  const completed = finish(directory);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.report.result, "passed");
  assert.deepEqual(completed.report.lifecycle.sut, {
    mode: "external",
    composeFile: null,
    baseUrl: "https://staging.example.com/api",
    projectName: null,
    startupExitCode: null,
  });
  assert.equal(completed.report.lifecycle.results.logCaptureExitCode, null);
  assert.equal(completed.report.lifecycle.cleanup.teardownExitCode, null);
});

for (const [name, overrides, result, phase] of [
  ["test failure", { playwright: "1" }, "failed", "playwright"],
  [
    "missing test execution",
    { playwright: "" },
    "infrastructure-error",
    "playwright-execution",
  ],
  [
    "image failure",
    { runner: "42", playwright: "" },
    "infrastructure-error",
    "runner-image",
  ],
  [
    "download failure",
    { download: "failure", runner: "", playwright: "" },
    "infrastructure-error",
    "runner-image-download",
  ],
  [
    "container failure",
    { playwright: "125", kind: "runner-container" },
    "infrastructure-error",
    "runner-container",
  ],
]) {
  test(`External mode preserves ${name}`, (t) => {
    const directory = workspace(t);
    assert.equal(prepare(directory).status, 0);
    const completed = finish(directory, overrides);
    assert.notEqual(completed.status, 0);
    assert.equal(completed.report.result, result);
    assert.equal(completed.report.primaryFailure.phase, phase);
  });
}

for (const [name, overrides, result, phase] of [
  ["success", {}, "passed", undefined],
  [
    "missing startup",
    { startup: "", playwright: "" },
    "infrastructure-error",
    "sut-startup",
  ],
  [
    "failed startup",
    { startup: "1", playwright: "" },
    "infrastructure-error",
    "sut-startup",
  ],
  ["missing logs", { logs: "" }, "infrastructure-error", "results"],
  ["failed teardown", { teardown: "1" }, "infrastructure-error", "cleanup"],
  [
    "test failure before cleanup failure",
    { playwright: "1", teardown: "1" },
    "failed",
    "playwright",
  ],
]) {
  test(`Compose mode preserves ${name}`, (t) => {
    const directory = workspace(t, true);
    assert.equal(prepare(directory, "compose.e2e.yml").status, 0);
    const completed = finish(directory, {
      startup: "0",
      logs: "0",
      teardown: "0",
      ...overrides,
    });
    assert.equal(completed.report.result, result);
    assert.equal(completed.report.primaryFailure?.phase, phase);
    assert.equal(completed.status === 0, result === "passed");
    assert.equal(completed.report.lifecycle.sut.mode, "compose");
  });
}

for (const baseUrl of [
  "ftp://example.com",
  "https://user:secret@example.com",
  "https://example.com/#fragment",
]) {
  test(`Reject an unsafe target URL: ${new URL(baseUrl).protocol} ${new URL(baseUrl).hostname}`, (t) => {
    const directory = workspace(t);
    assert.notEqual(prepare(directory, "", baseUrl).status, 0);
    const config = join(directory, "e2e/ci.yml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "https://staging.example.com/api",
        baseUrl,
      ),
    );
    assert.notEqual(plan(directory).status, 0);
  });
}

test("Compose paths cannot escape through symlinks", (t) => {
  const directory = workspace(t);
  const outside = mkdtempSync(join(tmpdir(), "playwright-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "compose.yml"), "services: {}\n");
  symlinkSync(join(outside, "compose.yml"), join(directory, "compose.e2e.yml"));
  assert.notEqual(prepare(directory, "compose.e2e.yml").status, 0);
  const config = join(directory, "e2e/ci.yml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "sut:\n",
      "sut:\n  composeFile: compose.e2e.yml\n",
    ),
  );
  assert.notEqual(plan(directory).status, 0);
});

test("The action skips every Compose step for a URL-only SUT but still executes Playwright", () => {
  const parsed = run("ruby", [
    "-ryaml",
    "-rjson",
    "-e",
    "puts JSON.generate(YAML.load_file(ARGV[0]))",
    join(root, ".github/actions/run-e2e/action.yml"),
  ]);
  assert.equal(parsed.status, 0, parsed.stderr);
  const action = JSON.parse(parsed.stdout);
  assert.equal(action.inputs["compose-file"].default, "");
  const enabled = (id, compose, startup = "") => {
    const condition = action.runs.steps
      .find((step) => step.id === id)
      .if.replaceAll("always()", "true")
      .replaceAll("steps.initialize.outcome", '"success"')
      .replaceAll("steps.runner.outputs.exit-code", '"0"')
      .replaceAll("steps.start.outputs.exit-code", JSON.stringify(startup))
      .replaceAll("inputs.compose-file", JSON.stringify(compose));
    return Function(`return (${condition});`)();
  };
  for (const id of ["start", "logs", "teardown"]) {
    assert.equal(
      enabled(id, ""),
      false,
      `${id} must never touch an external SUT`,
    );
    assert.equal(enabled(id, "compose.e2e.yml"), true);
  }
  assert.equal(enabled("playwright", ""), true);
  assert.equal(enabled("playwright", "compose.e2e.yml", "0"), true);
  assert.equal(enabled("playwright", "compose.e2e.yml", "1"), false);
});
