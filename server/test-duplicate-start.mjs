import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:8787/ws';

function open() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function waitFor(ws, type, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    function onMsg(raw) {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t !== type) return;
      clearTimeout(timer);
      ws.off('message', onMsg);
      resolve(msg);
    }
    ws.on('message', onMsg);
  });
}

const host = await open();
const guest = await open();
let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}  -- ${detail}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}  -- ${detail}`);
  }
}

// 先挂监听再发消息，避免广播比监听器先到
const created = waitFor(host, 'room');
host.send(JSON.stringify({ t: 'create', name: '房主' }));
const room = await created;

const guestJoined = waitFor(guest, 'room');
const hostSeesJoin = waitFor(host, 'room');
guest.send(JSON.stringify({ t: 'join', code: room.code, name: '客机' }));
await guestJoined;
const roomAfterJoin = await hostSeesJoin;
check('两人在房间', roomAfterJoin.players.length === 2, `players=${roomAfterJoin.players.length}`);

const hostStart = waitFor(host, 'start');
const guestStart = waitFor(guest, 'start');
host.send(JSON.stringify({ t: 'start', trackId: 'forest' }));
await hostStart;
await guestStart;
check('首次 start 成功', true, '双方收到 start');

// 首次 start 之后再挂监听，只统计「第二次」
let extraStart = false;
guest.on('message', (raw) => {
  try {
    if (JSON.parse(String(raw)).t === 'start') extraStart = true;
  } catch {
    /* ignore */
  }
});

const rejected = waitFor(host, 'error');
host.send(JSON.stringify({ t: 'start', trackId: 'forest' }));
const err = await rejected;
check('房主重复 start 被拒绝', err.message === '比赛已开始', `message=${err.message}`);

await new Promise((r) => setTimeout(r, 400));
check('客机没有收到第二次 start', !extraStart, `extraStart=${extraStart}`);

host.close();
guest.close();
await new Promise((r) => setTimeout(r, 200));
console.log(`\n通过 ${passed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
