// Spenctied sunucusu: statik dosyalar + hesap / çevrimiçi API (bağımlılık yok).
// Veri DATA_DIR klasöründeki db.json dosyasında tutulur (Railway'de Volume bağlarsan kalıcı olur).
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000;
// Veri klasörü: DATA_DIR, Railway'in Volume yolu veya adı buna benzeyen bir değişken (yazım hatalarına karşı)
const envKey = Object.keys(process.env).find(k => /^DATA_?DIR$/i.test(k.trim().replace(/İ/g, "I")) && process.env[k] && String(process.env[k]).startsWith("/") && !String(process.env[k]).includes(":"));
const isMount = d => { try { return fs.statSync(d).dev !== fs.statSync("/").dev; } catch (e) { return false; } };
const mountsList = () => { try { return fs.readFileSync("/proc/mounts", "utf8").split("\n").map(l => l.split(" ")).filter(p => p[1] && /^\/(dev|mnt)\//.test(p[0] || "") && !["/", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"].includes(p[1]) && !p[1].startsWith("/proc") && !p[1].startsWith("/sys") && !p[1].startsWith("/dev")).map(p => p[1]); } catch (e) { return []; } };
const okDir = d => { try { fs.accessSync(d, fs.constants.W_OK); return !/^\/(opt|usr|etc|mnt\/skills|lib|bin|sbin|var\/lib\/docker)/.test(d); } catch (e) { return false; } };
const autoVol = () => (isMount("/data") ? "/data" : (mountsList().find(okDir) || ""));
const VOL = process.env.DATA_DIR || (envKey && process.env[envKey]) || process.env.RAILWAY_VOLUME_MOUNT_PATH || autoVol();
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

const PUB_KEYS = ["vkstat", "vkinfo", "vkpic", "vkjack", "vkfrm"]; // başkalarının görebileceği alanlar
const ONLINE_MS = 50000;
const now = () => Date.now();
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString("hex");
const key = n => String(n).trim().toLowerCase();
const NAME_RE = /^[A-Za-z0-9ğüşıöçĞÜŞİÖÇ_.\-]{3,12}$/;
// Yasaklı (yönetim gibi görünen) adlar; kurucular FOUNDERS değişkeninden gelir (virgülle ayrılmış kullanıcı adları)
const RESERVED = ["admin", "administrator", "yonetici", "yönetici", "moderator", "moderatör", "mod", "destek", "support", "spenctied", "kurucu", "sistem", "system", "root", "owner", "vampirkoylu"];
const FOUNDERS = (process.env.FOUNDERS || "").split(",").map(x => key(x)).filter(Boolean);
const rank = r => (r === "kur" ? 3 : r === "sup" ? 2 : r === "mod" ? 1 : 0);
const usedIds = new Set();
function newId() { let i; do { i = 10000000 + crypto.randomInt(90000000); } while (usedIds.has(i)); usedIds.add(i); return i; }
Object.values(DB.users).forEach(u => {
  let id = +u.id || 0;
  if (!id) { let old = 0; try { old = +JSON.parse((u.blob || {}).vkstat || "{}").id || 0; } catch (e) {} if (old >= 10000000 && old < 100000000) id = old; }
  if (!id || usedIds.has(id)) id = newId();
  u.id = id; usedIds.add(id);
  if (FOUNDERS.includes(key(u.n))) u.role = "kur";
});
const banOf = u => { const b = u.ban; if (!b) return null; if (b.u && b.u < now()) { delete u.ban; return null; } return b; };
const banMsg = b => "Hesabın banlandı" + (b.r ? ": " + b.r : "") + (b.u ? " (" + new Date(b.u).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" }) + " tarihine kadar)" : " (süresiz)");
const meOf = u => ({ id: u.id, role: u.role || "", ti: u.titles || [], vl: u.vl || 0 });

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
  if (!k || !DB.users[k]) return null;
  if (banOf(DB.users[k])) { delete DB.tokens[t]; return null; }
  return { k, u: DB.users[k], t };
}
const newToken = k => { const t = crypto.randomBytes(24).toString("hex"); DB.tokens[t] = k; return t; };
const parse = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
function summary(u) {
  const st = parse((u.blob || {}).vkstat);
  return { n: u.n, st: u.st || "Çevrimiçi", xp: st.xp || 0, id: u.id || 0, role: u.role || "", ti: u.titles || [], vl: u.vl || 0 };
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
function rmNew(o) { return Object.assign({ adm: [], lk: [], ban: [], ms: [], ann: "", mode: "Normal", bg: "Neon", partner: "Normal", nochat: false, noimg: false, noenv: false, pw: "", img: null, desc: "", perm: 0 }, o, { seats: Array(10).fill(null), mem: {}, ok: {}, chat: [], cs: 0, sig: {}, gone: 0 }); }
function syncRooms() { DB.rooms = Object.values(RM).filter(r => r.perm).map(r => { const o = {}; STATIC.forEach(k => o[k] = r[k]); return o; }); }
(DB.rooms || []).forEach(r => { RM[r.id] = rmNew(r); });
const rlOf = r => { const o = {}; Object.keys(r.mem).concat(r.own).forEach(n => { const u = DB.users[key(n)]; if (u) o[n] = { r: u.role || "", ti: u.titles || [], vl: u.vl || 0 }; }); return o; };
const mgrOf = (r, n) => r.own === n || r.adm.includes(n);
function pubRoom(r, n) { const o = {}; STATIC.forEach(k => o[k] = r[k]); if (!mgrOf(r, n)) o.pw = !!r.pw; if (r.own !== n) o.ban = mgrOf(r, n) ? r.ban : []; return o; }
function rchat(r, k, n, x, f) { const m = { i: ++r.cs, k, n, x, f: f || n, t: now() }; r.chat.push(m); if (r.chat.length > 80) r.chat.splice(0, r.chat.length - 80); return m; }
function rmStale() { return Object.values(RM); }
setInterval(() => {
  const t = now();
  for (const id in RM) {
    const r = RM[id];
    for (const n in r.mem) if (t - r.mem[n] > 20000) { delete r.mem[n]; const k = r.seats.indexOf(n); if (k >= 0) r.seats[k] = null; }
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
  if (p === "room/delete") {
    if (me.role !== "kur") return send(res, 403, { err: "Yetkin yok." });
    for (const k2 in RM) if (RM[k2] === r) delete RM[k2];
    save(); return send(res, 200, {});
  }
  if (p === "room/join") {
    if (r.ban.includes(N)) return send(res, 403, { err: "ban" });
    if (r.pw && r.own !== N && !r.ok[N] && String(b.pw || "") !== r.pw) return send(res, 403, { err: "pw" });
    r.ok[N] = 1; const first = !r.mem[N]; r.mem[N] = now();
    if (r.own === N) r.seats[0] = N;
    if (first) rchat(r, "join", N);
    return send(res, 200, { room: pubRoom(r, N), seats: r.seats, mem: Object.keys(r.mem), chat: r.chat.slice(-30), seq: r.cs, rl: rlOf(r) });
  }
  if (r.ban.includes(N)) return send(res, 200, { kicked: 1 });
  if (!r.ok[N]) return send(res, 403, { err: "Önce odaya gir." });
  r.mem[N] = now();
  if (r.own === N) r.seats[0] = N;
  if (p === "room/state") {
    const since = +(q.get("since") || 0), sg = r.sig[N] || []; r.sig[N] = [];
    return send(res, 200, { room: pubRoom(r, N), seats: r.seats, mem: Object.keys(r.mem), chat: r.chat.filter(m => m.i > since), seq: r.cs, sig: sg, rl: rlOf(r) });
  }
  if (p === "room/leave") { delete r.mem[N]; const k = r.seats.indexOf(N); if (k >= 0) r.seats[k] = null; if (r.own === N) { r.seats[0] = null; if (!r.perm && !b.ph) { for (const k2 in RM) if (RM[k2] === r) delete RM[k2]; } } return send(res, 200, {}); }
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
    return send(res, 200, { users: Object.keys(DB.users).length, dir: DIR, yazilabilir: w, dosyaVar: fs.existsSync(FILE), kalici: !!VOL, bagli: (() => { try { return fs.statSync(DIR).dev !== fs.statSync("/").dev; } catch (e) { return false; } })(), volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || null, mounts: mountsList(), degiskenler: Object.keys(process.env).filter(k => /DATA|VOLUME/i.test(k)) });
  }
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  if (p === "register" && req.method === "POST") {
    if (limited(ip)) return send(res, 429, { err: "Çok fazla deneme. Biraz bekle." });
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz istek." });
    const n = String(b.u || "").trim(), pw = String(b.p || "");
    if (!NAME_RE.test(n)) return send(res, 400, { err: "Kullanıcı adı 3-12 karakter olmalı (harf, rakam, _ . -)." });
    if (pw.length < 4 || pw.length > 40) return send(res, 400, { err: "Şifre en az 4 karakter olmalı." });
    if (RESERVED.includes(key(n)) && !FOUNDERS.includes(key(n))) return send(res, 400, { err: "Bu kullanıcı adı kullanılamaz." });
    if (DB.users[key(n)]) return send(res, 409, { err: "Bu kullanıcı adı alınmış." });
    const salt = crypto.randomBytes(12).toString("hex");
    DB.users[key(n)] = { n, salt, h: hash(pw, salt), created: now(), blob: {}, last: now(), st: "Çevrimiçi", id: newId(), role: FOUNDERS.includes(key(n)) ? "kur" : "" };
    const t = newToken(key(n)); save();
    return send(res, 200, { token: t, user: n, blob: {}, ...meOf(DB.users[key(n)]) });
  }
  if (p === "login" && req.method === "POST") {
    if (limited(ip)) return send(res, 429, { err: "Çok fazla deneme. Biraz bekle." });
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz istek." });
    const u = DB.users[key(b.u || "")];
    if (!u || hash(String(b.p || ""), u.salt) !== u.h) return send(res, 401, { err: "Kullanıcı adı veya şifre hatalı." });
    const bn = banOf(u); if (bn) return send(res, 403, { err: banMsg(bn) });
    const t = newToken(key(u.n)); save();
    return send(res, 200, { token: t, user: u.n, blob: u.blob || {}, ...meOf(u) });
  }
  const a = authed(req);
  if (!a) return send(res, 401, { err: "Oturum geçersiz." });
  if (p === "me") { a.u.last = now(); return send(res, 200, { user: a.u.n, blob: a.u.blob || {}, ...meOf(a.u) }); }
  if (p === "logout") { delete DB.tokens[a.t]; a.u.last = 0; save(); return send(res, 200, {}); }
  if (p === "blob" && req.method === "POST") {
    const b = await body(req); if (!b || typeof b.blob !== "object") return send(res, 400, { err: "Geçersiz." });
    const o = {}; for (const k in b.blob) if (/^vk[a-z0-9]{1,12}$/.test(k) && typeof b.blob[k] === "string" && b.blob[k].length < 4e6) o[k] = b.blob[k];
    a.u.blob = o; save(); return send(res, 200, {});
  }
  if (p === "ping" && req.method === "POST") {
    const b = await body(req) || {};
    a.u.last = now(); a.u.st = String(b.st || "Çevrimiçi").slice(0, 30);
    return send(res, 200, meOf(a.u));
  }
  if (p === "online") {
    const t = now(), list = Object.values(DB.users).filter(u => t - (u.last || 0) < ONLINE_MS && u !== a.u).map(summary);
    return send(res, 200, { list });
  }
  if (p === "user") {
    const u = q.get("id") ? Object.values(DB.users).find(x => String(x.id) === String(q.get("id"))) : DB.users[key(q.get("n") || "")]; if (!u) return send(res, 404, { err: "Bulunamadı." });
    const out = { n: u.n, created: u.created, on: now() - (u.last || 0) < ONLINE_MS, st: u.st || "", id: u.id, role: u.role || "", ti: u.titles || [], vl: u.vl || 0 };
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
  // ---- Yönetim (yalnızca sunucu karar verir) ----
  const myR = rank(me.role);
  if (p.startsWith("admin/")) {
    if (myR < 2) return send(res, 403, { err: "Yetkin yok." });
    if (p === "admin/bans") {
      const list = Object.values(DB.users).filter(u => banOf(u)).map(u => ({ n: u.n, u: u.ban.u || 0, r: u.ban.r || "", by: u.ban.by || "" }));
      return send(res, 200, { list });
    }
    if (req.method !== "POST") return send(res, 405, { err: "Geçersiz." });
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz." });
    const t = b.id ? Object.values(DB.users).find(x => String(x.id) === String(b.id)) : DB.users[key(b.n || "")]; if (!t) return send(res, 404, { err: "Kullanıcı bulunamadı." });
    if (p === "admin/vip") {
      if (myR < 3) return send(res, 403, { err: "Yalnızca kurucu VIP verebilir." });
      const l = Math.max(0, Math.min(13, parseInt(b.l) || 0)); t.vl = l; if (!l) delete t.vl;
      save(); return send(res, 200, { n: t.n, ...meOf(t) });
    }
    if (t === me) return send(res, 403, { err: "Kendi üzerinde işlem yapamazsın." });
    if (rank(t.role) >= myR) return send(res, 403, { err: "Bu kullanıcı üzerinde yetkin yok." });
    if (p === "admin/role") {
      const r = String(b.r || ""); if (!["", "mod", "sup"].includes(r)) return send(res, 400, { err: "Geçersiz yetki." });
      if (r === "sup" && myR < 3) return send(res, 403, { err: "Süper moderatörü yalnızca kurucu atar." });
      t.role = r; save(); return send(res, 200, { n: t.n, ...meOf(t) });
    }
    if (p === "admin/title") {
      const x = String(b.t === undefined ? "" : b.t).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 20);
      t.titles = t.titles || [];
      if (x === "") t.titles = []; else { const i = t.titles.indexOf(x); if (i >= 0) t.titles.splice(i, 1); else if (t.titles.length < 8) t.titles.push(x); }
      if (!t.titles.length) delete t.titles;
      save(); return send(res, 200, { n: t.n, ...meOf(t) });
    }
    if (p === "admin/ban") {
      const ms = Math.max(0, Math.min(+b.ms || 0, 3650 * 864e5));
      t.ban = { u: ms ? now() + ms : 0, r: String(b.r || "").slice(0, 80), by: me.n };
      for (const k in DB.tokens) if (DB.tokens[k] === key(t.n)) delete DB.tokens[k];
      t.last = 0; save(); return send(res, 200, { n: t.n });
    }
    if (p === "admin/unban") { delete t.ban; save(); return send(res, 200, { n: t.n }); }
    return send(res, 404, { err: "Yok." });
  }
  // ---- Kullanıcı adı değiştirme ----
  if (p === "rename" && req.method === "POST") {
    const b = await body(req); if (!b) return send(res, 400, { err: "Geçersiz." });
    const nn = String(b.u || "").trim(), ok = key(me.n), nk = key(nn);
    if (!NAME_RE.test(nn)) return send(res, 400, { err: "Kullanıcı adı 3-12 karakter olmalı (harf, rakam, _ . -)." });
    if (nn === me.n) return send(res, 400, { err: "Bu zaten senin adın." });
    if (RESERVED.includes(nk) && !FOUNDERS.includes(nk)) return send(res, 400, { err: "Bu kullanıcı adı kullanılamaz." });
    if (nk !== ok && DB.users[nk]) return send(res, 409, { err: "Bu kullanıcı adı alınmış." });
    const wait = (me.rn || 0) + 7 * 864e5 - now();
    if (wait > 0 && myR < 3) return send(res, 429, { err: "Adını " + Math.ceil(wait / 864e5) + " gün sonra tekrar değiştirebilirsin." });
    const old = me.n, sw = x => (x === old ? nn : x), swA = l => { if (Array.isArray(l)) l.forEach((x, i) => { if (x === old) l[i] = nn; }); };
    if (nk !== ok) { delete DB.users[ok]; DB.users[nk] = me; for (const k in DB.tokens) if (DB.tokens[k] === ok) DB.tokens[k] = nk; }
    me.n = nn; me.rn = now();
    Object.values(DB.users).forEach(v => { swA(v.fl); swA(v.fin); swA(v.fout); (v.inb || []).forEach(m => { if (m.f === old) m.f = nn; }); });
    Object.values(RM).forEach(r => {
      r.own = sw(r.own); swA(r.adm); swA(r.ban); swA(r.seats);
      ["mem", "ok", "sig"].forEach(f => { if (r[f] && r[f][old] !== undefined) { r[f][nn] = r[f][old]; delete r[f][old]; } });
      r.chat.forEach(m => { m.n = sw(m.n); m.f = sw(m.f); });
    });
    save(); return send(res, 200, { token: a.t, user: nn, blob: me.blob || {}, ...meOf(me) });
  }
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
