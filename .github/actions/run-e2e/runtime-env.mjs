const reservedNames = new Set([
  "BASE_URL",
  "CI",
  "HOME",
  "PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
]);
const reservedPrefixes =
  /^(E2E_|PLAYWRIGHT_|CTRF_|GITHUB_|RUNNER_|INPUT_|DOCKER_|LD_|DYLD_)/;

try {
  const names = new Set();
  for (const line of (process.env.E2E_RUNTIME_ENV ?? "").split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(
        "runtime-env accepts variable names only, one per line; assignments and other characters are not allowed",
      );
    }
    if (reservedNames.has(name) || reservedPrefixes.test(name)) {
      throw new Error(
        "runtime-env cannot forward reserved runner or process-control variables",
      );
    }
    if (!Object.hasOwn(process.env, name) || process.env[name] === "") {
      throw new Error(
        "Every runtime-env variable must be defined and non-empty in the action environment",
      );
    }
    names.add(name);
  }
  if (names.size) process.stdout.write(`${[...names].join("\n")}\n`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
