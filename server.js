const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

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
      id: p.id, name: p.name, alive: p.alive, isHost: p.id === room.hostId,
      isMe: p.id === viewerId,
      role: (room.phase === "ended" || p.id === viewerId) ? p.role : null
    })),
    myRole: viewer?.role || null,
    myAlive: viewer?.alive ?? true,
    myId: viewerId,
    nightResult: viewer?.privateMessage || null,
    winner: room.winner || null,
    canStart: viewerId === room.hostId && room.phase === "lobby" && room.players.size >= MIN_PLAYERS
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
    events: [], nightVotes: new Map(), dayVotes: new Map(), winner: null
  };
  rooms.set(roomCode, room);
  addPlayer(room, socket, name);
  return room;
}
function addPlayer(room, socket, name) {
  const player = { id: socket.id, name: cleanName(name), alive: true, role: null, privateMessage: null };
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
function beginNight(room) {
  room.phase = "night";
  room.round += 1;
  room.message = `Gece ${room.round}: Vampirler hedef seçiyor, kâhin araştırma yapabilir.`;
  room.nightVotes.clear();
  room.dayVotes.clear();
  for (const p of room.players.values()) p.privateMessage = null;
  say(room, `🌙 Gece ${room.round} başladı.`);
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
  socket.on("startGame", () => {
    const room = findRoomFor(socket);
    if (!room || room.hostId !== socket.id || room.phase !== "lobby") return;
    if (room.players.size < MIN_PLAYERS) return socket.emit("toast", "Başlamak için en az 5 oyuncu gerekli.");
    const list = [...room.players.values()];
    let roles = ["Vampir"];
    if (list.length >= 6) roles.push("Vampir");
    if (list.length >= 8) roles.push("Vampir");
    roles.push("Kâhin");
    while (roles.length < list.length) roles.push("Köylü");
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
