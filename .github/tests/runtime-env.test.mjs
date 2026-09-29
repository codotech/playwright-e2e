import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const actionPath = join(root, ".github/actions/run-e2e");
const secret = "fake-secret spaces 'quotes' $dollar;=\nsecond line";
const imageId = `sha256:${"a".repeat(64)}`;

function parseYaml(path) {
  const result = spawnSync(
    "ruby",
    [
      "-ryaml",
      "-rjson",
      "-e",
      "puts JSON.generate(YAML.load_file(ARGV[0]))",
      path,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const rootAction = parseYaml(join(root, "action.yml"));
const runAction = parseYaml(join(actionPath, "action.yml"));
const runStep = runAction.runs.steps.find((step) => step.id === "playwright");

function validate(input, env = {}) {
  return spawnSync(process.execPath, [join(actionPath, "runtime-env.mjs")], {
    encoding: "utf8",
    env: { E2E_RUNTIME_ENV: input, ...env },
  });
}

test("Root action forwards the optional name allowlist only to the run subaction", () => {
  for (const action of [rootAction, runAction]) {
    assert.equal(action.inputs["runtime-env"].default, "");
    assert.equal(action.inputs["runtime-env"].required, false);
  }
  const consumers = rootAction.runs.steps.filter(
    (step) => step.with?.["runtime-env"],
  );
  assert.deepEqual(
    consumers.map((step) => step.id),
    ["run"],
  );
  assert.equal(consumers[0].with["runtime-env"], "${{ inputs.runtime-env }}");
  assert.equal(runStep.env.E2E_RUNTIME_ENV, "${{ inputs.runtime-env }}");
});

test("Empty input preserves the existing environment and no forwarding arguments", () => {
  const result = validate("\n \r\n");
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Whitespace and duplicate names normalize without serializing opaque values", () => {
  const result = validate(
    " STAGING_API_TOKEN\r\n\nother_2 \nSTAGING_API_TOKEN",
    {
      STAGING_API_TOKEN: secret,
      other_2: "0",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "STAGING_API_TOKEN\nother_2\n");
  assert.equal(result.stderr, "");
  assert.ok(!result.stdout.includes(secret));
});

for (const [label, input, env] of [
  ["assignment", `TOKEN=${secret}`, {}],
  ["comma-delimited names", "FIRST,SECOND", {}],
  ["shell expansion", "$(printf secret)", {}],
  ["invalid identifier", "1TOKEN", {}],
  ["hyphen", "TOKEN-KEY", {}],
  ["missing value", "TOKEN", {}],
  ["empty value", "TOKEN", { TOKEN: "" }],
  ["late invalid name", `TOKEN\nBAD=${secret}`, { TOKEN: secret }],
]) {
  test(`Reject ${label} without outputting any names, raw input, or secret values`, () => {
    const result = validate(input, env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes(secret));
    assert.ok(!result.stderr.includes(input));
  });
}

for (const name of [
  "BASE_URL",
  "CI",
  "HOME",
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "E2E_CONFIG",
  "PLAYWRIGHT_OUTPUT_DIR",
  "CTRF_OUTPUT_FILE",
  "GITHUB_TOKEN",
  "RUNNER_TEMP",
  "INPUT_TOKEN",
  "DOCKER_HOST",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
]) {
  test(`Reject reserved ${name} without exposing its value`, () => {
    // Loader variables take effect before Node can validate the requested name.
    const env = /^(NODE_OPTIONS|LD_|DYLD_)/.test(name)
      ? {}
      : { [name]: secret };
    const result = validate(name, env);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /reserved/);
    assert.ok(!result.stderr.includes(secret));
  });
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), "playwright-runtime-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shard = join(directory, "shard");
  mkdirSync(shard);
  mkdirSync(join(directory, "bin"));
  writeFileSync(
    join(directory, "selection.json"),
    JSON.stringify({
      projects: ["api"],
      labels: [],
      labelMatch: "all",
      grep: null,
    }),
  );
  writeFileSync(
    join(directory, "bin/docker"),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const forwarded = args.filter((value, index) => args[index - 1] === '--env' && !value.includes('='));
fs.writeFileSync(process.env.DOCKER_CAPTURE, JSON.stringify({ args, forwarded, tokenMatches: process.env.STAGING_API_TOKEN === process.env.EXPECTED_TOKEN }));
`,
    { mode: 0o755 },
  );
  return { directory, shard };
}

function runShell(t, input, token = secret) {
  const { directory, shard } = workspace(t);
  const output = join(directory, "output");
  const capture = join(directory, "docker.json");
  const result = spawnSync("bash", ["-c", runStep.run], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(directory, "bin")}:${process.env.PATH}`,
      GITHUB_ACTION_PATH: actionPath,
      GITHUB_OUTPUT: output,
      E2E_RUNTIME_ENV: input,
      E2E_SHARD_DIRECTORY: shard,
      E2E_SELECTION_FILE: join(directory, "selection.json"),
      E2E_BASE_URL: "https://staging.example.com",
      E2E_CONFIG: "/e2e/playwright.config.ts",
      E2E_RUNNER_IMAGE_ID: imageId,
      E2E_SHARD_INDEX: "1",
      E2E_SHARD_TOTAL: "1",
      STAGING_API_TOKEN: token,
      UNLISTED_TOKEN: "must-not-forward",
      EXPECTED_TOKEN: token,
      DOCKER_CAPTURE: capture,
    },
  });
  return {
    ...result,
    directory,
    shard,
    output: readFileSync(output, "utf8"),
    capture,
  };
}

for (const input of ["", "STAGING_API_TOKEN\nSTAGING_API_TOKEN"]) {
  test(`Actual run step gives Docker only deduplicated names for ${input ? "selected credentials" : "omitted forwarding"}`, (t) => {
    const result = runShell(t, input);
    assert.equal(result.status, 0, result.stderr);
    const invocation = JSON.parse(readFileSync(result.capture, "utf8"));
    assert.deepEqual(invocation.forwarded, input ? ["STAGING_API_TOKEN"] : []);
    assert.equal(invocation.tokenMatches, true);
    assert.ok(invocation.args.includes("BASE_URL=https://staging.example.com"));
    assert.ok(!JSON.stringify(invocation).includes(secret));
    assert.ok(!result.output.includes(secret));
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.match(result.output, /exit-code=0\nfailure-kind=test/);
    for (const entry of readdirSync(result.shard)) {
      assert.ok(
        !readFileSync(join(result.shard, entry), "utf8").includes(secret),
      );
    }
  });
}

test("Invalid runtime configuration never starts Docker and finalizes as an infrastructure failure", (t) => {
  const result = runShell(t, `STAGING_API_TOKEN=${secret}`);
  assert.equal(result.status, 1);
  assert.ok(!readdirSync(result.directory).includes("docker.json"));
  assert.equal(
    result.output,
    "exit-code=1\nfailure-kind=runtime-environment\n",
  );
  assert.ok(!result.stderr.includes(secret));

  const statusFile = join(result.shard, "shard-status.json");
  writeFileSync(
    statusFile,
    JSON.stringify({
      startedAt: new Date().toISOString(),
      lifecycle: { runner: {} },
    }),
  );
  const completed = spawnSync(
    process.execPath,
    [
      join(actionPath, "complete-shard.mjs"),
      statusFile,
      "success",
      "success",
      "0",
      imageId,
      "1",
      "runtime-environment",
      join(result.directory, "final-output"),
    ],
    { encoding: "utf8" },
  );
  assert.equal(completed.status, 1);
  const status = JSON.parse(readFileSync(statusFile, "utf8"));
  assert.equal(status.result, "infrastructure-error");
  assert.equal(status.primaryFailure.phase, "runtime-environment");
  assert.equal(status.lifecycle.playwright.started, false);
  assert.ok(!JSON.stringify(status).includes(secret));
  assert.ok(!completed.stderr.includes(secret));
});
