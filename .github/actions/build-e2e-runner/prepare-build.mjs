import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  requestedWorkingDirectory,
  requestedDockerfile,
  imageName,
  requestedArchivePath,
] = process.argv.slice(2);

const assertRelative = (value, label) => {
  if (!value || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const relativePath = relative("/contract-root", resolve("/contract-root", value));
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`${label} must resolve below its parent directory`);
  }
};

assertRelative(requestedWorkingDirectory, "working-directory");
assertRelative(requestedDockerfile, "dockerfile");
assertRelative(requestedArchivePath, "archive-path");
if (!imageName || /[\s\0]/.test(imageName)) {
  throw new Error("image-name must be a non-empty Docker reference without whitespace");
}

const workspacePath = realpathSync(workspace);
const buildContext = resolve(workspacePath, requestedWorkingDirectory);
if (!existsSync(buildContext) || !lstatSync(buildContext).isDirectory()) {
  throw new Error(`E2E runner build context does not exist: ${requestedWorkingDirectory}`);
}
const resolvedBuildContext = realpathSync(buildContext);
const contextRelativePath = relative(workspacePath, resolvedBuildContext);
if (contextRelativePath.startsWith("..") || isAbsolute(contextRelativePath)) {
  throw new Error("working-directory must not escape GITHUB_WORKSPACE through a symlink");
}

const dockerfile = resolve(resolvedBuildContext, requestedDockerfile);
if (!existsSync(dockerfile) || !lstatSync(dockerfile).isFile()) {
  throw new Error(`E2E runner Dockerfile does not exist: ${requestedDockerfile}`);
}
const resolvedDockerfile = realpathSync(dockerfile);
const dockerfileRelativePath = relative(resolvedBuildContext, resolvedDockerfile);
if (dockerfileRelativePath.startsWith("..") || isAbsolute(dockerfileRelativePath)) {
  throw new Error("dockerfile must not escape working-directory through a symlink");
}

const archivePath = resolve(workspacePath, requestedArchivePath);
if (basename(archivePath) !== "playwright-e2e-runner.tar.zst") {
  throw new Error("archive-path must end with playwright-e2e-runner.tar.zst");
}
const archiveRelativePath = relative(workspacePath, archivePath);
if (archiveRelativePath.startsWith("..") || isAbsolute(archiveRelativePath)) {
  throw new Error("archive-path must remain inside GITHUB_WORKSPACE");
}
let existingArchiveAncestor = archivePath;
while (!existsSync(existingArchiveAncestor)) {
  const parent = dirname(existingArchiveAncestor);
  if (parent === existingArchiveAncestor) {
    throw new Error("archive-path has no existing parent directory");
  }
  existingArchiveAncestor = parent;
}
const resolvedArchiveAncestor = realpathSync(existingArchiveAncestor);
const archiveAncestorRelativePath = relative(
  workspacePath,
  resolvedArchiveAncestor,
);
if (
  archiveAncestorRelativePath.startsWith("..") ||
  isAbsolute(archiveAncestorRelativePath)
) {
  throw new Error("archive-path must not traverse a symlink outside GITHUB_WORKSPACE");
}
mkdirSync(dirname(archivePath), { recursive: true });
for (const outputPath of [archivePath, resolve(dirname(archivePath), "metadata.json")]) {
  if (existsSync(outputPath) && lstatSync(outputPath).isDirectory()) {
    throw new Error(`runner output path must not be a directory: ${outputPath}`);
  }
  rmSync(outputPath, { force: true });
}

const quoteForShell = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
for (const [name, value] of Object.entries({
  E2E_BUILD_CONTEXT: resolvedBuildContext,
  E2E_ABSOLUTE_DOCKERFILE: resolvedDockerfile,
  E2E_RUNNER_IMAGE: imageName,
  E2E_ABSOLUTE_ARCHIVE_PATH: archivePath,
})) {
  process.stdout.write(`${name}=${quoteForShell(value)}\n`);
}
