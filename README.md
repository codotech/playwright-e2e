# Playwright E2E CI Framework

A reusable GitHub Actions pipeline for Playwright tests against a Dockerized system under test (SUT), with durable evidence and one fail-closed gate.

This repository proves the contract with a root Docker Compose service. The service exposes a health endpoint and echoes requests; Playwright tests it through API and Chromium clients.

```text
pull request / main / manual
              |
      build runner image once
              |
       portable runner archive
              |
       +------+------+
       |             |
    shard 1        shard 2
 load runner     load runner
 compose SUT     compose SUT
 run tests       run tests
 evidence        evidence
       |             |
       +------+------+
              |
       merge evidence
              |
      package report image
              |
       portable report archive
              |
          E2E Gate
              |
      sticky PR confidence report
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
  pull-requests: write

jobs:
  e2e:
    uses: codotech/playwright-e2e-ci-framework/.github/workflows/reusable-e2e.yml@<40-character-release-commit-sha>
    with:
      working-directory: e2e
      compose-file: compose.e2e.yml
      base-url: http://127.0.0.1:4173
      shard-count: 2
```

Replace the marker with the immutable SHA you adopt. The workflow needs no inherited secrets. Pull-request comments use the explicitly granted permission shown above.

| Input | Default | Purpose |
| --- | --- | --- |
| `working-directory` | `e2e` | Playwright package location |
| `playwright-config` | `playwright.config.ts` | Config path inside the package |
| `compose-file` | `compose.e2e.yml` | Compose file relative to the repository root |
| `base-url` | `http://127.0.0.1:4173` | URL Playwright uses after the SUT is healthy |
| `projects` | empty | Project names, one per line; empty selects all |
| `labels` | empty | Tags beginning with `@`, one per line; empty selects all |
| `label-match` | `all` | Require all listed labels or any listed label |
| `shard-count` | `2` | Parallel shards, from 1 through 32 |
| `artifact-retention-days` | `10` | Evidence retention period |
| `comment-on-pr` | `true` | Update one E2E report comment on same-repository pull requests |

The workflow exposes the verdict, merged test totals, and the exact names and IDs of its portable images. The image outputs are listed below.

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

The same immutable runner image merges the shard blobs; pull-request dependencies are never installed directly on the GitHub host. `E2E Gate` fails for runner transport or identity problems, a failed or cancelled shard, unhealthy SUT lifecycle, missing evidence, report merge failure, report-image publication failure, evidence publication failure, or a non-passing verdict. Evidence publication cannot turn a failed run green.

## Load the runner and report images

A healthy run publishes two Docker archives in addition to the regular test evidence. If report packaging or publication fails, the report outputs are empty and the authoritative verdict is an infrastructure error.

| Artifact | Archive inside it | Purpose |
| --- | --- | --- |
| `e2e-runner-image` | `playwright-e2e-runner.tar.zst` | Exact Playwright runner used by every shard |
| `e2e-report-image` | `playwright-e2e-report.tar.zst` | Merged HTML report served on port 8080 |

The workflow exposes these values:

| Output | Meaning |
| --- | --- |
| `runner-image-name` | Commit-tagged runner image name |
| `runner-image-id` | Content-addressed local runner image ID |
| `runner-image-artifact` | Runner archive artifact name |
| `report-image-name` | Run-tagged report image name; empty when unavailable |
| `report-image-id` | Content-addressed local report image ID; empty when unavailable |
| `report-image-artifact` | Report archive artifact name; empty when unavailable |

After downloading the runner artifact, load it and run the exact test environment again. Replace the image variable with the corresponding workflow output:

```bash
docker load --input e2e-runner-image/playwright-e2e-runner.tar.zst
mkdir -p e2e-output
docker run --rm --init --ipc=host \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges:true \
  --pids-limit=1024 \
  --user "$(id -u):$(id -g)" \
  --add-host=host.docker.internal:host-gateway \
  -e BASE_URL=http://host.docker.internal:4173 \
  -e HOME=/tmp \
  -v "$PWD/e2e-output:/evidence" \
  "$RUNNER_IMAGE_ID"
```

Append normal Playwright arguments, such as `--project=chromium --grep=@smoke`, after the image name.

Load and serve the merged report in the same way:

```bash
docker load --input e2e-report-image/playwright-e2e-report.tar.zst
docker run --rm -p 8080:8080 "$REPORT_IMAGE_NAME"
```

Open `http://127.0.0.1:8080`. The report image contains the complete merged HTML directory. Retained Playwright traces and other report attachments remain available from the report when the test produced them.

These images are currently GitHub artifacts, not registry publications. Download and `docker load` the archives before use; artifact retention still applies, and the run-tagged image names are not remotely pullable.

For pull requests from the same repository, the workflow creates or updates one sticky `E2E confidence report` comment with the verdict, aggregate totals, active project and label filters, failure reason, and workflow evidence link. Grant `pull-requests: write` in the caller workflow, or set `comment-on-pr: false` when comments are not wanted. Comment publication is non-blocking and does not change the gate verdict.

The framework targets GitHub.com and uses `$/` references so the reusable workflow and its composite actions come from the same commit. That syntax is not available on GitHub Enterprise Server.
