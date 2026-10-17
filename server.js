// Spenctied sunucusu: statik dosyalar + hesap / çevrimiçi API (bağımlılık yok).
// Veri DATA_DIR klasöründeki db.json dosyasında tutulur (Railway'de Volume bağlarsan kalıcı olur).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
const DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FILE = path.join(DIR, "db.json");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

let DB = { users: {}, tokens: {} };
try { fs.mkdirSync(DIR, { recursive: true }); DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { fs.mkdirSync(DIR, { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(DB)); fs.renameSync(t, FILE); } catch (e) { console.log("Kayıt hatası", e.message); }
  }, 800);
}
process.on("SIGTERM", () => { try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(DB)); } catch (e) {} process.exit(0); });

const PUB_KEYS = ["vkstat", "vkinfo", "vkpic", "vkjack"]; // başkalarının görebileceği alanlar
const ONLINE_MS = 50000;
const now = () => Date.now();
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const key = n => String(n).trim().toLowerCase();
const NAME_RE = /^[A-Za-z0-9ğüşıöçĞÜŞİÖÇ_.\-]{3,12}$/;

const send = (res, code, obj) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
function body(req) {
  return new Promise(resolve => {
    let d = "", n = 0;
    req.on("data", c => { n += c.length; if (n > 6e6) { req.destroy(); resolve(null); } else d += c; });
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve(null); } });
  });
}
function authed(req) {
  const t = (req.headers.authorization || "").replace("Bearer ", "");
  const k = DB.tokens[t];
  return k && DB.users[k] ? { k, u: DB.users[k], t } : null;
}
const newToken = k => { const t = crypto.randomBytes(24).toString("hex"); DB.tokens[t] = k; return t; };
const parse = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
function summary(u) {
  const st = parse((u.blob || {}).vkstat);
  return { n: u.n, st: u.st || "Çevrimiçi", xp: st.xp || 0, id: st.id || 0 };
}
const tries = {};
function limited(ip) {
  const t = now(), a = (tries[ip] = (tries[ip] || []).filter(x => t - x < 60000));
  if (a.length >= 12) return true;
  a.push(t); return false;
}

async function api(req, res, p, q) {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (p === "register" && req.method === "POST") {
    if (limited(ip)) return send(res, 429, { err: "Çok fazla deneme. Biraz bekle." });
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz istek." });
    const n = String(b.u || "").trim(), pw = String(b.p || "");
    if (!NAME_RE.test(n)) return send(res, 400, { err: "Kullanıcı adı 3-12 karakter olmalı (harf, rakam, _ . -)." });
    if (pw.length < 4 || pw.length > 40) return send(res, 400, { err: "Şifre en az 4 karakter olmalı." });
    if (DB.users[key(n)]) return send(res, 409, { err: "Bu kullanıcı adı alınmış." });
    const salt = crypto.randomBytes(12).toString("hex");
    DB.users[key(n)] = { n, salt, h: hash(pw, salt), created: now(), blob: {}, last: now(), st: "Çevrimiçi" };
    const t = newToken(key(n)); save();
    return send(res, 200, { token: t, user: n, blob: {} });
  }
  if (p === "login" && req.method === "POST") {
    if (limited(ip)) return send(res, 429, { err: "Çok fazla deneme. Biraz bekle." });
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz istek." });
    const u = DB.users[key(b.u || "")];
    if (!u || hash(String(b.p || ""), u.salt) !== u.h) return send(res, 401, { err: "Kullanıcı adı veya şifre hatalı." });
    const t = newToken(key(u.n)); save();
    return send(res, 200, { token: t, user: u.n, blob: u.blob || {} });
  }
  const a = authed(req);
  if (!a) return send(res, 401, { err: "Oturum geçersiz." });
  if (p === "me") { a.u.last = now(); return send(res, 200, { user: a.u.n, blob: a.u.blob || {} }); }
  if (p === "logout") { delete DB.tokens[a.t]; a.u.last = 0; save(); return send(res, 200, {}); }
  if (p === "blob" && req.method === "POST") {
    const b = await body(req); if (!b || typeof b.blob !== "object") return send(res, 400, { err: "Geçersiz." });
    const o = {}; for (const k in b.blob) if (/^vk[a-z0-9]{1,12}$/.test(k) && typeof b.blob[k] === "string" && b.blob[k].length < 4e6) o[k] = b.blob[k];
    a.u.blob = o; save(); return send(res, 200, {});
  }
  if (p === "ping" && req.method === "POST") {
    const b = await body(req) || {};
    a.u.last = now(); a.u.st = String(b.st || "Çevrimiçi").slice(0, 30);
    return send(res, 200, {});
  }
  if (p === "online") {
    const t = now(), list = Object.values(DB.users).filter(u => t - (u.last || 0) < ONLINE_MS && u !== a.u).map(summary);
    return send(res, 200, { list });
  }
  if (p === "user") {
    const u = DB.users[key(q.get("n") || "")]; if (!u) return send(res, 404, { err: "Bulunamadı." });
    const out = { n: u.n, created: u.created, on: now() - (u.last || 0) < ONLINE_MS, st: u.st || "" };
    PUB_KEYS.forEach(k => { if ((u.blob || {})[k]) out[k] = u.blob[k]; });
    return send(res, 200, out);
  }
  if (p === "search") {
    const s = key(q.get("q") || ""); if (s.length < 2) return send(res, 200, { list: [] });
    const list = Object.values(DB.users).filter(u => key(u.n).includes(s)).slice(0, 20).map(summary);
    return send(res, 200, { list });
  }
  send(res, 404, { err: "Yok." });
}

http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname.slice(5), url.searchParams).catch(e => { console.log(e); send(res, 500, { err: "Sunucu hatası." }); });
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const f = path.join(__dirname, path.normalize(p));
  if (!f.startsWith(__dirname) || f.endsWith("server.js") || f.endsWith("package.json") || f.startsWith(DIR)) { res.writeHead(404); return res.end("Bulunamadı"); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("Bulunamadı"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith("sw.js") ? "no-cache, no-store" : "no-cache" });
    res.end(d);
  });
}).listen(PORT, () => console.log("Çalışıyor: " + PORT));
