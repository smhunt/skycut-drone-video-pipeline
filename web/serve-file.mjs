// Shared static file serving with HTTP Range support (Safari/Chrome video needs 206s).
import fs from "node:fs";
import path from "node:path";

const TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".html": "text/html",
  ".txt": "text/plain",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

/** Serve `urlPath` (already stripped of any mount prefix) from `root`. Returns true if handled. */
export function serveFile(root, urlPath, req, res, { listDirs = false } = {}) {
  const filePath = path.normalize(path.join(root, decodeURIComponent(urlPath)));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("forbidden");
    return true;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    res.writeHead(404);
    res.end("not found");
    return true;
  }

  if (stat.isDirectory()) {
    if (!listDirs) {
      res.writeHead(404);
      return res.end("not found"), true;
    }
    const entries = fs.readdirSync(filePath).filter((e) => !e.startsWith("."));
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<ul>${entries.map((e) => `<li><a href="${path.posix.join(req.url, e)}">${e}</a></li>`).join("")}</ul>`);
    return true;
  }

  const type = TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), stat.size - 1) : stat.size - 1;
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "content-range": `bytes */${stat.size}` });
      res.end();
      return true;
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
  return true;
}
