import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const workflowPath = fileURLToPath(
  new URL("../workflows/e2e.yml", import.meta.url),
);
const parsed = spawnSync(
  "ruby",
  [
    "-ryaml",
    "-rjson",
    "-e",
    "puts JSON.generate(YAML.load_file(ARGV[0]))",
    workflowPath,
  ],
  { encoding: "utf8" },
);
assert.equal(parsed.status, 0, parsed.stderr);
const job = JSON.parse(parsed.stdout).jobs.e2e;
const step = (id) => job.steps.find((entry) => entry.id === id);

test("The caller starts and waits for its SUT before invoking the URL-only action", () => {
  assert.match(step("sut").run, /docker compose .*up --detach --build --wait/);
  assert.ok(job.steps.indexOf(step("sut")) < job.steps.indexOf(step("e2e")));
  assert.equal(step("e2e").if, "steps.sut.outcome == 'success'");
  assert.match(
    job.env.COMPOSE_PROJECT_NAME,
    /github.run_id.*github.run_attempt/,
  );
});

test("The caller collects and publishes its own service logs and always attempts cleanup", () => {
  for (const id of ["sut-logs", "sut-cleanup", "sut-artifact"]) {
    assert.match(step(id).if, /^always\(\)/);
    assert.equal(step(id)["continue-on-error"], true);
  }
  assert.match(step("sut-cleanup").run, /down --volumes --remove-orphans/);
  assert.equal(step("sut-artifact").with.name, "sut-logs");
  assert.ok(
    job.steps.indexOf(step("sut-cleanup")) <
      job.steps.indexOf(step("sut-artifact")),
  );
});

const gate = job.steps.find((entry) => entry.name === "Preserve E2E result");
const successfulOutcomes = Object.fromEntries(
  Object.keys(gate.env).map((name) => [name, "success"]),
);

test("The caller gate passes only when tests and all caller-owned lifecycle steps succeed", () => {
  const result = spawnSync("bash", ["-c", gate.run], {
    env: { ...process.env, ...successfulOutcomes },
  });
  assert.equal(result.status, 0);
});

for (const name of Object.keys(successfulOutcomes)) {
  test(`The caller gate fails when ${name} fails`, () => {
    const result = spawnSync("bash", ["-c", gate.run], {
      env: { ...process.env, ...successfulOutcomes, [name]: "failure" },
    });
    assert.equal(result.status, 1);
  });
}

test("A skipped action after SUT startup failure cannot turn the caller gate green", () => {
  const result = spawnSync("bash", ["-c", gate.run], {
    env: {
      ...process.env,
      ...successfulOutcomes,
      SUT_SETUP_OUTCOME: "failure",
      E2E_STEP_OUTCOME: "skipped",
    },
  });
  assert.equal(result.status, 1);
});

for (const [actionResult, cleanup, expected] of [
  ["passed", "success", "✅ passed"],
  ["passed", "failure", "⚠️ infrastructure-error"],
  ["failed", "failure", "❌ failed"],
]) {
  test(`The PR comment reports ${expected} when tests are ${actionResult} and cleanup is ${cleanup}`, async () => {
    const script = job.steps.find(
      (entry) => entry.name === "Update pull request",
    ).with.script;
    let comment;
    const github = {
      paginate: async () => [],
      rest: {
        issues: {
          listComments() {},
          async createComment(value) {
            comment = value.body;
          },
        },
      },
    };
    const AsyncFunction = Object.getPrototypeOf(
      async function () {},
    ).constructor;
    await new AsyncFunction("github", "context", "process", script)(
      github,
      {
        serverUrl: "https://github.com",
        repo: { owner: "example", repo: "test" },
        runId: 1,
        issue: { number: 1 },
      },
      {
        env: {
          E2E_RESULT: actionResult,
          E2E_SUT_SETUP: "success",
          E2E_SUT_CLEANUP: cleanup,
          E2E_SUT_LOGS: "success",
          E2E_SUT_ARTIFACT: "success",
        },
      },
    );
    assert.ok(comment.includes(expected), comment);
  });
}
