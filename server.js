'use strict';
/* 블록 던전: 시프트의 균열 — 멀티플레이 서버
 * - 같은 주소에서 게임(public/index.html)을 제공하고 /ws 로 WebSocket 방 중계를 합니다.
 * - 방장(호스트)의 브라우저가 몬스터·퀘스트·스토리를 계산하고, 서버는 메시지를 전달만 합니다.
 * - 한 방에 최대 4명.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 4;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/rooms') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(roomList())); return; }
  let file = path.normalize(path.join(PUBLIC, url === '/' ? 'index.html' : url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('없는 페이지입니다'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
const rooms = new Map(); // code -> {code, hostId, players: Map(id -> client), lv, created}
let nextId = 1;

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; if (!rooms.has(c)) return c; }
}
function cleanName(n) { n = String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 12); return n || '모험가'; }
function send(c, obj) { if (c.ws.readyState === 1) c.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function roomList() {
  return [...rooms.values()].map(r => ({ code: r.code, host: (r.players.get(r.hostId) || {}).name || '?', n: r.players.size, max: MAX_PLAYERS, lv: r.lv || '' }));
}
function playerInfo(c) { return { id: c.id, name: c.name, char: c.char | 0 }; }

function leaveRoom(c, reason) {
  const r = c.room && rooms.get(c.room);
  c.room = null;
  if (!r) return;
  r.players.delete(c.id);
  if (r.hostId === c.id) {
    for (const o of r.players.values()) { o.room = null; send(o, { t: 'closed', reason: reason || '방장이 방을 나갔습니다.' }); }
    rooms.delete(r.code);
  } else {
    for (const o of r.players.values()) send(o, { t: 'peer-', id: c.id, name: c.name });
  }
}

wss.on('connection', ws => {
  const c = { ws, id: nextId++, name: '모험가', char: 0, room: null };
  send(c, { t: 'hi', id: c.id });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    const r = c.room && rooms.get(c.room);
    switch (m.t) {
      case 'relay': {
        if (!r) return;
        const out = JSON.stringify({ t: 'relay', from: c.id, d: m.d });
        if (m.to === 'all') { for (const o of r.players.values()) if (o !== c) send(o, out); }
        else if (m.to === 'host') { const h = r.players.get(r.hostId); if (h && h !== c) send(h, out); }
        else { const o = r.players.get(m.to | 0); if (o && o !== c) send(o, out); }
        return;
      }
      case 'list': send(c, { t: 'rooms', rooms: roomList() }); return;
      case 'name': c.name = cleanName(m.name); return;
      case 'create': {
        leaveRoom(c);
        c.name = cleanName(m.name); c.char = m.char | 0;
        const code = makeCode();
        rooms.set(code, { code, hostId: c.id, players: new Map([[c.id, c]]), lv: m.lv || '', created: Date.now() });
        c.room = code;
        send(c, { t: 'created', code, id: c.id });
        return;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().trim();
        const room = rooms.get(code);
        if (!room) { send(c, { t: 'err', msg: '방을 찾을 수 없습니다. 코드를 확인해 주세요.' }); return; }
        if (room.players.size >= MAX_PLAYERS && !room.players.has(c.id)) { send(c, { t: 'err', msg: '방이 가득 찼습니다. (최대 ' + MAX_PLAYERS + '명)' }); return; }
        leaveRoom(c);
        c.name = cleanName(m.name); c.char = m.char | 0;
        room.players.set(c.id, c); c.room = code;
        send(c, { t: 'joined', code, id: c.id, hostId: room.hostId, players: [...room.players.values()].map(playerInfo) });
        for (const o of room.players.values()) if (o !== c) send(o, { t: 'peer+', p: playerInfo(c) });
        return;
      }
      case 'info': { if (r && r.hostId === c.id) r.lv = String(m.lv || '').slice(0, 40); if (m.char != null) c.char = m.char | 0; return; }
      case 'leave': leaveRoom(c); send(c, { t: 'left' }); return;
      case 'ping': send(c, { t: 'pong', ts: m.ts }); return;
    }
  });
  ws.on('close', () => leaveRoom(c, '방장의 연결이 끊어졌습니다.'));
  ws.on('error', () => {});
});

// Render 등 프록시가 유휴 연결을 끊지 않도록 주기적으로 핑
const beat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws._dead) { ws.terminate(); continue; }
    ws._dead = true; ws.ping();
  }
}, 25000);
wss.on('connection', ws => ws.on('pong', () => { ws._dead = false; }));
wss.on('close', () => clearInterval(beat));

server.listen(PORT, () => console.log('블록 던전 멀티플레이 서버 실행 중: http://localhost:' + PORT));
