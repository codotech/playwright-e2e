import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  actionPath,
  requestedReportDirectory,
  imageName,
  requestedArchiveDirectory,
] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(message);
};

if (
  !workspace ||
  !actionPath ||
  !requestedReportDirectory ||
  !imageName ||
  !requestedArchiveDirectory
) {
  fail(
    "prepare-context requires workspace, action path, report directory, " +
      "image name, and archive directory",
  );
}

const workspacePath = realpathSync(workspace);
const isInsideWorkspace = (path) => {
  const relativePath = relative(workspacePath, path);
  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const resolveWorkspaceInput = (value, label, mustExist) => {
  let candidate = isAbsolute(value)
    ? resolve(value)
    : resolve(workspacePath, value);
  if (mustExist && !existsSync(candidate)) {
    fail(`${label} does not exist: ${value}`);
  }
  if (mustExist) {
    candidate = realpathSync(candidate);
  } else {
    let existingAncestor = candidate;
    while (!existsSync(existingAncestor)) {
      const parent = resolve(existingAncestor, "..");
      if (parent === existingAncestor) {
        fail(`${label} has no existing parent directory`);
      }
      existingAncestor = parent;
    }
    const realAncestor = realpathSync(existingAncestor);
    candidate = resolve(realAncestor, relative(existingAncestor, candidate));
  }
  if (!isInsideWorkspace(candidate)) {
    fail(`${label} must resolve below GITHUB_WORKSPACE`);
  }
  return candidate;
};

const tagSeparator = imageName.lastIndexOf(":");
const lastSlash = imageName.lastIndexOf("/");
const repository = imageName.slice(0, tagSeparator);
const tag = imageName.slice(tagSeparator + 1);
if (
  imageName.length > 255 ||
  tagSeparator <= lastSlash ||
  !/^[a-z0-9][a-z0-9._/:-]*$/.test(repository) ||
  !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)
) {
  fail(
    `image-name must be a tagged Docker image reference; received ${imageName}`,
  );
}

const reportDirectory = resolveWorkspaceInput(
  requestedReportDirectory,
  "report-directory",
  true,
);
if (!lstatSync(reportDirectory).isDirectory()) {
  fail("report-directory must be a directory");
}
if (!existsSync(resolve(reportDirectory, "index.html"))) {
  fail("report-directory must contain index.html");
}

const assertPortableTree = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`report-directory must not contain symbolic links: ${entry.name}`);
    }
    if (entry.isDirectory()) {
      assertPortableTree(entryPath);
    } else if (!entry.isFile()) {
      fail(`report-directory contains an unsupported file type: ${entry.name}`);
    }
  }
};
assertPortableTree(reportDirectory);

const archiveDirectory = resolveWorkspaceInput(
  requestedArchiveDirectory,
  "archive-directory",
  false,
);
const isSameOrInside = (parent, child) => {
  const relativePath = relative(parent, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
};
if (
  isSameOrInside(reportDirectory, archiveDirectory) ||
  isSameOrInside(archiveDirectory, reportDirectory)
) {
  fail("archive-directory and report-directory must not overlap");
}
mkdirSync(archiveDirectory, { recursive: true });

const buildContext = resolve(archiveDirectory, ".build-context");
rmSync(buildContext, { recursive: true, force: true });
mkdirSync(buildContext);
copyFileSync(
  resolve(actionPath, "Dockerfile"),
  resolve(buildContext, "Dockerfile"),
);
copyFileSync(
  resolve(actionPath, "server.mjs"),
  resolve(buildContext, "server.mjs"),
);
cpSync(reportDirectory, resolve(buildContext, "report"), { recursive: true });

const archivePath = resolve(archiveDirectory, "playwright-e2e-report.tar.zst");
rmSync(archivePath, { force: true });
const quoteForShell = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
for (const [name, value] of Object.entries({
  E2E_REPORT_BUILD_CONTEXT: buildContext,
  E2E_REPORT_ARCHIVE_PATH: archivePath,
})) {
  process.stdout.write(`${name}=${quoteForShell(value)}\n`);
}

process.stderr.write(
  `Packaging ${basename(reportDirectory)} as ${imageName} into ${archivePath}\n`,
);
