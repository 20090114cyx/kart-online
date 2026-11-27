import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const WS_PATH = '/ws';
const MAX_PLAYERS = 2;
const HEARTBEAT_MS = 30_000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const HOST_LEFT_REASON = '房主离开了房间';
/** 生产环境静态文件目录：构建产物 dist/ */
const DIST_DIR = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist');

/**
 * @typedef {{ id: string, name: string, slot: number, ws: WebSocket }} Player
 * @typedef {{ code: string, hostId: string, state: 'lobby' | 'racing', players: Map<string, Player> }} Room
 * @typedef {{ id: string, name: string, roomCode: string | null }} Session
 */

/** @type {Map<string, Room>} */
const rooms = new Map();
/** @type {Map<WebSocket, Session>} */
const sessions = new Map();

function log(...args) {
  console.log('[room]', ...args);
}

function send(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function sendError(ws, message) {
  const session = sessions.get(ws);
  console.warn(`[room] 错误${session ? ` ${session.id}` : ''}: ${message}`);
  send(ws, { t: 'error', message });
}

function cleanName(value) {
  if (typeof value !== 'string') return '玩家';
  const name = value.trim().replace(/\s+/g, ' ');
  const clipped = Array.from(name).slice(0, 16).join('');
  return clipped || '玩家';
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const bytes = randomBytes(4);
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error('无法生成唯一房间码');
}

function makePlayerId() {
  return `p_${randomBytes(4).toString('hex')}`;
}

function playerSummaries(room) {
  return [...room.players.values()]
    .sort((a, b) => a.slot - b.slot)
    .map((player) => ({ id: player.id, name: player.name, slot: player.slot }));
}

function roomPayload(room, self) {
  return {
    t: 'room',
    code: room.code,
    selfId: self.id,
    hostId: room.hostId,
    players: playerSummaries(room),
    state: room.state,
  };
}

function broadcastRoom(room) {
  for (const player of room.players.values()) {
    send(player.ws, roomPayload(room, player));
  }
}

function getRoom(ws) {
  const session = sessions.get(ws);
  if (!session || !session.roomCode) return null;
  const room = rooms.get(session.roomCode);
  if (!room) {
    session.roomCode = null;
    return null;
  }
  return room;
}

function handleCreate(ws, name) {
  const session = sessions.get(ws);
  if (!session) return;
  if (session.roomCode) {
    sendError(ws, '已在房间中');
    return;
  }

  const room = {
    code: makeRoomCode(),
    hostId: session.id,
    state: 'lobby',
    players: new Map(),
  };
  const player = { id: session.id, name, slot: 0, ws };
  room.players.set(player.id, player);
  rooms.set(room.code, room);
  session.name = name;
  session.roomCode = room.code;

  send(ws, roomPayload(room, player));
  log(`创建房间 ${room.code}，房主 ${name} (${player.id})`);
}

function handleJoin(ws, rawCode, name) {
  const session = sessions.get(ws);
  if (!session) return;
  if (session.roomCode) {
    sendError(ws, '已在房间中');
    return;
  }

  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : '';
  const room = rooms.get(code);
  if (!room) {
    sendError(ws, '房间不存在');
    return;
  }
  if (room.state === 'racing') {
    sendError(ws, '房间已开始比赛');
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    sendError(ws, '房间已满');
    return;
  }

  const player = { id: session.id, name, slot: 1, ws };
  room.players.set(player.id, player);
  session.name = name;
  session.roomCode = room.code;

  broadcastRoom(room);
  log(`加入房间 ${room.code}，${name} (${player.id}) slot=${player.slot}`);
}

function removeFromRoom(ws) {
  const session = sessions.get(ws);
  if (!session || !session.roomCode) return false;

  const room = rooms.get(session.roomCode);
  session.roomCode = null;
  if (!room) return false;

  const player = room.players.get(session.id);
  if (!player) return false;
  room.players.delete(session.id);

  if (room.hostId === session.id) {
    for (const other of room.players.values()) {
      send(other.ws, { t: 'roomClosed', reason: HOST_LEFT_REASON });
      const otherSession = sessions.get(other.ws);
      if (otherSession) otherSession.roomCode = null;
    }
    room.players.clear();
    rooms.delete(room.code);
    log(`关闭房间 ${room.code}，房主 ${player.name} 离开`);
    return true;
  }

  const host = room.players.get(room.hostId);
  if (host) {
    send(host.ws, { t: 'peerLeft', id: player.id, name: player.name });
    broadcastRoom(room);
  }
  log(`离开房间 ${room.code}，${player.name} (${player.id})`);
  return true;
}

function handleStart(ws, trackId) {
  const room = getRoom(ws);
  const session = sessions.get(ws);
  if (!room || !session) return;
  if (session.id !== room.hostId) {
    sendError(ws, '只有房主可以开始比赛');
    return;
  }
  if (room.state === 'racing') {
    sendError(ws, '比赛已开始');
    return;
  }

  const track = typeof trackId === 'string' && trackId.length > 0 ? trackId : 'forest';
  room.state = 'racing';
  const message = {
    t: 'start',
    trackId: track,
    players: playerSummaries(room),
    hostId: room.hostId,
  };
  for (const player of room.players.values()) {
    send(player.ws, message);
  }
  log(`开始比赛 ${room.code}，赛道 ${track}`);
}

function handleInput(ws, message) {
  const room = getRoom(ws);
  const session = sessions.get(ws);
  if (!room || !session) return;
  if (session.id === room.hostId) return;
  if (!message.input || typeof message.input !== 'object') return;

  const host = room.players.get(room.hostId);
  if (!host) return;

  send(host.ws, {
    t: 'input',
    id: session.id,
    input: message.input,
    seq: message.seq,
  });
}

function handleState(ws, state) {
  const room = getRoom(ws);
  const session = sessions.get(ws);
  if (!room || !session) return;
  if (session.id !== room.hostId) {
    sendError(ws, '只有房主可以同步状态');
    return;
  }

  for (const player of room.players.values()) {
    if (player.id === room.hostId) continue;
    send(player.ws, { t: 'state', state });
  }
}

function handleRestart(ws) {
  const room = getRoom(ws);
  const session = sessions.get(ws);
  if (!room || !session) return;
  if (session.id !== room.hostId) {
    sendError(ws, '只有房主可以重开比赛');
    return;
  }

  for (const player of room.players.values()) {
    if (player.id === room.hostId) continue;
    send(player.ws, { t: 'restart' });
  }
  log(`重开比赛 ${room.code}`);
}

function handleRequestRestart(ws) {
  const room = getRoom(ws);
  const session = sessions.get(ws);
  if (!room || !session) return;
  if (session.id === room.hostId) {
    sendError(ws, '房主无需请求重开');
    return;
  }

  const host = room.players.get(room.hostId);
  if (host) send(host.ws, { t: 'requestRestart' });
}

function handleMessage(ws, raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    sendError(ws, '消息格式错误');
    return;
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    sendError(ws, '消息格式错误');
    return;
  }

  switch (message.t) {
    case 'create':
      handleCreate(ws, cleanName(message.name));
      break;
    case 'join':
      handleJoin(ws, message.code, cleanName(message.name));
      break;
    case 'leave':
      removeFromRoom(ws);
      break;
    case 'start':
      handleStart(ws, message.trackId);
      break;
    case 'input':
      handleInput(ws, message);
      break;
    case 'state':
      if (!('state' in message)) {
        sendError(ws, 'state 字段缺失');
        break;
      }
      handleState(ws, message.state);
      break;
    case 'restart':
      handleRestart(ws);
      break;
    case 'requestRestart':
      handleRequestRestart(ws);
      break;
    default:
      sendError(ws, '未知消息类型');
      break;
  }
}

// ---------------- 静态文件（生产环境单服务部署） ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

/** 解析静态文件路径，阻止 ../ 越出 dist 目录 */
function safeJoin(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = resolve(root, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function handleHttp(req, res) {
  const method = req.method || 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  let filePath = safeJoin(DIST_DIR, url.pathname);
  if (!filePath) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Bad Request');
    return;
  }

  if (url.pathname.endsWith('/')) filePath = resolve(filePath, 'index.html');

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = resolve(filePath, 'index.html');
      await stat(filePath);
    }
  } catch {
    // 无扩展名的路径回落到 index.html（前端路由），带扩展名直接 404
    if (extname(url.pathname)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    filePath = resolve(DIST_DIR, 'index.html');
    try {
      await stat(filePath);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('前端未构建：先运行 npm run build');
      return;
    }
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath).toLowerCase();
    const isHashed = filePath.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': isHashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      'content-length': data.length,
    });
    if (method === 'HEAD') res.end();
    else res.end(data);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
}

const server = createServer((req, res) => {
  void handleHttp(req, res);
});
const wss = new WebSocketServer({ server, path: WS_PATH });

server.listen(PORT, HOST, () => {
  log(`服务已启动 http://${HOST}:${PORT}（WebSocket ${WS_PATH}，静态目录 ${DIST_DIR}）`);
});

wss.on('connection', (ws) => {
  const session = { id: makePlayerId(), name: '玩家', roomCode: null };
  sessions.set(ws, session);
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      sendError(ws, '仅支持 JSON 文本消息');
      return;
    }
    handleMessage(ws, data.toString());
  });

  ws.on('close', () => {
    removeFromRoom(ws);
    sessions.delete(ws);
  });

  ws.on('error', (error) => {
    console.error(`[room] 连接错误 ${session.id}: ${error.message}`);
  });
});

wss.on('error', (error) => {
  console.error('[room] 服务器错误:', error.message);
  process.exit(1);
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_MS);

wss.on('close', () => {
  clearInterval(heartbeat);
});

function shutdown() {
  log('正在关闭服务器...');
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    ws.close(1001, 'server shutdown');
  }
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
