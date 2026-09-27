import { appendFileSync, existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const [workspace, requestedDirectory, browser, outputFile] =
  process.argv.slice(2);

if (!workspace || !requestedDirectory || !browser || !outputFile) {
  throw new Error(
    "validate-workspace requires workspace, directory, browser, and output file",
  );
}

if (isAbsolute(requestedDirectory)) {
  throw new Error("working-directory must be relative to GITHUB_WORKSPACE");
}

if (!/^[a-z][a-z0-9-]*$/.test(browser)) {
  throw new Error(`Unsupported Playwright browser name: ${browser}`);
}

const workspacePath = realpathSync(workspace);
const candidatePath = resolve(workspacePath, requestedDirectory);
const candidateRelativePath = relative(workspacePath, candidatePath);

if (
  candidateRelativePath === "" ||
  candidateRelativePath === ".." ||
  candidateRelativePath.startsWith(
    `..${process.platform === "win32" ? "\\" : "/"}`,
  ) ||
  isAbsolute(candidateRelativePath)
) {
  throw new Error(
    "working-directory must resolve to a directory below GITHUB_WORKSPACE",
  );
}

for (const fileName of ["package.json", "pnpm-lock.yaml"]) {
  if (!existsSync(resolve(candidatePath, fileName))) {
    throw new Error(
      `Missing required E2E workspace file: ${requestedDirectory}/${fileName}`,
    );
  }
}

const resolvedDirectory = realpathSync(candidatePath);
const resolvedRelativePath = relative(workspacePath, resolvedDirectory);
if (resolvedRelativePath.startsWith("..") || isAbsolute(resolvedRelativePath)) {
  throw new Error(
    "working-directory must not escape GITHUB_WORKSPACE through a symlink",
  );
}

appendFileSync(outputFile, `working-directory=${resolvedDirectory}\n`);
