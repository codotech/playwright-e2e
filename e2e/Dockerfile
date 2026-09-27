FROM mcr.microsoft.com/playwright:v1.61.1-noble@sha256:5b8f294aff9041b7191c34a4bab3ac270157a28774d4b0660e9743297b697e48

ENV CI=true \
    E2E_RESULTS_DIR=/evidence/test-results \
    PLAYWRIGHT_BLOB_OUTPUT_DIR=/evidence/blob-report \
    CTRF_OUTPUT_FILE=/evidence/ctrf/ctrf-report.json

RUN corepack enable && corepack prepare pnpm@10.26.2 --activate

WORKDIR /workspace/e2e

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY --chown=pwuser:pwuser . .

RUN mkdir -p /evidence && chown pwuser:pwuser /evidence

USER pwuser

ENTRYPOINT ["node", "./runner-entrypoint.mjs"]
