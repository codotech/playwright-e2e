import { readFileSync, writeFileSync } from "node:fs";

const parseLines = (value) =>
  value
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);

const unique = (values) => [...new Set(values)];

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const createSelection = (rawProjects, rawLabels, labelMatch) => {
  if (!new Set(["all", "any"]).has(labelMatch)) {
    throw new Error(`label-match must be all or any; received ${labelMatch}`);
  }

  const projects = unique(parseLines(rawProjects));
  const labels = unique(parseLines(rawLabels));
  for (const label of labels) {
    if (!label.startsWith("@") || label.length === 1) {
      throw new Error(`Every label must begin with @ and contain a name; received ${label}`);
    }
  }

  const escapedLabels = labels.map(escapeRegex);
  const grep =
    escapedLabels.length === 0
      ? null
      : labelMatch === "all"
        ? escapedLabels.map((label) => `(?=.*${label})`).join("")
        : `(?:${escapedLabels.join("|")})`;
  const args = projects.map((project) => `--project=${project}`);
  if (grep) args.push(`--grep=${grep}`);

  return { projects, labels, labelMatch, grep, args };
};

const [command, ...args] = process.argv.slice(2);
if (command === "emit-args") {
  const [selectionFile] = args;
  const selection = JSON.parse(readFileSync(selectionFile, "utf8"));
  for (const argument of selection.args ?? []) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new Error("Selection file contains an invalid Playwright argument");
    }
    process.stdout.write(argument);
    process.stdout.write("\0");
  }
} else if (command === "write") {
  const [rawProjects, rawLabels, labelMatch, selectionFile] = args;
  const selection = createSelection(rawProjects, rawLabels, labelMatch);
  writeFileSync(selectionFile, `${JSON.stringify(selection, null, 2)}\n`);
} else if (process.argv[1]?.endsWith("playwright-selection.mjs")) {
  throw new Error(`Unknown playwright-selection command: ${command ?? ""}`);
}
