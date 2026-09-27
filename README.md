# Playwright E2E CI Framework

A reusable GitHub Actions pipeline for Playwright tests against a Dockerized system under test (SUT), with durable evidence and one fail-closed gate.

This repository proves the contract with a root Docker Compose service. The service exposes a health endpoint and echoes requests; Playwright tests it through API and Chromium clients.

```text
pull request / main / manual
              |
       +------+------+
       |             |
    shard 1        shard 2
 compose up      compose up
 Playwright      Playwright
 logs + down     logs + down
       |             |
       +------+------+
              |
       merge evidence
              |
          E2E Gate
```

## Run the example locally

Prerequisites: Docker, Node.js 22, and Corepack.

Install the E2E dependencies and Chromium once:

```bash
corepack enable
corepack prepare pnpm@10.26.2 --activate
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e install:browsers
```

Start the SUT, run Playwright, and then remove the Compose resources:

```bash
docker compose -f compose.e2e.yml up --detach --build --wait
BASE_URL=http://127.0.0.1:4173 pnpm --dir e2e test
docker compose -f compose.e2e.yml down --volumes --remove-orphans
```

Always run the final command, including after a failed test. Use `pnpm --dir e2e test:ci` for the CI reporters and `pnpm --dir e2e test:static` for a type check.

## Use the reusable workflow

Keep the Playwright package in `e2e/` and the Compose file at the repository root. Pin the reusable workflow to a full release commit SHA:

```yaml
name: E2E

on:
  pull_request:

permissions:
  contents: read

jobs:
  e2e:
    uses: codotech/playwright-e2e-ci-framework/.github/workflows/reusable-e2e.yml@<40-character-release-commit-sha>
    with:
      working-directory: e2e
      compose-file: compose.e2e.yml
      base-url: http://127.0.0.1:4173
      shard-count: 2
```

Replace the marker with the immutable SHA you adopt. The workflow needs no inherited secrets and does not write pull-request comments.

| Input | Default | Purpose |
| --- | --- | --- |
| `working-directory` | `e2e` | Playwright package location |
| `playwright-config` | `playwright.config.ts` | Config path inside the package |
| `compose-file` | `compose.e2e.yml` | Compose file relative to the repository root |
| `base-url` | `http://127.0.0.1:4173` | URL Playwright uses after the SUT is healthy |
| `projects` | empty | Project names, one per line; empty selects all |
| `labels` | empty | Tags beginning with `@`, one per line; empty selects all |
| `label-match` | `all` | Require all listed labels or any listed label |
| `node-version` | `22` | Node.js runtime |
| `pnpm-version` | `10.26.2` | pnpm runtime |
| `shard-count` | `2` | Parallel shards, from 1 through 32 |
| `artifact-retention-days` | `10` | Evidence retention period |

The outputs are `verdict`, `artifact-name`, `total`, `passed`, `failed`, and `skipped`.

## Select projects and labels

A [Playwright project](https://playwright.dev/docs/test-projects) is a configured execution variant, such as a browser, device, authentication state, or test group. Each `projects` line becomes an exact `--project` selection.

A framework `label` means a [Playwright tag](https://playwright.dev/docs/test-annotations#tag-tests), not a project. Every label must start with `@`; the workflow converts the labels into one `--grep` expression.

For example, a manual run can use multiline values:

```text
projects:
api
chromium

labels:
@smoke
@browser

label-match: all
```

The repository's pull-request and `main` push runs leave both filters empty. Only a manual run supplies the form values above.

`all` requires a test to carry both `@smoke` and `@browser`. `any` accepts a test carrying either tag. Blank project or label lines are ignored, and leaving a field empty disables that filter.

Projects and labels are independent. The selected tests are the intersection of both filters, and Playwright shards that result afterward:

```text
configured tests
      |
 selected projects
      |
 matching tags
      |
 shard 1 + shard 2
```

The same values can be supplied by another workflow with YAML block scalars:

```yaml
with:
  projects: |
    api
    chromium
  labels: |
    @smoke
    @browser
  label-match: any
```

## SUT lifecycle in CI

Each shard runs on its own runner and performs the full lifecycle:

1. Validate the Compose file and base URL.
2. Build and start the SUT with `docker compose up --detach --build --wait`.
3. Run Playwright with `BASE_URL` set to the ready service.
4. Capture startup, service, and teardown logs.
5. Run `docker compose down --volumes --remove-orphans`, even after failure.

A startup or cleanup failure is an infrastructure error. A Playwright failure remains the primary failure when log collection or cleanup also fails.

## Evidence and gate

Every shard uploads its status, Compose logs, blob report, CTRF result, and Playwright test results. The merged `e2e-evidence` artifact contains:

```text
e2e-evidence/
+-- playwright-report/
+-- ctrf-report.json
+-- shard-status/
+-- verdict.json
```

`E2E Gate` fails for a failed or cancelled shard, unhealthy SUT lifecycle, missing evidence, report merge failure, artifact failure, or a non-passing verdict. Evidence publication cannot turn a failed run green.

The framework targets GitHub.com and uses `$/` references so the reusable workflow and its composite actions come from the same commit. That syntax is not available on GitHub Enterprise Server.
