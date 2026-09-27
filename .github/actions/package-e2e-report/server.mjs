import { createReadStream, existsSync, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

const host = process.env.REPORT_HOST ?? "0.0.0.0";
const port = Number.parseInt(process.env.REPORT_PORT ?? "8080", 10);
const reportRoot = realpathSync(process.env.REPORT_ROOT ?? "/app/report");
const indexFile = resolve(reportRoot, "index.html");

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `REPORT_PORT must be an integer from 1 through 65535; received ${port}`,
  );
}
if (!existsSync(indexFile) || !statSync(indexFile).isFile()) {
  throw new Error(`Playwright report index does not exist: ${indexFile}`);
}

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".webm", "video/webm"],
  [".wasm", "application/wasm"],
  [".webmanifest", "application/manifest+json"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

const sendText = (response, statusCode, message, method = "GET") => {
  const body = `${message}\n`;
  response.writeHead(statusCode, {
    "content-length": Buffer.byteLength(body),
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  if (method === "HEAD") response.end();
  else response.end(body);
};

const isInsideReport = (path) => {
  const relativePath = relative(reportRoot, path);
  return (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
};

const findFile = (pathname, acceptsHtml) => {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return { error: 400 };
  }
  if (decodedPath.includes("\0")) return { error: 400 };

  const candidate = resolve(reportRoot, `.${decodedPath}`);
  if (!isInsideReport(candidate)) return { error: 403 };

  let selected = candidate;
  if (existsSync(selected) && statSync(selected).isDirectory()) {
    selected = resolve(selected, "index.html");
  }

  if (!existsSync(selected) || !statSync(selected).isFile()) {
    const hasExtension = extname(decodedPath) !== "";
    if (acceptsHtml && !hasExtension) return { path: indexFile };
    return { error: 404 };
  }

  const realPath = realpathSync(selected);
  if (!isInsideReport(realPath)) return { error: 403 };
  return { path: realPath };
};

const parseRange = (header, size) => {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (match[1] === "" && match[2] === "")) return { error: true };

  let start;
  let end;
  if (match[1] === "") {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength < 1) {
      return { error: true };
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { error: true };
  }
  return { start, end: Math.min(end, size - 1) };
};

const server = createServer((request, response) => {
  const method = request.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    response.setHeader("allow", "GET, HEAD");
    sendText(response, 405, "Method not allowed", method);
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const acceptsHtml = (request.headers.accept ?? "").includes("text/html");
  const selection = findFile(url.pathname, acceptsHtml);
  if (selection.error) {
    sendText(
      response,
      selection.error,
      selection.error === 404 ? "Not found" : "Invalid path",
      method,
    );
    return;
  }

  const filePath = selection.path;
  const size = statSync(filePath).size;
  const range = parseRange(request.headers.range, size);
  if (range?.error) {
    response.writeHead(416, {
      "content-range": `bytes */${size}`,
      "content-length": "0",
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? Math.max(0, size - 1);
  const statusCode = range ? 206 : 200;
  const headers = {
    "accept-ranges": "bytes",
    "cache-control":
      extname(filePath) === ".html" ? "no-cache" : "public, max-age=3600",
    "content-length": String(size === 0 ? 0 : end - start + 1),
    "content-type":
      contentTypes.get(extname(filePath).toLowerCase()) ??
      "application/octet-stream",
    "x-content-type-options": "nosniff",
  };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  response.writeHead(statusCode, headers);
  if (method === "HEAD" || size === 0) {
    response.end();
    return;
  }

  const stream = createReadStream(filePath, { start, end });
  stream.on("error", () => response.destroy());
  stream.pipe(response);
});

server.listen(port, host, () => {
  console.log(`Playwright report available at http://${host}:${port}`);
});

const shutdown = () => {
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exit(1);
    }
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
