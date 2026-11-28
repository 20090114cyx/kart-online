/**
 * 房间码联机客户端。
 *
 * 分工：
 *  - 服务器只做房间管理和消息中继；
 *  - 房主客户端跑完整物理，按 30 Hz 发快照；
 *  - 客机把本地输入发给房主，接收快照并做本地预测 / 远端插值。
 */

export interface NetPlayer {
  id: string;
  name: string;
  slot: number;
}

export interface NetInput {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
}

export interface NetRoomInfo {
  code: string;
  selfId: string;
  hostId: string;
  players: NetPlayer[];
  state: 'lobby' | 'racing';
}

export interface NetStart {
  trackId: string;
  players: NetPlayer[];
  hostId: string;
}

/** 房主每 30 Hz 广播的一台车状态。 */
export interface NetKartSnapshot {
  x: number;
  y: number;
  z: number;
  /** heading，弧度 */
  h: number;
  /** 速度 m/s */
  speed: number;
  /** 速度 km/h（HUD 用） */
  kmh: number;
  charge: number;
  drift: boolean;
  boost: number;
  boostTimer: number;
  slip: number;
  grounded: boolean;
  pitch: number;
  lap: number;
  progress: number;
  finished: boolean;
  finishTime: number;
  finishRank: number;
  lapTime: number;
  bestTime: number;
}

/** 房主权威快照。karts 的顺序与客户端 racers 数组一致。 */
export interface NetSnapshot {
  tick: number;
  time: number;
  state: 'countdown' | 'racing' | 'finished';
  countdown: number;
  laps: number;
  karts: NetKartSnapshot[];
  /** 房主回显的客机输入时间戳（客机用它算 输入→房主→本机 的往返） */
  echoTs?: number;
}

type RoomHandler = (room: NetRoomInfo) => void;
type StartHandler = (msg: NetStart) => void;
type InputHandler = (id: string, input: NetInput, seq: number, ts: number) => void;
type StateHandler = (snapshot: NetSnapshot) => void;
type PongHandler = (ts: number) => void;
type VoidHandler = () => void;
type MessageHandler = (message: string) => void;
type CloseHandler = (wasInRoom: boolean) => void;

export class NetClient {
  selfId = '';
  code = '';
  hostId = '';
  players: NetPlayer[] = [];
  roomState: 'idle' | 'lobby' | 'racing' = 'idle';

  onRoom: RoomHandler | null = null;
  onStart: StartHandler | null = null;
  onInput: InputHandler | null = null;
  onState: StateHandler | null = null;
  onPong: PongHandler | null = null;
  onRestart: VoidHandler | null = null;
  onRequestRestart: VoidHandler | null = null;
  onRoomClosed: MessageHandler | null = null;
  onError: MessageHandler | null = null;
  onClose: CloseHandler | null = null;

  private ws: WebSocket | null = null;
  private opening: Promise<void> | null = null;
  private closedByUs = false;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get isHost(): boolean {
    return this.selfId !== '' && this.selfId === this.hostId;
  }

  get inRoom(): boolean {
    return this.roomState !== 'idle';
  }

  /** 连接 /ws（Vite 代理到房间服务器）。重复调用复用同一个连接。 */
  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.opening) return this.opening;

    this.opening = new Promise<void>((resolve, reject) => {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${window.location.host}/ws`;
      let settled = false;

      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        this.opening = null;
        reject(new Error('无法创建 WebSocket 连接'));
        return;
      }
      this.ws = ws;

      ws.addEventListener('open', () => {
        settled = true;
        this.opening = null;
        resolve();
      });

      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data);
      });

      ws.addEventListener('error', () => {
        if (!settled) {
          settled = true;
          this.opening = null;
          reject(new Error('无法连接房间服务器'));
        }
      });

      ws.addEventListener('close', () => {
        const wasInRoom = this.roomState !== 'idle';
        this.ws = null;
        this.opening = null;
        this.resetRoom();
        if (!settled) {
          settled = true;
          reject(new Error('无法连接房间服务器'));
        }
        const intentional = this.closedByUs;
        this.closedByUs = false;
        if (!intentional) this.onClose?.(wasInRoom);
      });
    });

    return this.opening;
  }

  async createRoom(name: string): Promise<void> {
    await this.connect();
    this.send({ t: 'create', name: cleanName(name) });
  }

  async joinRoom(code: string, name: string): Promise<void> {
    await this.connect();
    const normalized = code.trim().toUpperCase();
    if (normalized.length !== 4) throw new Error('房间码是 4 位');
    this.send({ t: 'join', code: normalized, name: cleanName(name) });
  }

  /** 离开房间但保持 WebSocket，方便回到大厅后立刻再创建 / 加入。 */
  leave(): void {
    if (this.inRoom) this.send({ t: 'leave' });
    this.resetRoom();
  }

  start(trackId: string): void {
    this.send({ t: 'start', trackId });
  }

  sendInput(input: NetInput, seq: number, ts = 0): void {
    this.send({ t: 'input', input, seq, ts });
  }

  /** 测 本机 ↔ 服务器 往返：服务器原样回显 ts。 */
  ping(ts: number): void {
    this.send({ t: 'ping', ts });
  }

  sendState(state: NetSnapshot): void {
    this.send({ t: 'state', state });
  }

  restart(): void {
    this.send({ t: 'restart' });
  }

  requestRestart(): void {
    this.send({ t: 'requestRestart' });
  }

  disconnect(): void {
    this.closedByUs = true;
    this.resetRoom();
    this.ws?.close();
    this.ws = null;
    this.opening = null;
  }

  private resetRoom(): void {
    this.selfId = '';
    this.code = '';
    this.hostId = '';
    this.players = [];
    this.roomState = 'idle';
  }

  private send(message: unknown): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(message));
  }

  private handleMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    switch (msg.t) {
      case 'room': {
        const room = msg as unknown as NetRoomInfo;
        this.selfId = room.selfId;
        this.code = room.code;
        this.hostId = room.hostId;
        this.players = Array.isArray(room.players) ? room.players : [];
        this.roomState = room.state === 'racing' ? 'racing' : 'lobby';
        this.onRoom?.(room);
        break;
      }
      case 'start': {
        this.roomState = 'racing';
        this.onStart?.(msg as unknown as NetStart);
        break;
      }
      case 'input': {
        const input = msg.input as NetInput | undefined;
        if (input) {
          this.onInput?.(String(msg.id ?? ''), input, Number(msg.seq ?? 0), Number(msg.ts ?? 0));
        }
        break;
      }
      case 'pong':
        this.onPong?.(Number(msg.ts ?? 0));
        break;
      case 'state': {
        const state = msg.state as NetSnapshot | undefined;
        if (state && Array.isArray(state.karts)) this.onState?.(state);
        break;
      }
      case 'restart':
        this.onRestart?.();
        break;
      case 'requestRestart':
        this.onRequestRestart?.();
        break;
      case 'roomClosed':
        this.resetRoom();
        this.onRoomClosed?.(String(msg.reason ?? '房间已关闭'));
        break;
      case 'error':
        this.onError?.(String(msg.message ?? '联机出错'));
        break;
      default:
        break;
    }
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '玩家';
  return Array.from(trimmed).slice(0, 8).join('');
}
