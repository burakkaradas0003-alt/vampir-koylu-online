// Basit statik sunucu (bağımlılık yok). Railway PORT değişkenini verir.
const http = require("http"), fs = require("fs"), path = require("path");
const PORT = process.env.PORT || 3000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const f = path.join(__dirname, path.normalize(p));
  if (!f.startsWith(__dirname) || f.endsWith("server.js") || f.endsWith("package.json")) { res.writeHead(404); return res.end("Bulunamadı"); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("Bulunamadı"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith("sw.js") ? "no-cache, no-store" : "no-cache" });
    res.end(d);
  });
}).listen(PORT, () => console.log("Çalışıyor: " + PORT));
