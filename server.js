// Spenctied sunucusu: statik dosyalar + hesap / çevrimiçi API (bağımlılık yok).
// Veri DATA_DIR klasöründeki db.json dosyasında tutulur (Railway'de Volume bağlarsan kalıcı olur).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
// Veri klasörü: DATA_DIR, Railway'in Volume yolu veya adı buna benzeyen bir değişken (yazım hatalarına karşı)
const envKey = Object.keys(process.env).find(k => /^DATA_?DIR$/i.test(k.trim().replace(/İ/g, "I")) && process.env[k] && String(process.env[k]).startsWith("/") && !String(process.env[k]).includes(":"));
const isMount = d => { try { return fs.statSync(d).dev !== fs.statSync("/").dev; } catch (e) { return false; } };
const VOL = process.env.DATA_DIR || (envKey && process.env[envKey]) || process.env.RAILWAY_VOLUME_MOUNT_PATH || (isMount("/data") ? "/data" : "");
const DIR = VOL ? VOL.trim() : path.join(__dirname, "data");
const FILE = path.join(DIR, "db.json");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".mp3": "audio/mpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

let DB = { users: {}, tokens: {} };
try { fs.mkdirSync(DIR, { recursive: true }); DB = Object.assign(DB, JSON.parse(fs.readFileSync(FILE, "utf8"))); } catch (e) {}
let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try { syncRooms(); } catch (e) {}
    try { fs.mkdirSync(DIR, { recursive: true }); const t = FILE + ".tmp"; fs.writeFileSync(t, JSON.stringify(DB)); fs.renameSync(t, FILE); } catch (e) { console.log("Kayıt hatası", e.message); }
  }, 800);
}
process.on("SIGTERM", () => { try { syncRooms(); } catch (e) {} try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(DB)); } catch (e) {} process.exit(0); });

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


// ---- Sesli odalar ----
const RM = {};
const RCATS2 = ["Müzik", "Oyun", "Sohbet", "Eğlence"], RBG2 = ["Basit", "Neon", "Kızıl", "Orman", "Okyanus"];
const STATIC = ["id", "n", "cat", "own", "perm", "adm", "lk", "ban", "ms", "ann", "mode", "bg", "partner", "nochat", "noimg", "noenv", "pw", "img", "desc"];
function rmNew(o) { return Object.assign({ adm: [], lk: [6], ban: [], ms: [], ann: "", mode: "Normal", bg: "Neon", partner: "Normal", nochat: false, noimg: false, noenv: false, pw: "", img: null, desc: "", perm: 0 }, o, { seats: Array(10).fill(null), mem: {}, ok: {}, chat: [], cs: 0, sig: {}, gone: 0 }); }
function syncRooms() { DB.rooms = Object.values(RM).filter(r => r.perm).map(r => { const o = {}; STATIC.forEach(k => o[k] = r[k]); return o; }); }
(DB.rooms || []).forEach(r => { RM[r.id] = rmNew(r); });
const mgrOf = (r, n) => r.own === n || r.adm.includes(n);
function pubRoom(r, n) { const o = {}; STATIC.forEach(k => o[k] = r[k]); if (!mgrOf(r, n)) o.pw = !!r.pw; if (r.own !== n) o.ban = mgrOf(r, n) ? r.ban : []; return o; }
function rchat(r, k, n, x, f) { const m = { i: ++r.cs, k, n, x, f: f || n, t: now() }; r.chat.push(m); if (r.chat.length > 80) r.chat.splice(0, r.chat.length - 80); return m; }
function rmStale() { return Object.values(RM); }
setInterval(() => {
  const t = now();
  for (const id in RM) {
    const r = RM[id];
    for (const n in r.mem) if (t - r.mem[n] > 9000) { delete r.mem[n]; const k = r.seats.indexOf(n); if (k >= 0) r.seats[k] = null; }
    if (!r.mem[r.own]) { r.seats[0] = null; if (!r.perm) { r.gone = r.gone || t; if (t - r.gone > 8000) delete RM[id]; } } else r.gone = 0;
  }
}, 3000);
function roomApi(a, p, q, req, res, b) {
  const me = a.u, N = me.n;
  const find = id => RM[String(id || "")];
  if (p === "rooms") {
    return send(res, 200, { list: Object.values(RM).map(r => ({ id: r.id, n: r.n, cat: r.cat, own: r.own, perm: r.perm, img: r.img, pw: !!r.pw, cnt: Object.keys(r.mem).length })) });
  }
  if (p === "room/create") {
    const n = String(b.n || "").trim().slice(0, 24), cat = RCATS2.includes(b.cat) ? b.cat : "Sohbet";
    if (n.length < 2) return send(res, 400, { err: "Oda adı en az 2 harf olmalı." });
    if (Object.values(RM).some(r => r.own === N && !r.perm)) return send(res, 409, { err: "Zaten açık bir odan var." });
    const id = "r" + now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    RM[id] = rmNew({ id, n, cat, own: N, perm: b.perm ? 1 : 0 });
    save(); return send(res, 200, { id });
  }
  const r = find(b.id || q.get("id"));
  if (!r) return send(res, 404, { err: "Oda kapandı.", gone: 1 });
  if (p === "room/join") {
    if (r.ban.includes(N)) return send(res, 403, { err: "ban" });
    if (r.pw && r.own !== N && !r.ok[N] && String(b.pw || "") !== r.pw) return send(res, 403, { err: "pw" });
    r.ok[N] = 1; const first = !r.mem[N]; r.mem[N] = now();
    if (r.own === N) r.seats[0] = N;
    if (first) rchat(r, "join", N);
    return send(res, 200, { room: pubRoom(r, N), seats: r.seats, mem: Object.keys(r.mem), chat: r.chat.slice(-30), seq: r.cs });
  }
  if (r.ban.includes(N)) return send(res, 200, { kicked: 1 });
  if (!r.ok[N]) return send(res, 403, { err: "Önce odaya gir." });
  r.mem[N] = now();
  if (r.own === N) r.seats[0] = N;
  if (p === "room/state") {
    const since = +(q.get("since") || 0), sg = r.sig[N] || []; r.sig[N] = [];
    return send(res, 200, { room: pubRoom(r, N), seats: r.seats, mem: Object.keys(r.mem), chat: r.chat.filter(m => m.i > since), seq: r.cs, sig: sg });
  }
  if (p === "room/leave") { delete r.mem[N]; const k = r.seats.indexOf(N); if (k >= 0) r.seats[k] = null; if (r.own === N) r.seats[0] = null; return send(res, 200, {}); }
  if (p === "room/chat") {
    const x = String(b.x || "").trim().slice(0, 200); if (!x) return send(res, 400, {});
    if (b.k === "sys") { if (!mgrOf(r, N)) return send(res, 403, {}); rchat(r, "sys", "", x, N); return send(res, 200, {}); }
    if (r.nochat && !mgrOf(r, N)) return send(res, 403, { err: "Sohbet kapalı." });
    me._c = (me._c || []).filter(z => now() - z < 10000); if (me._c.length >= 12) return send(res, 429, { err: "Çok hızlı yazıyorsun." }); me._c.push(now());
    rchat(r, "msg", N, x); return send(res, 200, {});
  }
  if (p === "room/seat") {
    const i = +b.i;
    if (i === -1) { const k = r.seats.indexOf(N); if (k > 0) r.seats[k] = null; return send(res, 200, { seats: r.seats }); }
    if (!(i >= 0 && i < 10)) return send(res, 400, {});
    const mg = mgrOf(r, N);
    if (r.mode === "Admin" && !mg) return send(res, 403, { err: "Bu odada yalnızca adminler koltuğa oturabilir." });
    if (r.partner === "Aç" && i === 1 && !mg) return send(res, 403, { err: "Bu koltuk partner koltuğu." });
    if (r.lk.includes(i) || (i === 1 && r.partner === "Kapat")) return send(res, 403, { err: "Bu koltuk kilitli." });
    if (i === 0 && r.own !== N) return send(res, 403, { err: "Bu koltuk oda sahibine ait." });
    if (r.own === N && r.seats[0] === N && i !== 0) return send(res, 403, { err: "Oda sahibi yerinden kalkamaz." });
    if (r.seats[i] && r.seats[i] !== N) return send(res, 409, { err: "Koltuk dolu." });
    const k = r.seats.indexOf(N); if (k >= 0) r.seats[k] = null; r.seats[i] = N;
    return send(res, 200, { seats: r.seats });
  }
  if (p === "room/set") {
    if (!mgrOf(r, N)) return send(res, 403, {});
    const o = b.patch || {}, own = r.own === N;
    const str = (k, m) => { if (typeof o[k] === "string") r[k] = o[k].slice(0, m); };
    if (typeof o.n === "string" && o.n.trim().length >= 2) r.n = o.n.trim().slice(0, 24);
    if (RCATS2.includes(o.cat)) r.cat = o.cat;
    str("ann", 160); str("desc", 160); if (own) str("pw", 12);
    if (["Normal", "Admin"].includes(o.mode)) r.mode = o.mode;
    if (RBG2.includes(o.bg)) r.bg = o.bg;
    if (["Normal", "Aç", "Kapat"].includes(o.partner)) r.partner = o.partner;
    ["nochat", "noimg", "noenv"].forEach(k => { if (typeof o[k] === "boolean") r[k] = o[k]; });
    if (o.img === null) r.img = null; else if (typeof o.img === "string" && o.img.startsWith("data:image/") && o.img.length < 400000) r.img = o.img;
    const ints = a => Array.isArray(a) ? a.map(Number).filter(v => v >= 0 && v < 10) : null;
    if (ints(o.lk)) r.lk = ints(o.lk); if (ints(o.ms)) r.ms = ints(o.ms);
    if (own && Array.isArray(o.adm)) r.adm = o.adm.map(String).filter(x => DB.users[key(x)]).slice(0, 20);
    if (own && o.perm) r.perm = 1;
    r.lk.forEach(i => { if (i > 0 && r.seats[i]) r.seats[i] = null; }); if (r.partner === "Kapat") r.seats[1] = null;
    save(); return send(res, 200, {});
  }
  if (p === "room/down") { if (!mgrOf(r, N)) return send(res, 403, {}); const k = r.seats.indexOf(b.n); if (k > 0 && b.n !== r.own && !(r.adm.includes(b.n) && r.own !== N)) r.seats[k] = null; return send(res, 200, {}); }
  if (p === "room/kick") {
    const n = String(b.n || ""); if (!mgrOf(r, N) || n === r.own || n === N || (r.adm.includes(n) && r.own !== N)) return send(res, 403, {});
    if (!r.ban.includes(n)) r.ban.push(n); r.adm = r.adm.filter(x => x !== n); delete r.mem[n]; const k = r.seats.indexOf(n); if (k >= 0) r.seats[k] = null;
    save(); return send(res, 200, {});
  }
  if (p === "room/sig") {
    const to = String(b.to || ""); if (!r.mem[to]) return send(res, 200, {});
    const l = (r.sig[to] = r.sig[to] || []); l.push({ f: N, d: b.d }); if (l.length > 80) l.splice(0, l.length - 80);
    return send(res, 200, {});
  }
  send(res, 404, { err: "Yok." });
}
async function api(req, res, p, q) {
  if (p === "health") {
    let w = false; try { fs.writeFileSync(path.join(DIR, ".t"), "1"); w = true; } catch (e) {}
    return send(res, 200, { users: Object.keys(DB.users).length, dir: DIR, yazilabilir: w, dosyaVar: fs.existsSync(FILE), kalici: !!VOL, bagli: (() => { try { return fs.statSync(DIR).dev !== fs.statSync("/").dev; } catch (e) { return false; } })(), volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null, degiskenler: Object.keys(process.env).filter(k => /DATA|VOLUME/i.test(k)) });
  }
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
  // ---- Mesajlaşma ve arkadaşlık ----
  const me = a.u; me.fl = me.fl || []; me.fin = me.fin || []; me.fout = me.fout || []; me.inb = me.inb || [];
  const fstate = () => ({ fl: me.fl, fin: me.fin, fout: me.fout });
  const other = n => { const u = DB.users[key(n || "")]; if (u) { u.fl = u.fl || []; u.fin = u.fin || []; u.fout = u.fout || []; u.inb = u.inb || []; } return u; };
  const rm = (arr, n) => { const i = arr.indexOf(n); if (i >= 0) arr.splice(i, 1); };
  const add = (arr, n) => { if (!arr.includes(n)) arr.push(n); };
  if (p === "send" && req.method === "POST") {
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz." });
    const u = other(b.to), x = String(b.x || "").trim().slice(0, 300);
    if (!u || u === me) return send(res, 404, { err: "Kullanıcı bulunamadı." });
    if (!x) return send(res, 400, { err: "Boş mesaj." });
    const t = now(); me._s = (me._s || []).filter(z => t - z < 60000);
    if (me._s.length >= 40) return send(res, 429, { err: "Çok hızlı yazıyorsun." });
    me._s.push(t);
    DB.seq = (DB.seq || 0) + 1;
    u.inb.push({ i: DB.seq, f: me.n, x, t });
    if (u.inb.length > 300) u.inb.splice(0, u.inb.length - 300);
    save(); return send(res, 200, { i: DB.seq, t });
  }
  if (p === "poll") {
    me.last = now();
    const since = +(q.get("since") || 0);
    return send(res, 200, { msgs: me.inb.filter(m => m.i > since).slice(0, 100), seq: DB.seq || 0, ...fstate() });
  }
  if (p === "friend" && req.method === "POST") {
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz." });
    const u = other(b.to), act = b.act;
    if (!u || u === me) return send(res, 404, { err: "Kullanıcı bulunamadı." });
    if (act === "req") {
      if (me.fl.includes(u.n)) return send(res, 200, fstate());
      if (me.fin.includes(u.n)) { rm(me.fin, u.n); rm(u.fout, me.n); add(me.fl, u.n); add(u.fl, me.n); }
      else { add(me.fout, u.n); add(u.fin, me.n); }
    } else if (act === "acc") {
      if (me.fin.includes(u.n)) { rm(me.fin, u.n); rm(u.fout, me.n); add(me.fl, u.n); add(u.fl, me.n); }
    } else if (act === "rej") { rm(me.fin, u.n); rm(u.fout, me.n); }
    else if (act === "cancel") { rm(me.fout, u.n); rm(u.fin, me.n); }
    else if (act === "rem") { rm(me.fl, u.n); rm(u.fl, me.n); }
    save(); return send(res, 200, fstate());
  }
  if (p === "rooms" || p.startsWith("room/")) { const b = req.method === "POST" ? await body(req) : {}; if (!b) return send(res, 400, { err: "Geçersiz." }); return roomApi(a, p, q, req, res, b); }
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
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": f.endsWith("sw.js") ? "no-cache, no-store" : "no-cache", "Permissions-Policy": "microphone=(self), camera=()" });
    res.end(d);
  });
}).listen(PORT, () => console.log("Çalışıyor: " + PORT + " | veri: " + DIR + " | kullanıcı: " + Object.keys(DB.users).length));
