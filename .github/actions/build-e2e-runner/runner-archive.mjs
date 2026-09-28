import {
  appendFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

const [
  workspace,
  requestedArchivePath,
  expectedImageName,
  expectedContentHash,
  outputFile,
  imageId,
] = process.argv.slice(2);

const fail = (message) => {
  throw new Error(message);
};

if (!/^[a-f0-9]{64}$/.test(expectedContentHash)) {
  fail("content-hash must be a lowercase SHA-256 digest");
}
if (!expectedImageName || /[\s\0]/.test(expectedImageName)) {
  fail("image-name must be a non-empty Docker reference without whitespace");
}
if (!requestedArchivePath || isAbsolute(requestedArchivePath)) {
  fail("archive-path must be repository-relative");
}

const workspacePath = realpathSync(workspace);
const archivePath = resolve(workspacePath, requestedArchivePath);
if (basename(archivePath) !== "playwright-e2e-runner.tar.zst") {
  fail("archive-path must end with playwright-e2e-runner.tar.zst");
}
const relativeArchive = relative(workspacePath, archivePath);
if (
  relativeArchive === "" ||
  relativeArchive === ".." ||
  relativeArchive.startsWith(`..${sep}`) ||
  isAbsolute(relativeArchive)
) {
  fail("archive-path must remain inside GITHUB_WORKSPACE");
}
if (!existsSync(archivePath) || !lstatSync(archivePath).isFile()) {
  fail(`runner archive does not exist: ${requestedArchivePath}`);
}
if (lstatSync(archivePath).isSymbolicLink()) {
  fail("runner archive must not be a symbolic link");
}

const digestFile = async (path) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
};

const archiveDigest = await digestFile(archivePath);
const archiveSize = statSync(archivePath).size;
const archiveDirectory = realpathSync(dirname(archivePath));
const relativeArchiveDirectory = relative(workspacePath, archiveDirectory);
if (
  relativeArchiveDirectory === ".." ||
  relativeArchiveDirectory.startsWith(`..${sep}`) ||
  isAbsolute(relativeArchiveDirectory)
) {
  fail("runner archive directory must remain inside GITHUB_WORKSPACE");
}
const metadataPath = resolve(archiveDirectory, "metadata.json");
if (existsSync(metadataPath) && lstatSync(metadataPath).isSymbolicLink()) {
  fail("runner metadata must not be a symbolic link");
}

if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? "")) {
  fail("image-id must be a content-addressed Docker image ID");
}

const metadata = {
  schemaVersion: 1,
  contentHash: expectedContentHash,
  imageName: expectedImageName,
  imageId,
  archive: {
    file: "playwright-e2e-runner.tar.zst",
    sha256: archiveDigest,
    size: archiveSize,
  },
};
writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
  mode: 0o600,
});

for (const [name, value] of [
  ["image-name", metadata.imageName],
  ["image-id", metadata.imageId],
  ["archive-path", archivePath],
  ["archive-sha256", archiveDigest],
]) {
  appendFileSync(outputFile, `${name}=${value}\n`);
}
