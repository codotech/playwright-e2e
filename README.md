# Playwright E2E CI Framework

A small, reusable GitHub Actions pipeline for running Playwright tests with reliable evidence and one fail-closed gate.

The repository includes a real example: Playwright starts a Node.js echo server, waits for its health endpoint, and tests it through API and Chromium clients.

```text
pull request / main / manual
              |
              v
       plan two shards
          /       \
         v         v
      shard 1   shard 2
          \       /
           v     v
        merge evidence
              |
              v
          E2E Gate
```

## Run the example locally

Prerequisites: Node.js 22 and Corepack.

```bash
corepack enable
corepack prepare pnpm@10.26.2 --activate
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e install:browsers
pnpm --dir e2e test
```

The Playwright configuration owns the server lifecycle, so a separate server process is not required.

Use the CI reporter set locally when you need to inspect the exact CI artifacts:

```bash
pnpm --dir e2e test:ci
```

Run `pnpm --dir e2e test:static` to type-check the configuration and suite without starting the server.

## Use the reusable workflow

Consumer repositories keep their Playwright package in a root-level `e2e/` directory. Call the workflow from a job and pin it to the full commit SHA of a released version:

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
      shard-count: 2
```

Replace `<40-character-release-commit-sha>` with the immutable SHA published for the version you adopt. The workflow needs no inherited secrets and does not write pull-request comments.

The framework targets GitHub.com. It uses GitHub's `$/` self-repository references so the reusable workflow and its composite actions always come from the same commit; that syntax is not available on GitHub Enterprise Server.

The supported inputs are:

| Input                     | Default                | Purpose                            |
| ------------------------- | ---------------------- | ---------------------------------- |
| `working-directory`       | `e2e`                  | Playwright package location        |
| `node-version`            | `22`                   | Node.js runtime                    |
| `pnpm-version`            | `10.26.2`              | pnpm runtime                       |
| `playwright-config`       | `playwright.config.ts` | Config path inside the package     |
| `shard-count`             | `2`                    | Parallel shards, from 1 through 32 |
| `artifact-retention-days` | `10`                   | Evidence retention period          |

The workflow exposes `verdict`, `artifact-name`, `total`, `passed`, `failed`, and `skipped` outputs.

## Read the evidence

Every shard uploads its raw status, blob report, CTRF result, and Playwright test results. The merge job verifies that all expected shards are present and publishes one `e2e-evidence` artifact:

```text
e2e-evidence/
+-- playwright-report/
+-- ctrf-report.json
+-- shard-status/
+-- verdict.json
```

The HTML report is for investigation. `verdict.json` is the machine-readable result. The Actions job summary shows the merged totals without requiring repository write permissions.

## Fail-closed behavior

`E2E Gate` fails when any of these conditions occurs:

- A Playwright shard fails or is cancelled.
- A shard status or report is missing or duplicated.
- Reports cannot be merged.
- The evidence artifact cannot be published or downloaded.
- The authoritative verdict is absent or does not say `passed`.

Evidence publication runs after test failure, but publishing a report never turns a failed test run green.

To verify these guarantees on a branch, intentionally break one echo assertion, interrupt the example server startup, or temporarily remove one shard upload. Each experiment must end with a red `E2E Gate` and retained evidence; revert the controlled change after verification.
