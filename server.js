const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

// Basic account registration/login. For durable accounts across redeploys, connect a database.
const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const accounts = new Map();
const sessions = new Map();
const GAME_MASTER_USERNAME = String(process.env.GAME_MASTER_USERNAME || "spenctied").trim().toLowerCase();
const GAME_MASTER_PASSWORD = String(process.env.GAME_MASTER_PASSWORD || "");
try { for (const a of JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"))) accounts.set(a.username, a); } catch (_) {}
function saveAccounts() { try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([...accounts.values()], null, 2)); } catch (e) { console.error("Account save failed", e.message); } }
function normUser(v) { return String(v || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24); }
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64).toString("hex"); }
function safeAccount(a) { return { username: a.username, role: a.role || "player" }; }
app.use(express.json({limit:"20kb"}));
app.post("/api/register", (req,res) => {
  const username = normUser(req.body?.username); const password = String(req.body?.password || "");
  if (username.length < 3) return res.status(400).json({error:"Kullanıcı adı en az 3 karakter olmalı."});
  if (password.length < 8 || password.length > 128) return res.status(400).json({error:"Şifre 8-128 karakter olmalı."});
  if (accounts.has(username)) return res.status(409).json({error:"Bu kullanıcı adı kayıtlı. Giriş yap."});
  let role = "player";
  if (username === GAME_MASTER_USERNAME) {
    if (!GAME_MASTER_PASSWORD || password !== GAME_MASTER_PASSWORD) return res.status(403).json({error:"Bu kullanıcı adı Game Master için ayrılmış. Render ayarındaki Game Master şifresini kullan."});
    role = "gameMaster";
  }
  const salt = crypto.randomBytes(16).toString("hex");
  accounts.set(username,{username,salt,hash:passwordHash(password,salt),role,createdAt:Date.now()}); saveAccounts();
  const token = crypto.randomBytes(32).toString("hex"); sessions.set(token, username);
  res.json({token,account:safeAccount(accounts.get(username))});
});
app.post("/api/login", (req,res) => {
  const username = normUser(req.body?.username); const password = String(req.body?.password || ""); const a = accounts.get(username);
  if (!a || !password || passwordHash(password,a.salt) !== a.hash) return res.status(401).json({error:"Kullanıcı adı veya şifre yanlış."});
  // The configured Game Master identity is always privileged, but only after password verification.
  if (username === GAME_MASTER_USERNAME && GAME_MASTER_PASSWORD && password === GAME_MASTER_PASSWORD) a.role = "gameMaster";
  const token = crypto.randomBytes(32).toString("hex"); sessions.set(token, username);
  res.json({token,account:safeAccount(a)});
});
app.post("/api/logout", (req,res) => { const token=String(req.headers.authorization||"").replace(/^Bearer\s+/i,""); sessions.delete(token); res.json({ok:true}); });
io.use((socket,next)=>{ const token=String(socket.handshake.auth?.token||""); const username=sessions.get(token); const account=username&&accounts.get(username); if(!account) return next(new Error("Giriş gerekli")); socket.data.account=safeAccount(account); socket.data.token=token; next(); });


const rooms = new Map();
const MAX_PLAYERS = 12;
const MIN_PLAYERS = 5;

function code() {
  return crypto.randomBytes(3).toString("hex").slice(0, 4).toUpperCase();
}
function cleanName(name) {
  return String(name || "Oyuncu").trim().replace(/[<>]/g, "").slice(0, 18) || "Oyuncu";
}
function publicRoom(room, viewerId) {
  const viewer = room.players.get(viewerId);
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    message: room.message,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, alive: p.alive, isHost: p.id === room.hostId, accountRole: p.accountRole,
      isMe: p.id === viewerId,
      role: (room.phase === "ended" || p.id === viewerId) ? p.role : null,
      isBot: !!p.isBot
    })),
    myRole: viewer?.role || null,
    myAlive: viewer?.alive ?? true,
    myId: viewerId,
    nightResult: viewer?.privateMessage || null,
    winner: room.winner || null,
    settings: room.settings,
    chat: room.chat.slice(-60),
    canStart: viewerId === room.hostId && room.phase === "lobby" && room.players.size >= MIN_PLAYERS,
    myAccount: viewer ? { username: viewer.username, role: viewer.accountRole } : null,
    isGameMaster: viewer?.accountRole === "gameMaster"
  };
}
function emitRoom(room) {
  for (const p of room.players.values()) {
    io.to(p.id).emit("state", publicRoom(room, p.id));
  }
}
function say(room, message) {
  room.events.unshift({ at: Date.now(), message: String(message).slice(0, 250) });
  room.events = room.events.slice(0, 35);
  io.to(room.code).emit("events", room.events);
}
function makeRoom(socket, name) {
  let roomCode;
  do { roomCode = code(); } while (rooms.has(roomCode));
  const room = {
    code: roomCode, hostId: socket.id, players: new Map(), phase: "lobby",
    round: 0, message: "Oyuncular bekleniyor. En az 5 kişiyle oyun başlayabilir.",
    events: [], nightVotes: new Map(), dayVotes: new Map(), winner: null,
    settings: { vampires: 1, seer: true, bots: 0 }, chat: []
  };
  rooms.set(roomCode, room);
  addPlayer(room, socket, name);
  return room;
}
function addPlayer(room, socket, name) {
  const account = socket.data.account || {username:"guest",role:"player"};
  const player = { id: socket.id, username: account.username, accountRole: account.role, name: cleanName(name || account.username), alive: true, role: null, privateMessage: null, muted: false };
  room.players.set(socket.id, player);
  socket.join(room.code);
  if (!room.hostId) room.hostId = socket.id;
  say(room, `${player.name} köye katıldı.`);
  emitRoom(room);
}
function findRoomFor(socket) {
  for (const room of rooms.values()) if (room.players.has(socket.id)) return room;
  return null;
}
function alive(room) { return [...room.players.values()].filter(p => p.alive); }
function endIfNeeded(room) {
  const live = alive(room);
  const vampires = live.filter(p => p.role === "Vampir").length;
  const others = live.length - vampires;
  if (vampires === 0) {
    room.phase = "ended"; room.winner = "Köylüler"; room.message = "Bütün vampirler bulundu. Köylüler kazandı!"; say(room, "🏆 Köylüler kazandı!");
    return true;
  }
  if (vampires >= others) {
    room.phase = "ended"; room.winner = "Vampirler"; room.message = "Vampirler köyde üstünlüğü ele geçirdi!"; say(room, "🧛 Vampirler kazandı!");
    return true;
  }
  return false;
}
function syncBots(room, wantedCount) {
  const current = [...room.players.values()].filter(p => p.isBot);
  for (const bot of current) {
    if (current.indexOf(bot) >= wantedCount) room.players.delete(bot.id);
  }
  const remaining = [...room.players.values()].filter(p => p.isBot).length;
  const names = ["Bot Ada", "Bot Bora", "Bot Ceren", "Bot Deniz", "Bot Efe", "Bot Fırtına", "Bot Gölge", "Bot Hayalet", "Bot Işık", "Bot Karanlık", "Bot Luna"];
  for (let i = remaining; i < wantedCount && room.players.size < MAX_PLAYERS; i++) {
    const id = `bot-${crypto.randomBytes(8).toString("hex")}`;
    const name = names[i % names.length];
    room.players.set(id, { id, username: `testbot${i+1}`, accountRole: "player", name, alive: true, role: null, privateMessage: null, muted: false, isBot: true });
  }
  room.settings.bots = [...room.players.values()].filter(p => p.isBot).length;
}
function randomChoice(list) { return list.length ? list[Math.floor(Math.random() * list.length)] : null; }
function botsNightActions(room) {
  const living = alive(room);
  for (const bot of living.filter(p => p.isBot && p.role === "Vampir")) {
    const targets = living.filter(p => p.role !== "Vampir");
    const target = randomChoice(targets);
    if (target) room.nightVotes.set(bot.id, target.id);
  }
  for (const bot of living.filter(p => p.isBot && p.role === "Kâhin")) {
    const target = randomChoice(living.filter(p => p.id !== bot.id));
    if (target) bot.privateMessage = `${target.name}: ${target.role === "Vampir" ? "VAMPİR" : "Vampir değil"}`;
  }
}
function botsDayVotes(room) {
  const living = alive(room);
  for (const bot of living.filter(p => p.isBot)) {
    const target = randomChoice(living.filter(p => p.id !== bot.id && !(p.role === "Vampir" && bot.role === "Vampir")));
    if (target) room.dayVotes.set(bot.id, target.id);
  }
}

function beginNight(room) {
  room.phase = "night";
  room.round += 1;
  room.message = `Gece ${room.round}: Vampirler hedef seçiyor, kâhin araştırma yapabilir.`;
  room.nightVotes.clear();
  room.dayVotes.clear();
  for (const p of room.players.values()) p.privateMessage = null;
  say(room, `🌙 Gece ${room.round} başladı.`);
  botsNightActions(room);
  if (alive(room).filter(p => p.role === "Vampir").every(p => room.nightVotes.has(p.id))) { finishNight(room); return; }
  emitRoom(room);
}
function finishNight(room) {
  if (room.phase !== "night") return;
  const vamps = alive(room).filter(p => p.role === "Vampir");
  const tally = new Map();
  for (const [voter, target] of room.nightVotes) {
    if (vamps.some(v => v.id === voter) && room.players.get(target)?.alive && room.players.get(target)?.role !== "Vampir") {
      tally.set(target, (tally.get(target) || 0) + 1);
    }
  }
  let victim = null, max = 0;
  for (const [target, count] of tally) if (count > max) { victim = target; max = count; }
  if (!victim && vamps.length) {
    const candidates = alive(room).filter(p => p.role !== "Vampir");
    if (candidates.length) victim = candidates[Math.floor(Math.random() * candidates.length)].id;
  }
  if (victim) {
    const p = room.players.get(victim); p.alive = false;
    say(room, `☠️ Sabah oldu. ${p.name} gece öldürüldü. Rolü: ${p.role}.`);
  } else say(room, "☀️ Sabah oldu. Bu gece kimse ölmedi.");
  if (endIfNeeded(room)) { emitRoom(room); return; }
  room.phase = "day";
  room.message = "Gündüz: Tartışın ve oylamayla şüphelendiğiniz kişiyi köyden gönderin.";
  room.dayVotes.clear();
  say(room, "☀️ Gündüz başladı. Oylama zamanı!");
  botsDayVotes(room);
  if (alive(room).every(p => room.dayVotes.has(p.id))) { finishDay(room); return; }
  emitRoom(room);
}
function finishDay(room) {
  if (room.phase !== "day") return;
  const eligible = alive(room);
  const tally = new Map();
  for (const [voter, target] of room.dayVotes) {
    if (eligible.some(p => p.id === voter) && eligible.some(p => p.id === target) && voter !== target) {
      tally.set(target, (tally.get(target) || 0) + 1);
    }
  }
  if (tally.size) {
    let max = Math.max(...tally.values());
    let leaders = [...tally].filter(([, count]) => count === max).map(([id]) => id);
    if (leaders.length === 1) {
      const out = room.players.get(leaders[0]); out.alive = false;
      say(room, `⚖️ ${out.name} oylamayla köyden gönderildi. Rolü: ${out.role}.`);
    } else say(room, "⚖️ Oylama berabere bitti. Kimse köyden gönderilmedi.");
  } else say(room, "⚖️ Yeterli oy gelmedi. Kimse köyden gönderilmedi.");
  if (!endIfNeeded(room)) beginNight(room);
  emitRoom(room);
}

io.on("connection", socket => {
  socket.on("adminGetUsers", () => {
    if (socket.data.account?.role !== "gameMaster") return socket.emit("toast", "Bu işlem yalnızca Game Master için.");
    socket.emit("adminUsers", [...accounts.values()].map(a => ({ username: a.username, role: a.role || "player", createdAt: a.createdAt || null })));
  });
  socket.on("adminSetRole", ({ username, role } = {}) => {
    if (socket.data.account?.role !== "gameMaster") return socket.emit("toast", "Bu işlem yalnızca Game Master için.");
    const key = normUser(username);
    const account = accounts.get(key);
    if (!account) return socket.emit("toast", "Kullanıcı bulunamadı.");
    if (key === GAME_MASTER_USERNAME) return socket.emit("toast", "Game Master hesabının yetkisi değiştirilemez.");
    if (!["player", "moderator"].includes(role)) return socket.emit("toast", "Geçersiz yetki.");
    account.role = role;
    saveAccounts();
    // Update role on active authenticated sockets too.
    for (const client of io.sockets.sockets.values()) {
      if (client.data.account?.username === key) client.data.account.role = role;
    }
    socket.emit("toast", `@${key} yetkisi güncellendi.`);
    socket.emit("adminUsers", [...accounts.values()].map(a => ({ username: a.username, role: a.role || "player", createdAt: a.createdAt || null })));
  });
  socket.on("adminGetRooms", () => {
    if (socket.data.account?.role !== "gameMaster") return socket.emit("toast", "Bu işlem yalnızca Game Master için.");
    socket.emit("adminRooms", [...rooms.values()].map(r=>({code:r.code,phase:r.phase,hostId:r.hostId,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,username:p.username,role:p.role,alive:p.alive}))})));
  });
  socket.on("adminKick", ({roomCode, playerId}={}) => {
    if (socket.data.account?.role !== "gameMaster") return socket.emit("toast", "Yetkin yok.");
    const room=rooms.get(String(roomCode||"").toUpperCase()); const target=room?.players.get(playerId);
    if(!room||!target) return socket.emit("toast","Oda veya oyuncu bulunamadı.");
    const targetSocket=io.sockets.sockets.get(playerId); if(targetSocket) targetSocket.emit("toast","Game Master tarafından odadan çıkarıldın.");
    room.players.delete(playerId); if(targetSocket){targetSocket.leave(room.code); targetSocket.disconnect(true);}
    say(room, `🛡️ ${target.name} Game Master tarafından odadan çıkarıldı.`);
    if(!room.players.size) rooms.delete(room.code); else { if(room.hostId===playerId) room.hostId=room.players.keys().next().value; emitRoom(room); }
    socket.emit("toast","Oyuncu odadan çıkarıldı."); socket.emit("adminRooms",[...rooms.values()].map(r=>({code:r.code,phase:r.phase,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,username:p.username,role:p.role,alive:p.alive}))})));
  });
  socket.on("adminCloseRoom", ({roomCode}={}) => {
    if (socket.data.account?.role !== "gameMaster") return socket.emit("toast", "Yetkin yok.");
    const key=String(roomCode||"").toUpperCase(), room=rooms.get(key); if(!room) return socket.emit("toast","Oda bulunamadı.");
    for(const p of room.players.values()){ const s=io.sockets.sockets.get(p.id); if(s){s.emit("toast","Oda Game Master tarafından kapatıldı.");s.disconnect(true);} }
    rooms.delete(key); socket.emit("toast","Oda kapatıldı."); socket.emit("adminRooms",[...rooms.values()].map(r=>({code:r.code,phase:r.phase,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,username:p.username,role:p.role,alive:p.alive}))})));
  });
  socket.on("createRoom", ({ name } = {}, cb = () => {}) => {
    if (findRoomFor(socket)) return cb({ ok: false, error: "Zaten bir odadasın." });
    const room = makeRoom(socket, name);
    cb({ ok: true, code: room.code });
  });
  socket.on("joinRoom", ({ name, code: rawCode } = {}, cb = () => {}) => {
    if (findRoomFor(socket)) return cb({ ok: false, error: "Önce bulunduğun odadan ayrıl." });
    const roomCode = String(rawCode || "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return cb({ ok: false, error: "Bu oda bulunamadı. Oda kodunu kontrol et." });
    if (room.phase !== "lobby") return cb({ ok: false, error: "Bu oyun başlamış." });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: "Oda dolu (en fazla 12 oyuncu)." });
    addPlayer(room, socket, name);
    cb({ ok: true, code: room.code });
  });
  socket.on("updateSettings", (settings = {}) => {
    const room = findRoomFor(socket);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    const requestedBots = Math.max(0, Math.min(7, Math.floor(Number(settings.bots) || 0)));
    syncBots(room, requestedBots);
    const maxVampires = Math.max(1, Math.min(3, Math.floor(Number(settings.vampires) || 1)));
    room.settings = { vampires: Math.min(maxVampires, Math.max(1, room.players.size - 2)), seer: settings.seer !== false, bots: requestedBots };
    say(room, `⚙️ Oyun ayarları güncellendi. Test botu: ${requestedBots}.`);
    emitRoom(room);
  });
  socket.on("chatMessage", ({ message } = {}) => {
    const room = findRoomFor(socket);
    const player = room?.players.get(socket.id);
    if (!room || !player || !String(message || "").trim()) return;
    if (room.phase !== "lobby" && !player.alive && room.phase !== "ended") {
      return socket.emit("toast", "Elendiğin için sohbet edemezsin.");
    }
    const text = String(message).replace(/[<>]/g, "").trim().slice(0, 300);
    const item = { id: crypto.randomBytes(5).toString("hex"), name: player.name, playerId: player.id, message: text, at: Date.now() };
    room.chat.push(item);
    room.chat = room.chat.slice(-100);
    io.to(room.code).emit("chatMessage", item);
    emitRoom(room);
  });
  socket.on("voiceSignal", ({ targetId, data } = {}) => {
    const room = findRoomFor(socket);
    if (!room || !room.players.has(targetId) || !data) return;
    io.to(targetId).emit("voiceSignal", { from: socket.id, data });
  });
  socket.on("startGame", () => {
    const room = findRoomFor(socket);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    if (room.players.size < MIN_PLAYERS) return socket.emit("toast", "Başlamak için en az 5 oyuncu gerekli.");
    const list = [...room.players.values()];
    let roles = Array(room.settings.vampires).fill("Vampir");
    if (room.settings.seer) roles.push("Kâhin");
    while (roles.length < list.length) roles.push("Köylü");
    roles = roles.slice(0, list.length);
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    list.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.privateMessage = null; });
    say(room, "🎭 Roller dağıtıldı. Kimliğini yalnızca sen görebilirsin.");
    beginNight(room);
  });
  socket.on("nightAction", ({ targetId, action } = {}) => {
    const room = findRoomFor(socket);
    const player = room?.players.get(socket.id);
    const target = room?.players.get(targetId);
    if (!room || room.phase !== "night" || !player?.alive || !target?.alive || target.id === player.id) return;
    if (player.role === "Vampir" && action === "kill" && target.role !== "Vampir") {
      room.nightVotes.set(player.id, target.id);
      player.privateMessage = `Hedef seçildi: ${target.name}.`;
      socket.emit("toast", player.privateMessage);
      if (alive(room).filter(p => p.role === "Vampir").every(p => room.nightVotes.has(p.id))) finishNight(room);
      else emitRoom(room);
    } else if (player.role === "Kâhin" && action === "inspect") {
      player.privateMessage = `${target.name}: ${target.role === "Vampir" ? "VAMPİR 🧛" : "Vampir değil 🧑‍🌾"}`;
      socket.emit("toast", `🔮 Araştırma sonucu — ${player.privateMessage}`);
      emitRoom(room);
    } else socket.emit("toast", "Bu rol bu işlemi yapamaz.");
  });
  socket.on("vote", ({ targetId } = {}) => {
    const room = findRoomFor(socket);
    const player = room?.players.get(socket.id);
    const target = room?.players.get(targetId);
    if (!room || room.phase !== "day" || !player?.alive || !target?.alive || target.id === player.id) return;
    room.dayVotes.set(player.id, target.id);
    socket.emit("toast", `Oyun kaydedildi: ${target.name}`);
    say(room, `${player.name} oyunu kullandı.`);
    const live = alive(room);
    if (live.every(p => room.dayVotes.has(p.id))) finishDay(room);
    else emitRoom(room);
  });
  socket.on("skipVote", () => {
    const room = findRoomFor(socket);
    if (!room || room.phase !== "day") return;
    const p = room.players.get(socket.id);
    if (!p?.alive) return;
    room.dayVotes.set(socket.id, "SKIP");
    if (alive(room).every(x => room.dayVotes.has(x.id))) finishDay(room);
    else emitRoom(room);
  });
  socket.on("leaveRoom", () => {
    const room = findRoomFor(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) say(room, `${p.name} oyundan ayrıldı.`);
    room.players.delete(socket.id);
    socket.leave(room.code);
    if (!room.players.size) rooms.delete(room.code);
    else {
      if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
      if (room.phase === "night" || room.phase === "day") {
        if (room.phase === "night" && alive(room).filter(x => x.role === "Vampir").every(x => room.nightVotes.has(x.id))) finishNight(room);
        if (room.phase === "day" && alive(room).every(x => room.dayVotes.has(x.id))) finishDay(room);
      }
      emitRoom(room);
    }
  });
  socket.on("disconnect", () => {
    const room = findRoomFor(socket);
    if (!room) return;
    const p = room.players.get(socket.id);
    if (p) say(room, `${p.name} bağlantıyı kaybetti.`);
    room.players.delete(socket.id);
    if (!room.players.size) rooms.delete(room.code);
    else {
      if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
      emitRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Vampir Köylü online server ${PORT} portunda hazır`));
