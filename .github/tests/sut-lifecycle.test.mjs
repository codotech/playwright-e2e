import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  readdirSync,
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

function workspace(t) {
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
execution:
  shards: 1
  artifactRetentionDays: 10
profiles:
  pull-request:
    projects: [api]
    labels: []
    labelMatch: all
`,
  );
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

function prepare(directory, baseUrl = "https://staging.example.com/api") {
  return run(process.execPath, [
    join(root, ".github/actions/run-e2e/prepare-shard.mjs"),
    directory,
    "e2e",
    "playwright.config.ts",
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
    playwright: "0",
    kind: "test",
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
    codes.playwright,
    codes.kind,
    join(directory, "output"),
  ]);
  return { ...result, report: JSON.parse(readFileSync(statusFile, "utf8")) };
}

test("Planning needs only a base URL, and changing it preserves the runner identity", (t) => {
  const directory = workspace(t);
  const remote = plan(directory);
  assert.equal(remote.status, 0, remote.stderr);
  const remoteOutput = readFileSync(join(directory, "plan-output"), "utf8");
  assert.doesNotMatch(remoteOutput, /compose/i);
  assert.match(remoteOutput, /^base-url=https:\/\/staging.example.com\/api$/m);

  const config = join(directory, "e2e/ci.yml");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      "https://staging.example.com/api",
      "http://127.0.0.1:4173",
    ),
  );
  const managed = plan(directory);
  assert.equal(managed.status, 0, managed.stderr);
  const hashes = readFileSync(join(directory, "plan-output"), "utf8").match(
    /^runner-content-hash=.+$/gm,
  );
  assert.equal(
    hashes[0],
    hashes[1],
    "Changing the target must not rebuild the test runner",
  );
});

for (const value of [
  "compose.e2e.yml",
  "missing.yml",
  "../outside.yml",
  "/tmp/outside.yml",
  "''",
  "null",
]) {
  test(`Reject the removed composeFile option even when set to ${value}`, (t) => {
    const directory = workspace(t);
    writeFileSync(join(directory, "compose.e2e.yml"), "services: {}\n");
    const config = join(directory, "e2e/ci.yml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "sut:\n",
        `sut:\n  composeFile: ${value}\n`,
      ),
    );
    const result = plan(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /sut contains unknown keys: composeFile/);
  });
}

test("Shard metadata records only the target URL and runner-owned lifecycle", (t) => {
  const directory = workspace(t);
  const prepared = prepare(directory);
  assert.equal(prepared.status, 0, prepared.stderr);
  assert.doesNotMatch(prepared.stdout, /COMPOSE|STARTUP|TEARDOWN/);
  const completed = finish(directory);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.report.result, "passed");
  assert.deepEqual(completed.report.lifecycle.sut, {
    baseUrl: "https://staging.example.com/api",
  });
  assert.deepEqual(Object.keys(completed.report.lifecycle), [
    "runner",
    "sut",
    "playwright",
  ]);
  assert.deepEqual(completed.report.lifecycle.playwright, {
    exitCode: 0,
    started: true,
  });
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
  [
    "missing image verification",
    { runner: "", playwright: "" },
    "infrastructure-error",
    "runner-image",
  ],
  [
    "load failure",
    { load: "failure", runner: "", playwright: "" },
    "infrastructure-error",
    "runner-image-load",
  ],
  [
    "selection failure",
    { playwright: "2", kind: "selection" },
    "infrastructure-error",
    "playwright-selection",
  ],
]) {
  test(`Preserve ${name} without managing the target`, (t) => {
    const directory = workspace(t);
    assert.equal(prepare(directory).status, 0);
    const completed = finish(directory, overrides);
    assert.notEqual(completed.status, 0);
    assert.equal(completed.report.result, result);
    assert.equal(completed.report.primaryFailure.phase, phase);
    assert.equal(completed.report.secondaryFailures.length, 0);
  });
}

for (const baseUrl of [
  "",
  "not-a-url",
  "ftp://example.com",
  "https://user:secret@example.com",
  "https://example.com/#fragment",
]) {
  test(`Reject a missing, invalid, or unsafe target URL: ${baseUrl}`, (t) => {
    const directory = workspace(t);
    assert.notEqual(prepare(directory, baseUrl).status, 0);
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

for (const baseUrl of [
  "http://127.0.0.1:4173",
  "https://staging.example.com/api",
]) {
  test(`Accept a caller-managed target at ${baseUrl}`, (t) => {
    const directory = workspace(t);
    assert.equal(prepare(directory, baseUrl).status, 0);
    const config = join(directory, "e2e/ci.yml");
    writeFileSync(
      config,
      readFileSync(config, "utf8").replace(
        "https://staging.example.com/api",
        baseUrl,
      ),
    );
    const planned = plan(directory);
    assert.equal(planned.status, 0, planned.stderr);
  });
}

test("The action has no SUT lifecycle options or steps and still runs Playwright", () => {
  const parsed = run("ruby", [
    "-ryaml",
    "-rjson",
    "-e",
    "puts JSON.generate(YAML.load_file(ARGV[0]))",
    join(root, ".github/actions/run-e2e/action.yml"),
  ]);
  assert.equal(parsed.status, 0, parsed.stderr);
  const action = JSON.parse(parsed.stdout);
  assert.equal(action.inputs["compose-file"], undefined);
  assert.equal(action.inputs["base-url"].required, true);
  assert.equal(action.inputs["base-url"].default, undefined);
  assert.deepEqual(
    action.runs.steps.map((step) => step.id),
    ["initialize", "runner", "playwright", "finalize"],
  );
  const enabled = (runnerCode) => {
    const condition = action.runs.steps
      .find((step) => step.id === "playwright")
      .if.replaceAll("steps.initialize.outcome", '"success"')
      .replaceAll("steps.runner.outputs.exit-code", JSON.stringify(runnerCode));
    return Function(`return (${condition});`)();
  };
  assert.equal(enabled("0"), true);
  assert.equal(enabled("42"), false);
  const runtimeFiles = readdirSync(join(root, ".github/actions"), {
    recursive: true,
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  runtimeFiles.push(join(root, "action.yml"));
  for (const path of runtimeFiles) {
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      /compose|sut-startup|startupExitCode|teardownExitCode/i,
      path,
    );
  }
});
