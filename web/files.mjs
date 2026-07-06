// Static file server for ~/SkyCut/projects with HTTP Range support (Safari requires it for video).
// HTTPS on :5502 with the shared dev.ecoworks.ca cert.
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT = 5502;
const ROOT = path.join(os.homedir(), "SkyCut", "projects");
const TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
};

const certDir = path.join(os.homedir(), "Code/.traefik/certs");
const server = https.createServer(
  { cert: fs.readFileSync(path.join(certDir, "cert.pem")), key: fs.readFileSync(path.join(certDir, "key.pem")) },
  (req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} range=${req.headers.range ?? "-"} ua=${(req.headers["user-agent"] ?? "").slice(0, 40)}`);
    res.on("close", () => console.log(`  → closed (${res.statusCode}, finished=${res.writableFinished})`));
    const urlPath = decodeURIComponent(new URL(req.url, "https://x").pathname);
    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end("forbidden");
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.writeHead(404);
      return res.end("not found");
    }

    if (stat.isDirectory()) {
      const entries = fs.readdirSync(filePath).filter((e) => !e.startsWith("."));
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(
        `<ul>${entries
          .map((e) => `<li><a href="${path.posix.join(urlPath, e)}">${e}</a></li>`)
          .join("")}</ul>`
      );
    }

    const type = TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
      if (start > end || start >= stat.size) {
        res.writeHead(416, { "content-range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "content-length": end - start + 1,
        "accept-ranges": "bytes",
      });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes" });
      fs.createReadStream(filePath).pipe(res);
    }
  }
);

server.listen(PORT, () => console.log(`SkyCut files: https://dev.ecoworks.ca:${PORT} (root: ${ROOT})`));
