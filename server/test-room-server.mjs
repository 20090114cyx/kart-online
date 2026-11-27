/**
 * 房间服务器边界测试（黑盒，不改服务器源码）。
 *
 * 运行： node server/test-room-server.mjs
 * 目标： ws://127.0.0.1:8787/ws （服务器需已在运行）
 *
 * 覆盖用例：
 *   1  创建房间成功，拿到 4 位房间码
 *   2  加入不存在的房间 → error
 *   3  小写房间码加入 → 成功（大小写不敏感）
 *   4  第三人加入已满房间 → error
 *   5  非房主发 start → error
 *   6  非房主发 state → error
 *   7  非房主发 restart → error
 *   8  房主 start 后，第三人加入 → error（房间已开始）
 *   9  房主发 state，客机收到转发
 *  10  客机发 input，房主收到转发且 id/seq 正确
 *  11  客机离开 → 房主收到 peerLeft
 *  12  房主离开 → 客机收到 roomClosed
 *  13  超长昵称（20 字）被裁剪到 16 字符以内
 */

import WebSocket from 'ws';

const URL = 'ws://127.0.0.1:8787/ws';
const TIMEOUT_MS = 4000;
// 房间码字母表（与服务器 CODE_ALPHABET 一致，不含 0/1/I/O），'0000' 永远不会是真实房间码。
const NONEXISTENT_CODE = '0000';

// ---------------- 小工具 ----------------

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual(a[k], b[k]));
}

function codePoints(s) {
  return Array.from(s).length;
}

// ---------------- 迷你测试框架 ----------------

const results = [];

async function testCase(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`PASS  ${name}${detail ? `  -- ${detail}` : ''}`);
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    results.push({ name, ok: false, detail: reason });
    console.log(`FAIL  ${name}  -- ${reason}`);
  }
}

// ---------------- WebSocket 客户端封装 ----------------

const openClients = new Set();

class Client {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.messages = []; // 收到的全部消息（保留，便于事后检查）
    this.listeners = new Set();
    this.selfId = null;
    this.code = null;
    this.closed = false;
  }

  static async connect(label) {
    const c = new Client(label);
    await c.open();
    return c;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(URL);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.label}: 连接超时`)), TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timer);
        openClients.add(this);
        resolve();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        // 连接期失败 → reject；已连接后的错误 → 只记录，不让进程崩
        if (!this._connected) reject(new Error(`${this.label}: ${err.message}`));
      });

      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.messages.push(msg);
        if (msg && msg.t === 'room') {
          this.selfId = msg.selfId;
          this.code = msg.code;
        }
        for (const fn of [...this.listeners]) fn(msg);
      });

      ws.on('close', () => {
        this.closed = true;
        openClients.delete(this);
      });

      // resolve 之后标记已连接
      ws.on('open', () => {
        this._connected = true;
      });
    });
  }

  send(obj) {
    assert(this.ws && this.ws.readyState === WebSocket.OPEN, `${this.label}: 连接未打开，无法发送`);
    this.ws.send(JSON.stringify(obj));
  }

  /** 当前已收消息数量，用作 waitFor 的 since 标记。 */
  mark() {
    return this.messages.length;
  }

  /** 已收消息中是否存在匹配项（从 since 起）。 */
  has(pred, since = 0) {
    for (let i = since; i < this.messages.length; i++) {
      if (pred(this.messages[i])) return true;
    }
    return false;
  }

  /** 等待匹配消息；先查已收缓存（从 since 起），再监听新消息；超时 reject。 */
  waitFor(pred, { timeout = TIMEOUT_MS, label = '消息', since = 0 } = {}) {
    for (let i = since; i < this.messages.length; i++) {
      if (pred(this.messages[i])) return Promise.resolve(this.messages[i]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onMsg);
        reject(new Error(`${this.label}: 等待 ${label} 超时（已收: ${JSON.stringify(this.messages.slice(since))}）`));
      }, timeout);
      const onMsg = () => {
        for (let i = since; i < this.messages.length; i++) {
          if (pred(this.messages[i])) {
            clearTimeout(timer);
            this.listeners.delete(onMsg);
            resolve(this.messages[i]);
            return;
          }
        }
      };
      this.listeners.add(onMsg);
    });
  }

  async close() {
    openClients.delete(this);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 500);
      ws.once('close', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }
}

// ---------------- 房间辅助 ----------------

async function createRoom(label, name) {
  const client = await Client.connect(label);
  const mark = client.mark();
  client.send({ t: 'create', name });
  const room = await client.waitFor((m) => m.t === 'room', { since: mark, label: 'room(create)' });
  return { client, room };
}

async function joinRoom(label, code, name, existingClient) {
  const client = existingClient || (await Client.connect(label));
  const mark = client.mark();
  client.send({ t: 'join', code, name });
  const room = await client.waitFor((m) => m.t === 'room', { since: mark, label: 'room(join)' });
  return { client, room };
}

/** 建一间已满的房间：房主 + 客机。 */
async function makeFullRoom(tag) {
  const host = await createRoom(`${tag}-host`, '房主');
  const code = host.room.code;
  const hostMark = host.client.mark();
  const guest = await joinRoom(`${tag}-guest`, code, '客机');
  // 等房主收到人数=2 的 room 广播，保证房间状态已稳定
  await host.client.waitFor(
    (m) => m.t === 'room' && Array.isArray(m.players) && m.players.length === 2,
    { since: hostMark, label: 'room(2 players)' },
  );
  return { host, guest, code };
}

// ---------------- 测试数据 ----------------

function makeKartSnapshot(seed) {
  return {
    x: 1 + seed,
    y: 2,
    z: 3,
    h: 0.5,
    speed: 10 + seed,
    kmh: 36,
    charge: 0.2,
    drift: false,
    boost: 0,
    boostTimer: 0,
    slip: 0,
    grounded: true,
    pitch: 0,
    lap: 1,
    progress: 0.4,
    finished: false,
    finishTime: 0,
    finishRank: 0,
    lapTime: 1.2,
    bestTime: 0,
  };
}

const SNAPSHOT = {
  tick: 123,
  time: 4.56,
  state: 'racing',
  countdown: 0,
  laps: 3,
  karts: [makeKartSnapshot(0), makeKartSnapshot(1)],
};

const NET_INPUT = { throttle: 1, brake: 0, steer: -0.5, drift: true };

// ---------------- 用例 ----------------

const ROOM_CODE_RE = /^[A-Z0-9]{4}$/;

async function main() {
  // 先确认服务器可达
  try {
    const probe = await Client.connect('probe');
    await probe.close();
  } catch (err) {
    console.error(`无法连接房间服务器 ${URL}: ${err.message}`);
    console.error('请确认服务器已在运行（端口 8787，路径 /ws）。');
    process.exit(2);
  }

  // 1. 创建房间成功，拿到 4 位房间码
  await testCase('1 创建房间成功，拿到 4 位房间码', async () => {
    let client;
    try {
      const r = await createRoom('t1', '房主');
      client = r.client;
      const { room } = r;
      assert(room.t === 'room', `未收到 room 消息: ${JSON.stringify(room)}`);
      assert(typeof room.code === 'string', `code 不是字符串: ${JSON.stringify(room.code)}`);
      assert(room.code.length === 4, `房间码不是 4 位: "${room.code}"`);
      assert(ROOM_CODE_RE.test(room.code), `房间码含非法字符: "${room.code}"`);
      assert(room.selfId && typeof room.selfId === 'string', `缺少 selfId: ${JSON.stringify(room)}`);
      assert(room.hostId === room.selfId, `创建者应为房主: hostId=${room.hostId} selfId=${room.selfId}`);
      assert(Array.isArray(room.players) && room.players.length === 1, `创建后应有 1 人: ${JSON.stringify(room.players)}`);
      assert(room.state === 'lobby', `初始状态应为 lobby: ${room.state}`);
      return `code=${room.code} selfId=${room.selfId}`;
    } finally {
      if (client) await client.close();
    }
  });

  // 2. 加入不存在的房间 → error
  await testCase('2 加入不存在的房间 → error', async () => {
    let client;
    try {
      client = await Client.connect('t2');
      const mark = client.mark();
      client.send({ t: 'join', code: NONEXISTENT_CODE, name: '路人' });
      const err = await client.waitFor((m) => m.t === 'error', { since: mark, label: 'error' });
      assert(typeof err.message === 'string' && err.message.length > 0, `error 缺少 message: ${JSON.stringify(err)}`);
      // 确认没有收到 room（没进房）
      assert(!client.has((m) => m.t === 'room', mark), `不应收到 room: ${JSON.stringify(client.messages.slice(mark))}`);
      return `message=${err.message}`;
    } finally {
      if (client) await client.close();
    }
  });

  // 3. 小写房间码加入 → 成功（大小写不敏感）
  await testCase('3 小写房间码加入 → 成功（大小写不敏感）', async () => {
    let host, guest;
    try {
      // 房间码随机；为真正验证大小写不敏感，重试直到拿到含大写字母的房间码。
      let code = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        const r = await createRoom(`t3-host-${attempt}`, '房主');
        if (/[A-Z]/.test(r.room.code)) {
          host = r.client;
          code = r.room.code;
          break;
        }
        await r.client.close(); // 丢弃全数字房间码的房间
      }
      assert(code, '20 次都没拿到含大写字母的房间码');

      const lower = code.toLowerCase();
      assert(lower !== code, `无法构造小写码: ${code}`);
      guest = await Client.connect('t3-guest');
      const mark = guest.mark();
      guest.send({ t: 'join', code: lower, name: '客机' });
      const room = await guest.waitFor((m) => m.t === 'room', { since: mark, label: 'room(join lowercase)' });
      assert(room.code === code, `加入后房间码不一致: got ${room.code} want ${code}`);
      assert(Array.isArray(room.players) && room.players.length === 2, `加入后应有 2 人: ${JSON.stringify(room.players)}`);
      assert(room.selfId && room.selfId !== host.selfId, `selfId 异常: ${JSON.stringify(room)}`);
      assert(!guest.has((m) => m.t === 'error', mark), `不应收到 error: ${JSON.stringify(guest.messages.slice(mark))}`);
      return `code=${code} joined with "${lower}"`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 4. 第三人加入已满房间 → error
  await testCase('4 第三人加入已满房间 → error', async () => {
    let host, guest, third;
    try {
      const { host: h, guest: g, code } = await makeFullRoom('t4');
      host = h.client;
      guest = g.client;
      third = await Client.connect('t4-third');
      const mark = third.mark();
      third.send({ t: 'join', code, name: '第三人' });
      const err = await third.waitFor((m) => m.t === 'error', { since: mark, label: 'error' });
      assert(!third.has((m) => m.t === 'room', mark), `第三人不应收到 room: ${JSON.stringify(third.messages.slice(mark))}`);
      return `message=${err.message}`;
    } finally {
      if (third) await third.close();
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 5. 非房主发 start → error
  await testCase('5 非房主发 start → error', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t5');
      host = h.client;
      guest = g.client;
      const gMark = guest.mark();
      const hMark = host.mark();
      guest.send({ t: 'start', trackId: 'forest' });
      const err = await guest.waitFor((m) => m.t === 'error', { since: gMark, label: 'error' });
      // 房主不应收到 start 广播
      assert(!host.has((m) => m.t === 'start', hMark), `房主不应收到 start: ${JSON.stringify(host.messages.slice(hMark))}`);
      return `message=${err.message}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 6. 非房主发 state → error
  await testCase('6 非房主发 state → error', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t6');
      host = h.client;
      guest = g.client;
      const gMark = guest.mark();
      const hMark = host.mark();
      guest.send({ t: 'state', state: SNAPSHOT });
      const err = await guest.waitFor((m) => m.t === 'error', { since: gMark, label: 'error' });
      assert(!host.has((m) => m.t === 'state', hMark), `房主不应收到 state 转发: ${JSON.stringify(host.messages.slice(hMark))}`);
      return `message=${err.message}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 7. 非房主发 restart → error
  await testCase('7 非房主发 restart → error', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t7');
      host = h.client;
      guest = g.client;
      const gMark = guest.mark();
      const hMark = host.mark();
      guest.send({ t: 'restart' });
      const err = await guest.waitFor((m) => m.t === 'error', { since: gMark, label: 'error' });
      assert(!host.has((m) => m.t === 'restart', hMark), `房主不应收到 restart: ${JSON.stringify(host.messages.slice(hMark))}`);
      return `message=${err.message}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 8. 房主 start 后，第三人加入 → error（房间已开始）
  await testCase('8 房主 start 后，第三人加入 → error（房间已开始）', async () => {
    let host, guest, third;
    try {
      const { host: h, guest: g, code } = await makeFullRoom('t8');
      host = h.client;
      guest = g.client;
      const hMark = host.mark();
      const gMark = guest.mark();
      host.send({ t: 'start', trackId: 'forest' });
      await host.waitFor((m) => m.t === 'start', { since: hMark, label: 'start(host)' });
      await guest.waitFor((m) => m.t === 'start', { since: gMark, label: 'start(guest)' });

      third = await Client.connect('t8-third');
      const mark = third.mark();
      third.send({ t: 'join', code, name: '第三人' });
      const err = await third.waitFor((m) => m.t === 'error', { since: mark, label: 'error' });
      assert(/房间已开始/.test(err.message), `错误信息应说明房间已开始: ${err.message}`);
      assert(!third.has((m) => m.t === 'room', mark), `第三人不应收到 room: ${JSON.stringify(third.messages.slice(mark))}`);
      return `message=${err.message}`;
    } finally {
      if (third) await third.close();
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 9. 房主发 state，客机收到转发
  await testCase('9 房主发 state，客机收到转发', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t9');
      host = h.client;
      guest = g.client;
      const hMark = host.mark();
      const gMark = guest.mark();
      host.send({ t: 'state', state: SNAPSHOT });
      const msg = await guest.waitFor((m) => m.t === 'state', { since: gMark, label: 'state' });
      assert(deepEqual(msg.state, SNAPSHOT), `state 内容不一致:\n  got  ${JSON.stringify(msg.state)}\n  want ${JSON.stringify(SNAPSHOT)}`);
      // 房主自己不应收到回环
      assert(!host.has((m) => m.t === 'state', hMark), `房主不应收到自己的 state 回环`);
      return `tick=${msg.state.tick} karts=${msg.state.karts.length}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 10. 客机发 input，房主收到转发且 id/seq 正确
  await testCase('10 客机发 input，房主收到转发且 id/seq 正确', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t10');
      host = h.client;
      guest = g.client;
      const guestId = guest.selfId;
      assert(guestId, '客机缺少 selfId');
      const hMark = host.mark();
      const gMark = guest.mark();
      const SEQ = 42;
      guest.send({ t: 'input', input: NET_INPUT, seq: SEQ });
      const msg = await host.waitFor((m) => m.t === 'input', { since: hMark, label: 'input' });
      assert(msg.id === guestId, `id 不正确: got ${msg.id} want ${guestId}`);
      assert(msg.seq === SEQ, `seq 不正确: got ${JSON.stringify(msg.seq)} want ${SEQ}`);
      assert(deepEqual(msg.input, NET_INPUT), `input 内容不一致: got ${JSON.stringify(msg.input)} want ${JSON.stringify(NET_INPUT)}`);
      // 客机自己不应收到回环
      assert(!guest.has((m) => m.t === 'input', gMark), `客机不应收到 input 回环`);
      return `id=${msg.id} seq=${msg.seq} input=${JSON.stringify(msg.input)}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 11. 客机离开 → 房主收到 peerLeft
  await testCase('11 客机离开 → 房主收到 peerLeft', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t11');
      host = h.client;
      guest = g.client;
      const guestId = guest.selfId;
      const hMark = host.mark();
      guest.send({ t: 'leave' });
      const msg = await host.waitFor((m) => m.t === 'peerLeft', { since: hMark, label: 'peerLeft' });
      assert(msg.id === guestId, `peerLeft.id 不正确: got ${msg.id} want ${guestId}`);
      assert(msg.name === '客机', `peerLeft.name 不正确: got ${JSON.stringify(msg.name)}`);
      return `id=${msg.id} name=${msg.name}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 12. 房主离开 → 客机收到 roomClosed
  await testCase('12 房主离开 → 客机收到 roomClosed', async () => {
    let host, guest;
    try {
      const { host: h, guest: g } = await makeFullRoom('t12');
      host = h.client;
      guest = g.client;
      const gMark = guest.mark();
      host.send({ t: 'leave' });
      const msg = await guest.waitFor((m) => m.t === 'roomClosed', { since: gMark, label: 'roomClosed' });
      assert(typeof msg.reason === 'string' && msg.reason.length > 0, `roomClosed 缺少 reason: ${JSON.stringify(msg)}`);
      return `reason=${msg.reason}`;
    } finally {
      if (guest) await guest.close();
      if (host) await host.close();
    }
  });

  // 13. 超长昵称（20 字）被裁剪到 16 字符以内
  await testCase('13 超长昵称（20 字）被裁剪到 16 字符以内', async () => {
    let client;
    try {
      const longName = '测'.repeat(20); // 20 字
      const r = await createRoom('t13', longName);
      client = r.client;
      const self = r.room.players.find((p) => p.id === r.room.selfId);
      assert(self, `找不到自己: ${JSON.stringify(r.room.players)}`);
      const n = codePoints(self.name);
      assert(typeof self.name === 'string' && self.name.length > 0, `昵称为空`);
      assert(n <= 16, `昵称未被裁剪到 16 以内: 长度=${n} name=${JSON.stringify(self.name)}`);
      assert(self.name === Array.from(longName).slice(0, 16).join(''), `裁剪结果不对: ${JSON.stringify(self.name)}`);
      return `20 字 → ${n} 字 "${self.name}"`;
    } finally {
      if (client) await client.close();
    }
  });

  // ---------------- 汇总 + 收尾 ----------------

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('');
  console.log('================ 汇总 ================');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `  -- ${r.detail}`}`);
  }
  console.log(`通过 ${passed}/${total}`);

  // 关闭所有残留连接（房间由服务器在连接关闭时自动清理）
  const rest = [...openClients];
  for (const c of rest) await c.close();

  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('测试脚本自身出错:', err);
  // 尽力关闭
  for (const c of [...openClients]) {
    try {
      c.ws?.close();
    } catch {}
  }
  process.exit(2);
});
