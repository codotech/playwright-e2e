# Playwright E2E

A portable GitHub Action and lightweight framework for running Playwright against a Dockerized system under test (SUT).

It keeps the application repository in control of its tests and services while providing a consistent CI engine: deterministic runner images, smart reuse, SUT lifecycle management, test filtering, Playwright reports, traces, portable artifacts, and a fail-closed result.

```text
pull request / main / manual
              |
      validate e2e/ci.yml
              |
      hash E2E runner inputs
              |
       +------+------+
       |             |
 validated cache   cache miss
       |          build runner
       +------+------+
              |
      start Dockerized SUT
              |
     Playwright projects + tags
              |
       results + traces
              |
     HTML report + report image
              |
          E2E Gate
```

## Start from the template

The quickest path is [codotech/playwright-e2e-starter](https://github.com/codotech/playwright-e2e-starter). Create a repository from that template, replace its example SUT and tests, then adapt the profiles in `e2e/ci.yml`.

The template owns repository policy: triggers, permissions, concurrency, checkout, the sticky pull-request comment, and preservation of the action result. This repository owns the portable execution engine.

## Use the action

Check out the caller repository first, then invoke the root action. Use major-version references for released actions:

```yaml
permissions:
  contents: read
  pull-requests: write

steps:
  - uses: actions/checkout@v7

  - id: e2e
    uses: codotech/playwright-e2e@main
    with:
      profile: pull-request
```

There is intentionally no release tag yet, so the starter follows `main`. Replace it with `@v1` when the first major version is published.

### Inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `profile` | `pull-request` | Named execution profile from `e2e/ci.yml` |
| `projects` | empty | Optional Playwright project override, one per line |
| `labels` | empty | Optional Playwright tag override, one per line |
| `label-match` | empty | Optional `all` or `any` tag matching override |

Projects and tags are independent filters. Projects select configured Playwright variants. Tags select tests through Playwright's `--grep`. The action runs the intersection.

### Outputs

| Output | Meaning |
| --- | --- |
| `result` | `passed`, `failed`, or `infrastructure-error` |
| `primary-failure` | Main failure message, empty on success |
| `total`, `passed`, `failed`, `skipped` | Aggregate test counts |
| `profile`, `projects`, `labels`, `label-match` | Effective selection |
| `runner-cache-hit` | Whether a validated runner archive was reused |
| `runner-content-hash` | SHA-256 identity of runner inputs |
| `runner-image-name`, `runner-image-id`, `runner-image-artifact` | Exact portable runner image |
| `results-directory`, `results-artifact` | Merged machine-readable and Playwright results |
| `report-directory` | Generated Playwright HTML report |
| `report-image-name`, `report-image-id`, `report-image-artifact` | Portable image serving the HTML report |

The action fails at the end when tests fail or infrastructure is incomplete. A caller that needs to publish a pull-request comment first can set `continue-on-error: true`, publish the comment from the outputs, and add a final step that fails when the action step outcome is not `success`. The starter demonstrates this pattern.

## Repository contract

The caller keeps these files:

```text
.
+-- compose.e2e.yml
+-- e2e/
|   +-- ci.yml
|   +-- Dockerfile
|   +-- runner-entrypoint.mjs
|   +-- package.json
|   +-- pnpm-lock.yaml
|   +-- playwright.config.ts
|   +-- tests/
+-- sut/                         # example only; use your real services
```

`e2e/ci.yml` is the CI contract:

```yaml
version: 1

runner:
  dockerfile: Dockerfile

playwright:
  config: playwright.config.ts

sut:
  composeFile: compose.e2e.yml
  baseUrl: http://127.0.0.1:4173

execution:
  shards: 1
  artifactRetentionDays: 10

profiles:
  pull-request:
    projects: [api, chromium]
    labels: ["@smoke"]
    labelMatch: any

  main:
    projects: [api, chromium]
    labels: []
    labelMatch: all
```

The root action is deliberately a single GitHub job. Playwright can still use multiple workers inside the runner container. Keep `execution.shards: 1`; repository-level job matrices can be added later by the caller without changing the portable engine.

`playwright.config.ts` defines projects, browser/device settings, matching, dependencies, reporters, and runtime behavior. `e2e/ci.yml` selects what CI runs. Unknown keys, invalid paths, unsafe values, nonexistent projects, or malformed tags fail before the SUT starts.

## What rebuilds the runner

The runner identity covers every Git-tracked or non-ignored untracked entry below `e2e/`, except `e2e/ci.yml`. Paths, file types, Unix modes, file bytes, and symlink targets all contribute.

A new runner is built when tests, fixtures, dependencies, the lockfile, Playwright configuration, runner entrypoint, Dockerfile, or Docker-ignore rules change. Profiles, filters, retention, and service-only changes reuse the same runner bytes while still running the suite against the newly built SUT.

On an exact cache hit, the action validates the archive metadata, image reference, content hash, byte size, SHA-256, and image ID before using it. A missing, evicted, or invalid cache causes a clean rebuild.

## Test lifecycle

The action performs one fail-closed sequence:

1. Validate configuration and resolve the requested profile.
2. Reuse or build the content-addressed Playwright runner.
3. Build and start the SUT with Docker Compose and wait for health checks.
4. Run the selected Playwright projects and tags.
5. Capture results, traces, screenshots, SUT logs, and teardown logs.
6. Tear down containers, volumes, and networks even after failure.
7. Build the HTML report and portable report image.
8. Upload artifacts and enforce the final result.

A Playwright failure remains the primary failure even if later log collection or cleanup also fails. Missing results, runner identity problems, unhealthy services, or publication failures produce `infrastructure-error`; they never turn a run green.

## Artifacts

| Artifact | Contents |
| --- | --- |
| `e2e-results` | Final JSON result, CTRF report, Playwright HTML report, test attachments, SUT logs, and teardown logs |
| `e2e-runner-image` | Compressed Docker archive for the exact runner used by the run |
| `e2e-report-image` | Compressed Docker archive serving the HTML report on port 8080 |

Download and load a report image:

```bash
docker load --input e2e-report-image/playwright-e2e-report.tar.zst
docker run --rm -p 8080:8080 "$REPORT_IMAGE_NAME"
```

Open `http://127.0.0.1:8080`. Traces and other Playwright attachments are retained inside the report when a test creates them.

The images are workflow artifacts, not registry publications. Artifact retention applies and local image names are not remotely pullable.

## Run this example locally

Prerequisites: Docker, Node.js 22, Corepack, and pnpm 10.26.2.

```bash
corepack enable
corepack prepare pnpm@10.26.2 --activate
pnpm --dir e2e install --frozen-lockfile
pnpm --dir e2e install:browsers
docker compose -f compose.e2e.yml up --detach --build --wait
BASE_URL=http://127.0.0.1:4173 pnpm --dir e2e test
docker compose -f compose.e2e.yml down --volumes --remove-orphans
```

Always run the final cleanup command, including after a failed test. Run `pnpm --dir e2e test:static` for the TypeScript check.

## Platform support

- GitHub.com hosted or self-hosted Linux runners with Docker and Docker Compose
- GitHub Actions runner 2.336.0 or newer, required for repository-relative `$/` action references
- One checked-out application repository per job

No inherited secrets are required by the action. The SUT may use repository or environment secrets supplied by its own workflow.

## License

[Apache-2.0](LICENSE)
