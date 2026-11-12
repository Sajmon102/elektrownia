const express = require('express');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { randomInt, randomUUID } = require('node:crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const questions = require('./questions');
const normalizeCode = value => typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
const lanAddresses = () => Object.entries(os.networkInterfaces())
  .sort(([a], [b]) => Number(/virtual|vethernet|vpn|docker|wsl|tunnel/i.test(a)) - Number(/virtual|vethernet|vpn|docker|wsl|tunnel/i.test(b)))
  .flatMap(([, entries]) => entries || []).filter(n => n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.254.')).map(n => n.address);

function createQuizServer(options = {}) {
  const app = express(), server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 16384 }), rooms = new Map();
  const countdownMs = options.countdownMs ?? 5000, questionMs = options.questionMs ?? 15000;
  const disconnectMs = options.disconnectMs ?? 120000;
  const publicUrl = options.publicUrl ?? process.env.PUBLIC_URL ?? '';
  if (publicUrl) {
    const u = new URL(publicUrl);
    if (!['http:', 'https:'].includes(u.protocol) || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('PUBLIC_URL musi być pełnym adresem serwera bez ścieżki, np. https://quiz.example.pl');
  }
  app.use(express.static(path.join(__dirname, 'public')));
  for (const route of ['/quiz', '/play', '/play/:code']) app.get(route, (_req, res) => res.sendFile(path.join(__dirname, 'public/player.html')));
  app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public/host.html')));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  function baseFor(socket) {
    if (publicUrl) {
      const configured = new URL(publicUrl);
      try { const origin = new URL(socket.handshake.headers.origin); if (origin.protocol === 'https:' && origin.hostname === configured.hostname) configured.protocol = 'https:'; } catch {}
      return configured.origin;
    }
    const u = new URL(socket.handshake.headers.origin || `http://${socket.handshake.headers.host}`);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Nieprawidłowy adres serwera.');
    if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) u.hostname = options.lanAddress || lanAddresses()[0] || 'localhost';
    return u.origin;
  }
  function shuffleQuestion(q) { const order = q.a.map((_, i) => i); for (let i = order.length - 1; i > 0; i--) { const j = randomInt(i + 1); [order[i], order[j]] = [order[j], order[i]]; } return { ...q, a: order.map(i => q.a[i]), correct: order.indexOf(q.correct) }; } const board = r => [...r.players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt).map((p, i) => ({ id: p.id, name: p.name, score: p.score, place: i + 1 }));
  function state(r) {
    const q = r.questions[r.questionIndex];
    return { code: r.code, status: r.status, total: questions.length, questionIndex: r.questionIndex, deadline: r.deadline, serverNow: Date.now(), hostConnected: r.hostConnected,
      players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, score: r.status === 'question' ? p.previousScore : p.score, connected: !!p.socketId, answered: r.answers.has(p.id) })),
      question: r.status === 'question' ? { q: q.q, a: q.a, index: r.questionIndex, total: questions.length } : null,
      results: r.status === 'results' ? r.results : null, leaderboard: r.status === 'finished' ? board(r) : null };
  }
  const sendState = r => io.to(r.code).emit('state', state(r));
  function destroyRoom(r, message = 'Prowadzący zamknął pokój.') {
    clearTimeout(r.timer); clearTimeout(r.hostTimer); clearTimeout(r.expiryTimer);
    io.to(r.code).emit('room:closed', { message }); io.in(r.code).socketsLeave(r.code); rooms.delete(r.code);
  }
  function closeQuestion(r) {
    if (r.status !== 'question') return;
    clearTimeout(r.timer); r.status = 'results'; r.deadline = null;
    const q = r.questions[r.questionIndex], counts = Array(q.a.length).fill(0), correctCounts = Array(q.a.length).fill(0), wrongCounts = Array(q.a.length).fill(0);
    for (const answer of r.answers.values()) { counts[answer]++; (answer === q.correct ? correctCounts : wrongCounts)[answer]++; }
    r.results = { counts, correctCounts, wrongCounts, correct: q.correct, correctText: q.a[q.correct], answers: q.a, leaderboard: board(r), questionText: q.q }; sendState(r);
  }
  function startQuestion(r) {
    r.status = 'question'; r.answers.clear();
    for (const p of r.players.values()) p.previousScore = p.score;
    r.deadline = Date.now() + questionMs; r.timer = setTimeout(() => closeQuestion(r), questionMs); sendState(r);
  }
  function owned(socket, data) {
    const r = rooms.get(normalizeCode(data.code));
    if (!r || r.host !== socket.id) throw new Error('Nie jesteś prowadzącym tego pokoju.');
    return r;
  }
  function bound(socket) {
    const r = rooms.get(socket.data.code);
    if (!r) throw new Error('Pokój nie istnieje. Dołącz ponownie.');
    return r;
  }
  io.on('connection', socket => {
    function on(event, action) {
      socket.on(event, async (data, ack) => {
        const reply = typeof ack === 'function' ? ack : () => {};
        try {
          if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Nieprawidłowe dane żądania.');
          reply(await action(data) || { ok: true });
        } catch (err) { reply({ error: err.message || 'Nie udało się wykonać operacji.' }); }
      });
    }
    on('host:create', async () => {
      if (rooms.has(socket.data.code) || socket.data.creating) throw new Error('Masz już otwarty pokój.');
      if (rooms.size >= 200) throw new Error('Serwer jest pełny. Spróbuj później.');
      socket.data.creating = true;
      let r;
      try {
        let code;
        do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
        const base = baseFor(socket);
        r = { code, token: randomUUID(), host: socket.id, hostConnected: true, players: new Map(), questions: questions.map(shuffleQuestion), status: 'lobby', questionIndex: -1, answers: new Map(), deadline: null, joinUrl: `${base}/play/${code}`, entryUrl: base };
        rooms.set(code, r); r.qr = await QRCode.toDataURL(r.joinUrl, { width: 280, margin: 2 });
        if (!socket.connected) throw new Error('Utracono połączenie.');
        socket.data.code = code; socket.join(code);
        r.expiryTimer = setTimeout(() => destroyRoom(r, 'Pokój wygasł. Utwórz nowy quiz.'), options.roomLifetimeMs ?? 21600000);
        sendState(r); return hostReply(r);
      } catch (err) { if (r) rooms.delete(r.code); throw err; }
      finally { socket.data.creating = false; }
    });
    function hostReply(r) { return { ok: true, code: r.code, token: r.token, qr: r.qr, joinUrl: r.joinUrl, entryUrl: r.entryUrl, state: state(r) }; }
    on('host:resume', data => {
      const r = rooms.get(normalizeCode(data.code));
      if (!r || r.token !== data.token) throw new Error('Nie można przywrócić pokoju. Utwórz nowy quiz.');
      if (rooms.has(socket.data.code) && socket.data.code !== r.code) throw new Error('Masz już inny pokój.');
      if (r.hostConnected && r.host !== socket.id) throw new Error('Prowadzący jest już połączony w innej karcie.');
      clearTimeout(r.hostTimer); r.host = socket.id; r.hostConnected = true;
      socket.data.code = r.code; socket.join(r.code); sendState(r); return hostReply(r);
    });
    on('player:join', data => {
      const code = normalizeCode(data.code);
      if (!/^\d{6}$/.test(code)) throw new Error('Wpisz sześciocyfrowy kod, np. 678-595.');
      const r = rooms.get(code);
      if (!r) throw new Error('Nie znaleziono pokoju. Sprawdź kod i adres serwera.');
      if (rooms.has(socket.data.code) && (socket.data.code !== code || !socket.data.playerId)) throw new Error('Jesteś już w innym pokoju lub prowadzisz quiz.');
      let p = data.token && [...r.players.values()].find(p => p.token === data.token);
      if (p && p.socketId && p.socketId !== socket.id) throw new Error('Ten gracz jest już połączony w innej karcie.');
      if (!p) {
        if (socket.data.playerId && r.players.has(socket.data.playerId)) throw new Error('Już dołączyłeś do quizu.');
        if (r.status !== 'lobby') throw new Error('Quiz już się rozpoczął.');
        const name = typeof data.name === 'string' ? data.name.trim().slice(0, 18) : '';
        if (!name) throw new Error('Wpisz swoje imię.');
        if (r.players.size >= 200) throw new Error('Pokój jest pełny.');
        p = { id: randomUUID(), token: randomUUID(), name, score: 0, previousScore: 0, joinedAt: Date.now() }; r.players.set(p.id, p);
      }
      p.socketId = socket.id; socket.data.code = code; socket.data.playerId = p.id; socket.join(code); sendState(r);
      return { ok: true, code, id: p.id, token: p.token, name: p.name, state: state(r) };
    });
    on('player:leave', () => {
      const r = bound(socket), p = r.players.get(socket.data.playerId);
      if (!p || p.socketId !== socket.id) throw new Error('Nie jesteś graczem tego pokoju.');
      if (r.status === 'lobby') r.players.delete(p.id); else p.socketId = null;
      socket.leave(r.code); delete socket.data.code; delete socket.data.playerId; sendState(r);
    });
    on('host:start', data => {
      const r = owned(socket, data);
      if (r.status !== 'lobby') throw new Error('Quiz już się rozpoczął.');
      if (![...r.players.values()].some(p => p.socketId)) throw new Error('Poczekaj, aż dołączą uczniowie.');
      r.status = 'countdown'; r.questionIndex = 0; r.deadline = Date.now() + countdownMs;
      r.timer = setTimeout(() => startQuestion(r), countdownMs); sendState(r);
    });
    on('player:answer', data => {
      const r = bound(socket), p = r.players.get(socket.data.playerId);
      if (!p || p.socketId !== socket.id || r.status !== 'question' || r.answers.has(p.id)) throw new Error('Nie można już wysłać odpowiedzi.');
      if (Date.now() >= r.deadline) { closeQuestion(r); throw new Error('Czas na odpowiedź minął.'); }
      if (!Number.isInteger(data.answer) || data.answer < 0 || data.answer >= r.questions[r.questionIndex].a.length) throw new Error('Nieprawidłowa odpowiedź.');
      if (data.questionIndex !== r.questionIndex) throw new Error('To odpowiedź do poprzedniego pytania.');
      r.answers.set(p.id, data.answer);
      if (data.answer === r.questions[r.questionIndex].correct) p.score += Math.max(0, Math.ceil(1000 * (r.deadline - Date.now()) / questionMs));
      if (r.answers.size === r.players.size) closeQuestion(r); else sendState(r);
    });
    on('host:close-question', data => {
      const r = owned(socket, data);
      if (r.status !== 'question') throw new Error('Nie ma aktywnego pytania.');
      closeQuestion(r);
    });
    on('host:next', data => {
      const r = owned(socket, data);
      if (r.status !== 'results' || data.questionIndex !== r.questionIndex) throw new Error('Nie można przejść dalej.');
      r.questionIndex++;
      if (r.questionIndex >= questions.length) { r.status = 'finished'; r.deadline = null; sendState(r); } else startQuestion(r);
    });
    on('host:end', data => { destroyRoom(owned(socket, data)); });
    on('player:reaction', data => {
      const r = bound(socket), p = r.players.get(socket.data.playerId);
      if (!p || p.socketId !== socket.id || !['👏', '😂', '❤️', '😮', '🔥', '🎉'].includes(data.emoji)) return;
      if (Date.now() - (p.lastReaction || 0) < 700) return;
      p.lastReaction = Date.now(); io.to(r.host).emit('reaction', { emoji: data.emoji, name: p.name });
    });
    socket.on('disconnect', () => {
      const r = rooms.get(socket.data.code);
      if (!r) return;
      const p = r.players.get(socket.data.playerId);
      if (p?.socketId === socket.id) p.socketId = null;
      if (r.host === socket.id) { r.hostConnected = false; r.hostTimer = setTimeout(() => destroyRoom(r, 'Prowadzący nie wrócił do quizu. Pokój został zamknięty.'), disconnectMs); }
      sendState(r);
    });
  });
  return { app, server, io, rooms, async close() {
    for (const r of [...rooms.values()]) destroyRoom(r);
    await new Promise(resolve => io.close(resolve));
  } };
}
if (require.main === module) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT musi być liczbą od 1 do 65535.');
    const quiz = createQuizServer();
    quiz.server.on('error', err => { console.error(err.code === 'EADDRINUSE' ? `Port ${port} jest zajęty. Zamknij poprzedni serwer lub ustaw inny PORT.` : err.message); process.exitCode = 1; });
    quiz.server.listen(port, '0.0.0.0', () => {
      console.log(`Panel prowadzącego: http://localhost:${port}/host`);
      for (const ip of lanAddresses()) console.log(`Uczniowie w tej samej sieci Wi-Fi: http://${ip}:${port}`);
      if (process.env.PUBLIC_URL) console.log(`Adres publiczny: ${process.env.PUBLIC_URL}`);
      console.log('Nie zamykaj tego okna podczas quizu. Kod i QR pojawią się po utworzeniu pokoju.');
    });
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
module.exports = { createQuizServer, normalizeCode };
