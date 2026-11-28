/**
 * ping/pong 延迟测量协议 + input ts 转发 自动化测试（黑盒，不改服务器源码）。
 *
 * 运行： node server/test-ping-pong.mjs
 * 方式： 脚本自行 spawn server/room-server.mjs，端口用环境变量 PORT=8791 指定；
 *        只 kill 自己 spawn 的子进程，不触碰用户机器上 5173 / 8787 的服务。
 *
 * 覆盖用例：
 *   1  不在房间时发 ping 也能收到 pong（ts 原样返回，浮点数不丢精度）
 *   2  ts = 0 时回 pong ts = 0
 *   3  ts 缺失时服务器不崩溃，回 pong 且 ts 为 0
 *   4  ts 是字符串 "abc" 时服务器不崩溃，回 pong 且 ts 为 0
 *   5  连续发 5 个 ping，收到 5 个 pong 且 ts 一一对应（顺序一致）
 *   6  两个客户端各自 ping，pong 不会串到对方连接
 *   7  房间内 B 发 input 带 ts，房主 A 收到的 input 里 ts 与发送值一致
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const PORT = 8791; // 非常用端口，避免和正在运行的 5173 / 8787 冲突
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const TIMEOUT_MS = 4000;
const SERVER_START_TIMEOUT_MS = 8000;
const SERVER_DIR = resolve(fileURLToPath(new URL('..', import.meta.url))); // kart/
const SERVER_PATH = resolve(SERVER_DIR, 'server', 'room-server.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// ---------------- 迷你测试框架 ----------------

const results = [];

async function testCase(name, fn) {
  try {
    const detail = (await fn()) || '';
    results.push({ name, ok: true, detail });
  } catch (err) {
    const reason = err && err.message ? err.message : String(err);
    results.push({ name, ok: false, detail: reason });
  }
}

// ---------------- WebSocket 客户端封装（风格对齐 test-room-server.mjs） ----------------

const openClients = new Set();

class Client {
  constructor(label) {
    this.label = label;
    this.ws = null;
    this.messages = [];
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
    return new Promise((resolveOpen, rejectOpen) => {
      const ws = new WebSocket(WS_URL);
      this.ws = ws;
      const timer = setTimeout(() => rejectOpen(new Error(`${this.label}: 连接超时`)), TIMEOUT_MS);

      ws.on('open', () => {
        clearTimeout(timer);
        this._connected = true;
        openClients.add(this);
        resolveOpen();
      });

      ws.on('error', (err) => {
        clearTimeout(timer);
        if (!this._connected) rejectOpen(new Error(`${this.label}: ${err.message}`));
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
    });
  }

  send(obj) {
    assert(this.ws && this.ws.readyState === WebSocket.OPEN, `${this.label}: 连接未打开，无法发送`);
    this.ws.send(JSON.stringify(obj));
  }

  mark() {
    return this.messages.length;
  }

  has(pred, since = 0) {
    for (let i = since; i < this.messages.length; i++) {
      if (pred(this.messages[i])) return true;
    }
    return false;
  }

  waitFor(pred, { timeout = TIMEOUT_MS, label = '消息', since = 0 } = {}) {
    for (let i = since; i < this.messages.length; i++) {
      if (pred(this.messages[i])) return Promise.resolve(this.messages[i]);
    }
    return new Promise((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        this.listeners.delete(onMsg);
        rejectMsg(new Error(`${this.label}: 等待 ${label} 超时（已收: ${JSON.stringify(this.messages.slice(since))}）`));
      }, timeout);
      const onMsg = () => {
        for (let i = since; i < this.messages.length; i++) {
          if (pred(this.messages[i])) {
            clearTimeout(timer);
            this.listeners.delete(onMsg);
            resolveMsg(this.messages[i]);
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
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolveClose) => {
      const t = setTimeout(resolveClose, 500);
      ws.once('close', () => {
        clearTimeout(t);
        resolveClose();
      });
      try {
        ws.close();
      } catch {
        clearTimeout(t);
        resolveClose();
      }
    });
  }
}

async function closeAllClients() {
  for (const c of [...openClients]) await c.close();
}

// ---------------- 服务器进程管理 ----------------

let child = null;
let childExited = false;
let spawnError = null;
let serverLog = '';

function startServer() {
  child = spawn(process.execPath, [SERVER_PATH], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => {
    serverLog += d.toString();
  });
  child.stderr.on('data', (d) => {
    serverLog += d.toString();
  });
  child.on('error', (err) => {
    spawnError = err;
  });
  child.on('exit', () => {
    childExited = true;
  });

  // 兜底：即使脚本异常退出，也只 kill 自己 spawn 的进程
  process.on('exit', () => {
    if (child && !childExited) {
      try {
        child.kill('SIGKILL');
      } catch {}
    }
  });
}

async function waitForServer() {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`服务器 spawn 失败: ${spawnError.message}`);
    if (childExited) throw new Error(`服务器提前退出: ${serverLog}`);
    try {
      const probe = await Client.connect('probe');
      await probe.close();
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`服务器启动超时（PORT=${PORT}）: ${serverLog}`);
}

async function stopServer() {
  if (!child || childExited) return;
  await new Promise((resolveStop) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolveStop();
    }, 1500);
    child.once('exit', () => {
      clearTimeout(t);
      resolveStop();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolveStop();
    }
  });
}

// ---------------- 测试辅助 ----------------

async function ping(client, payload) {
  const mark = client.mark();
  client.send({ t: 'ping', ...payload });
  return client.waitFor((m) => m.t === 'pong', { since: mark, label: 'pong' });
}

async function createRoom(client, name) {
  const mark = client.mark();
  client.send({ t: 'create', name });
  return client.waitFor((m) => m.t === 'room', { since: mark, label: 'room(create)' });
}

async function joinRoom(client, code, name) {
  const mark = client.mark();
  client.send({ t: 'join', code, name });
  return client.waitFor((m) => m.t === 'room', { since: mark, label: 'room(join)' });
}

// ---------------- 用例 ----------------

async function runCases() {
  // 1. 不在房间时发 ping 也能收到 pong（ts 原样返回，浮点数不丢精度）
  await testCase('1 不在房间时发 ping 也能收到 pong（ts 原样返回，浮点数不丢精度）', async () => {
    const client = await Client.connect('t1');
    try {
      const ts = 123.4567890123;
      const pong = await ping(client, { ts });
      assert(pong.t === 'pong', `收到的不是 pong: ${JSON.stringify(pong)}`);
      assert(pong.ts === ts, `ts 未原样返回（浮点精度丢失?）: got ${JSON.stringify(pong.ts)} want ${JSON.stringify(ts)}`);
      assert(!client.has((m) => m.t === 'error', 0), `不应收到 error: ${JSON.stringify(client.messages)}`);
      return `ts=${ts} 原样返回`;
    } finally {
      await client.close();
    }
  });

  // 2. ts = 0 时回 pong ts = 0
  await testCase('2 ts = 0 时回 pong ts = 0', async () => {
    const client = await Client.connect('t2');
    try {
      const pong = await ping(client, { ts: 0 });
      assert(pong.ts === 0, `ts 应为数字 0: got ${JSON.stringify(pong.ts)} (${typeof pong.ts})`);
      return 'ts=0 回显为 0';
    } finally {
      await client.close();
    }
  });

  // 3. ts 缺失时服务器不崩溃，回 pong 且 ts 为 0
  await testCase('3 ts 缺失时服务器不崩溃，回 pong 且 ts 为 0', async () => {
    const client = await Client.connect('t3');
    try {
      const pong = await ping(client, {});
      assert(pong.ts === 0, `ts 缺失时应回 0: got ${JSON.stringify(pong.ts)}`);
      // 再发一个正常 ping，确认服务器仍存活
      const follow = await ping(client, { ts: 77.7 });
      assert(follow.ts === 77.7, `服务器疑似崩溃（后续 ping 异常）: got ${JSON.stringify(follow.ts)}`);
      return '回 pong ts=0，后续 ping 正常';
    } finally {
      await client.close();
    }
  });

  // 4. ts 是字符串 "abc" 时服务器不崩溃，回 pong 且 ts 为 0
  await testCase('4 ts 是字符串 "abc" 时服务器不崩溃，回 pong 且 ts 为 0', async () => {
    const client = await Client.connect('t4');
    try {
      const pong = await ping(client, { ts: 'abc' });
      assert(pong.ts === 0, `ts="abc" 应回 0: got ${JSON.stringify(pong.ts)}`);
      const follow = await ping(client, { ts: 88.8 });
      assert(follow.ts === 88.8, `服务器疑似崩溃（后续 ping 异常）: got ${JSON.stringify(follow.ts)}`);
      return '回 pong ts=0，后续 ping 正常';
    } finally {
      await client.close();
    }
  });

  // 5. 连续发 5 个 ping，收到 5 个 pong 且 ts 一一对应（顺序一致）
  await testCase('5 连续发 5 个 ping，收到 5 个 pong 且 ts 一一对应（顺序一致）', async () => {
    const client = await Client.connect('t5');
    try {
      const tss = [1.1, 2.2, 3.3, 4.4, 5.5];
      let since = client.mark();
      for (const ts of tss) client.send({ t: 'ping', ts });
      const got = [];
      for (let i = 0; i < tss.length; i++) {
        const pong = await client.waitFor((m) => m.t === 'pong', { since, label: `pong#${i + 1}` });
        got.push(pong.ts);
        since = client.messages.indexOf(pong) + 1;
      }
      assert(got.length === tss.length, `只收到 ${got.length} 个 pong，期望 ${tss.length} 个`);
      for (let i = 0; i < tss.length; i++) {
        assert(got[i] === tss[i], `第 ${i + 1} 个 pong.ts 不匹配: got ${JSON.stringify(got[i])} want ${JSON.stringify(tss[i])}`);
      }
      return `5/5 顺序一致: ${got.join(', ')}`;
    } finally {
      await client.close();
    }
  });

  // 6. 两个客户端各自 ping，pong 不会串到对方连接
  await testCase('6 两个客户端各自 ping，pong 不会串到对方连接', async () => {
    const c1 = await Client.connect('t6-a');
    const c2 = await Client.connect('t6-b');
    try {
      const ts1 = 111.111;
      const ts2 = 222.222;
      const m1 = c1.mark();
      const m2 = c2.mark();
      c1.send({ t: 'ping', ts: ts1 });
      c2.send({ t: 'ping', ts: ts2 });
      const p1 = await c1.waitFor((m) => m.t === 'pong', { since: m1, label: 'pong(c1)' });
      const p2 = await c2.waitFor((m) => m.t === 'pong', { since: m2, label: 'pong(c2)' });
      assert(p1.ts === ts1, `c1 收到错误的 ts: got ${JSON.stringify(p1.ts)} want ${ts1}`);
      assert(p2.ts === ts2, `c2 收到错误的 ts: got ${JSON.stringify(p2.ts)} want ${ts2}`);
      await sleep(100); // 留一点时间让可能的串包到达
      const c1Pongs = c1.messages.slice(m1).filter((m) => m.t === 'pong');
      const c2Pongs = c2.messages.slice(m2).filter((m) => m.t === 'pong');
      assert(c1Pongs.length === 1, `c1 应只收到 1 个 pong，实际 ${c1Pongs.length}: ${JSON.stringify(c1Pongs)}`);
      assert(c2Pongs.length === 1, `c2 应只收到 1 个 pong，实际 ${c2Pongs.length}: ${JSON.stringify(c2Pongs)}`);
      assert(!c1.has((m) => m.t === 'pong' && m.ts === ts2, m1), `c1 串到了 c2 的 pong(ts=${ts2})`);
      assert(!c2.has((m) => m.t === 'pong' && m.ts === ts1, m2), `c2 串到了 c1 的 pong(ts=${ts1})`);
      return `c1.ts=${ts1}, c2.ts=${ts2}，无串包`;
    } finally {
      await c1.close();
      await c2.close();
    }
  });

  // 7. 房间内 B 发 input 带 ts，房主 A 收到的 input 里 ts 与发送值一致
  await testCase('7 房间内 B 发 input 带 ts，A 收到的 input 里 ts 与发送值一致', async () => {
    const a = await Client.connect('t7-A');
    const b = await Client.connect('t7-B');
    try {
      const roomA = await createRoom(a, '房主A');
      assert(roomA.code, `A 建房失败: ${JSON.stringify(roomA)}`);
      const aMarkRoom = a.mark(); // 必须在 B 加入前打标记，否则 2 人 room 广播已经到达
      const roomB = await joinRoom(b, roomA.code, '客机B');
      assert(roomB.code === roomA.code, `B 加入房间码不一致: ${JSON.stringify(roomB)}`);
      await a.waitFor(
        (m) => m.t === 'room' && Array.isArray(m.players) && m.players.length === 2,
        { since: aMarkRoom, label: 'room(2 players)' },
      );

      const aMarkStart = a.mark();
      const bMarkStart = b.mark();
      a.send({ t: 'start', trackId: 'forest' });
      await a.waitFor((m) => m.t === 'start', { since: aMarkStart, label: 'start(A)' });
      await b.waitFor((m) => m.t === 'start', { since: bMarkStart, label: 'start(B)' });

      const ts = 987.654321;
      const input = { throttle: 1, brake: 0, steer: -0.5, drift: true };
      const aMark = a.mark();
      b.send({ t: 'input', input, seq: 1, ts });
      const msg = await a.waitFor((m) => m.t === 'input', { since: aMark, label: 'input(A)' });
      assert(msg.ts === ts, `A 收到的 input.ts 不一致: got ${JSON.stringify(msg.ts)} want ${JSON.stringify(ts)}；完整消息=${JSON.stringify(msg)}`);
      return `ts=${ts} 转发一致`;
    } finally {
      await b.close();
      await a.close();
    }
  });
}

// ---------------- 主流程 ----------------

async function main() {
  startServer();
  try {
    await waitForServer();
    await runCases();
  } finally {
    await closeAllClients();
    await stopServer();
  }

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  console.log('');
  console.log('==================== 测试结果 ====================');
  console.log('结果   用例');
  console.log('--------------------------------------------------');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS  ' : 'FAIL  '} ${r.name}${r.detail ? `  -- ${r.detail}` : ''}`);
  }
  console.log('--------------------------------------------------');
  console.log(`通过 ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((err) => {
  console.error('测试脚本自身出错:', err);
  process.exit(2);
});
