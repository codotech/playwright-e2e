FROM node:22.22.1-alpine3.23@sha256:8094c002d08262dba12645a3b4a15cd6cd627d30bc782f53229a2ec13ee22a00

ENV NODE_ENV=production \
    REPORT_HOST=0.0.0.0 \
    REPORT_PORT=8080 \
    REPORT_ROOT=/app/report

WORKDIR /app

COPY --chown=node:node server.mjs ./server.mjs
COPY --chown=node:node report ./report

USER node

EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=2s --start-period=2s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

CMD ["node", "server.mjs"]
