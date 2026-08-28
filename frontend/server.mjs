import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";

const port = Number(process.env.PORT || 3000);
const root = join(process.cwd(), "dist");
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
  const candidate = normalize(join(root, pathname));
  const file = candidate.startsWith(root + sep) && existsSync(candidate) && statSync(candidate).isFile()
    ? candidate
    : join(root, "index.html");
  response.writeHead(200, {
    "content-type": types[extname(file)] || "application/octet-stream",
    "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(response);
}).listen(port, "0.0.0.0");
