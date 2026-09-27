import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  requestedDownloadDirectory,
  requestedEvidenceDirectory,
  requestedExpectedShards,
  outputFile,
] = process.argv.slice(2);

const expectedShards = Number(requestedExpectedShards);
if (
  !Number.isSafeInteger(expectedShards) ||
  expectedShards < 1 ||
  expectedShards > 100
) {
  throw new Error("expected-shards must be an integer between 1 and 100");
}

const assertRelative = (value, label) => {
  if (!value || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const relativePath = relative(
    "/contract-root",
    resolve("/contract-root", value),
  );
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} must resolve below GITHUB_WORKSPACE`);
  }
};

for (const [value, label] of [
  [requestedDownloadDirectory, "download-directory"],
  [requestedEvidenceDirectory, "evidence-directory"],
]) {
  assertRelative(value, label);
}

const workspacePath = realpathSync(workspace);
const downloadDirectory = resolve(workspacePath, requestedDownloadDirectory);
const evidenceDirectory = resolve(workspacePath, requestedEvidenceDirectory);

if (
  existsSync(evidenceDirectory) &&
  lstatSync(evidenceDirectory).isSymbolicLink()
) {
  throw new Error("evidence-directory must not be a symbolic link");
}
rmSync(evidenceDirectory, { recursive: true, force: true });

const stagingDirectory = resolve(evidenceDirectory, ".merge-input");
const blobDirectory = resolve(stagingDirectory, "blob-report");
const ctrfDirectory = resolve(stagingDirectory, "ctrf");
const statusDirectory = resolve(evidenceDirectory, "shard-status");
const htmlDirectory = resolve(evidenceDirectory, "playwright-report");
mkdirSync(blobDirectory, { recursive: true });
mkdirSync(ctrfDirectory, { recursive: true });
mkdirSync(statusDirectory, { recursive: true });
mkdirSync(htmlDirectory, { recursive: true });

const errors = [];
for (const [path, label] of [[downloadDirectory, "download-directory"]]) {
  if (!existsSync(path) || !lstatSync(path).isDirectory()) {
    errors.push(`${label} does not exist or is not a directory: ${path}`);
    continue;
  }
  const resolvedPath = realpathSync(path);
  const relativePath = relative(workspacePath, resolvedPath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    errors.push(`${label} escapes GITHUB_WORKSPACE through a symlink`);
  }
}

const walk = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
};

const allFiles =
  existsSync(downloadDirectory) && lstatSync(downloadDirectory).isDirectory()
    ? walk(downloadDirectory)
    : [];
const statusFiles = allFiles.filter(
  (path) => basename(path) === "shard-status.json",
);
const statuses = [];
const seenIndices = new Set();

for (const statusFile of statusFiles) {
  try {
    const status = JSON.parse(readFileSync(statusFile, "utf8"));
    const index = Number(status?.shard?.index);
    const total = Number(status?.shard?.total);
    if (!Number.isSafeInteger(index) || index < 1 || index > expectedShards) {
      errors.push(
        `Invalid shard index in ${relative(downloadDirectory, statusFile)}`,
      );
      continue;
    }
    if (total !== expectedShards) {
      errors.push(
        `Shard ${index} declared total ${total}; expected ${expectedShards}`,
      );
    }
    if (seenIndices.has(index)) {
      errors.push(`Duplicate status for shard ${index}`);
      continue;
    }
    seenIndices.add(index);
    statuses.push({
      ...status,
      sourceFile: relative(downloadDirectory, statusFile),
    });
    copyFileSync(statusFile, resolve(statusDirectory, `shard-${index}.json`));

    const shardRoot = resolve(statusFile, "..");
    const shardFiles = walk(shardRoot);
    const blobFiles = shardFiles.filter(
      (path) =>
        path.endsWith(".zip") && path.split(sep).includes("blob-report"),
    );
    if (blobFiles.length === 0) {
      errors.push(`Shard ${index} has no Playwright blob report`);
    }
    blobFiles.forEach((path, position) => {
      copyFileSync(
        path,
        resolve(
          blobDirectory,
          `shard-${index}-${position + 1}-${basename(path)}`,
        ),
      );
    });

    const ctrfFiles = shardFiles.filter(
      (path) => path.endsWith(".json") && path.split(sep).includes("ctrf"),
    );
    if (ctrfFiles.length !== 1) {
      errors.push(
        `Shard ${index} must have exactly one CTRF report; found ${ctrfFiles.length}`,
      );
    } else {
      copyFileSync(ctrfFiles[0], resolve(ctrfDirectory, `shard-${index}.json`));
    }
  } catch (error) {
    errors.push(
      `Cannot read ${relative(downloadDirectory, statusFile)}: ${error.message}`,
    );
  }
}

for (let index = 1; index <= expectedShards; index += 1) {
  if (!seenIndices.has(index)) {
    errors.push(`Missing status for shard ${index}`);
  }
}

statuses.sort((left, right) => left.shard.index - right.shard.index);
const scan = {
  schemaVersion: 1,
  expectedShards,
  observedShards: statuses.map((status) => status.shard.index),
  statuses,
  errors,
};
writeFileSync(
  resolve(stagingDirectory, "scan.json"),
  `${JSON.stringify(scan, null, 2)}\n`,
);

const appendOutput = (name, value) => {
  const escaped = String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  writeFileSync(outputFile, `${name}=${escaped}\n`, { flag: "a" });
};

appendOutput("evidence-directory", evidenceDirectory);
appendOutput("blob-directory", blobDirectory);
appendOutput("html-directory", htmlDirectory);
appendOutput("can-merge", errors.length === 0 ? "true" : "false");
