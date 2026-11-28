import * as THREE from 'three';
import './style.css';

import { Kart, type KartInput } from './kart';
import { Track } from './track';
import { createScenery } from './scenery';
import { createKartVisual, type KartVisual } from './kartMesh';
import { ChaseCamera } from './camera';
import { Input } from './input';
import { Particles } from './particles';
import { Hud } from './hud';
import { createTuning } from './tuning';
import { GameAudio } from './audio';
import { SkidMarks } from './skids';
import { PostFX, type SplitView } from './postfx';
import { AiDriver, type AiSpec } from './ai';
import { Minimap, type MinimapPlayer } from './minimap';
import { createTrackLayout } from './trackLayout';
import { TRACK_DEFS, type TrackDef } from './trackDefs';
import type { Scenery } from './scenery';
import { P } from './config';
import {
  NetClient,
  type NetInput,
  type NetKartSnapshot,
  type NetPlayer,
  type NetSnapshot,
  type NetStart,
} from './net';

// ---------------- 渲染器 ----------------
const mount = document.getElementById('app');
if (!mount) throw new Error('#app not found');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
const BASE_DPR = Math.min(window.devicePixelRatio, 2);
renderer.setPixelRatio(BASE_DPR);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// 阴影每帧只更新一次：分屏会调用两次 render，autoUpdate 会把整张阴影贴图算两遍。
// needsUpdate 在 update() 里每帧置一次，由第一次场景渲染消费。
renderer.shadowMap.autoUpdate = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
mount.appendChild(renderer.domElement);

// 冲刺后处理（径向模糊 / 速度线 / 色差 / 暗角 / 白闪）
const postfx = new PostFX(renderer);

// ---------------- 场景 ----------------
const scene = new THREE.Scene();

// 当前加载的赛道 / 环境。换图时整体重建，车辆与 HUD 复用。
let track: Track = new Track(TRACK_DEFS[0]!);
scene.add(track.group);

let scenery: Scenery = createScenery(scene, track);
scene.add(scenery.group);

// ---------------- 赛车 ----------------
interface Racer {
  kart: Kart;
  visual: KartVisual;
  skids: SkidMarks;
  driver: AiDriver | null;
  name: string;
  isPlayer: boolean;
  /** -1 = AI，0 = P1，1 = P2 */
  playerSlot: number;
  active: boolean;
  /** 发车位 0..3 */
  gridSlot: number;
  aiSpec: AiEntry | null;
  lap: number;
  progress: number;
  lastProgress: number;
  finished: boolean;
  finishTime: number;
  finishRank: number;
  /** 当前圈用时（只对真人有效） */
  lapTime: number;
  /** 本场最佳圈（只对真人有效） */
  bestTime: number;
  visualPitch: number;
  fxBoost: number;
  prevLandImpact: number;
  smokeAcc: number;
  boostAcc: number;
  boostCooldown: number;
  /** 小地图上的颜色 */
  mapColor: string;
  /** 真人完赛后由 AI 接管巡航 */
  autopilot: boolean;
}

interface AiEntry extends AiSpec {
  body: number;
  accent: number;
  helmet: number;
  /** 车顶名字标签的颜色 */
  tag: string;
  gridSlot: number;
}

const AI_ENTRIES: AiEntry[] = [
  { name: '蓝影', pace: 1.02, branchAffinity: 0.72, body: 0x2f7df6, accent: 0xf5f6f8, helmet: 0xffd23f, tag: '#7db6ff', gridSlot: 0 },
  { name: '青锋', pace: 0.98, branchAffinity: 0.35, body: 0x27c07a, accent: 0xf5f6f8, helmet: 0xff7a3d, tag: '#5cf0ae', gridSlot: 1 },
  { name: '紫电', pace: 0.94, branchAffinity: 0.88, body: 0x8b5cf6, accent: 0xf5f6f8, helmet: 0x37d3ff, tag: '#c3a6ff', gridSlot: 3 },
];

/** 完赛后接管真人车辆的巡航 AI */
const CRUISE_SPEC: AiSpec = { name: '巡航', pace: 0.86, branchAffinity: 0.2 };

/** 车顶名字标签：让玩家一眼知道前面是谁 */
function createNameTag(name: string, color: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create 2D context for name tag');

  ctx.fillStyle = 'rgba(8, 12, 20, 0.55)';
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(6, 8, 244, 48, 16);
    ctx.fill();
  } else {
    ctx.fillRect(6, 8, 244, 48);
  }

  ctx.font = 'bold 34px system-ui, "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(name, 128, 33);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.3, 0.575, 1);
  sprite.position.y = 2.15;
  sprite.renderOrder = 5;
  return sprite;
}

function makeRacer(params: {
  kart: Kart;
  visual: KartVisual;
  name: string;
  playerSlot: number;
  gridSlot: number;
  aiSpec: AiEntry | null;
  mapColor: string;
  skidMax: number;
}): Racer {
  params.visual.group.rotation.order = 'YXZ';
  scene.add(params.visual.group);

  return {
    kart: params.kart,
    visual: params.visual,
    skids: new SkidMarks(scene, params.skidMax),
    driver: null,
    name: params.name,
    isPlayer: params.playerSlot >= 0,
    playerSlot: params.playerSlot,
    active: true,
    gridSlot: params.gridSlot,
    aiSpec: params.aiSpec,
    lap: 0,
    progress: 0,
    lastProgress: 0,
    finished: false,
    finishTime: 0,
    finishRank: 0,
    lapTime: 0,
    bestTime: 0,
    visualPitch: 0,
    fxBoost: 0,
    prevLandImpact: 0,
    smokeAcc: 0,
    boostAcc: 0,
    boostCooldown: 0,
    mapColor: params.mapColor,
    autopilot: false,
  };
}

// ---- 动态名字牌：联机时换成真人昵称，回菜单再恢复 ----
const dynamicTags = new Map<Racer, THREE.Sprite>();

function setDynamicNameTag(r: Racer, name: string, color: string): void {
  const old = dynamicTags.get(r);
  if (old) {
    r.visual.group.remove(old);
    old.material.map?.dispose();
    old.material.dispose();
    dynamicTags.delete(r);
  }
  if (!name) return;
  const tag = createNameTag(name, color);
  r.visual.group.add(tag);
  dynamicTags.set(r, tag);
}

function clearDynamicNameTag(r: Racer): void {
  const old = dynamicTags.get(r);
  if (!old) return;
  r.visual.group.remove(old);
  old.material.map?.dispose();
  old.material.dispose();
  dynamicTags.delete(r);
}

// ---- P1 ----
const playerKart = new Kart();
playerKart.groundSampler = (x, z) => track.groundHeightAt(x, z);
const playerVisual = createKartVisual();
const player = makeRacer({
  kart: playerKart,
  visual: playerVisual,
  name: '你',
  playerSlot: 0,
  gridSlot: 2,
  aiSpec: null,
  mapColor: '#ffd23f',
  skidMax: 900,
});

// ---- P2 ----
const player2Kart = new Kart();
player2Kart.groundSampler = (x, z) => track.groundHeightAt(x, z);
const player2Visual = createKartVisual({ body: 0xff7a1a, accent: 0x1b2230, helmet: 0x37d3ff });
const player2 = makeRacer({
  kart: player2Kart,
  visual: player2Visual,
  name: 'P2',
  playerSlot: 1,
  gridSlot: 3,
  aiSpec: null,
  mapColor: '#ff9a3d',
  skidMax: 900,
});
setDynamicNameTag(player2, 'P2', '#ffb066');
player2.active = false;
player2.visual.group.visible = false;

// ---- AI ----
const aiRacers: Racer[] = AI_ENTRIES.map((entry) => {
  const kart = new Kart();
  kart.groundSampler = (x, z) => track.groundHeightAt(x, z);
  const visual = createKartVisual({ body: entry.body, accent: entry.accent, helmet: entry.helmet });
  visual.group.add(createNameTag(entry.name, entry.tag));
  return makeRacer({
    kart,
    visual,
    name: entry.name,
    playerSlot: -1,
    gridSlot: entry.gridSlot,
    aiSpec: entry,
    mapColor: entry.tag,
    skidMax: 260,
  });
});

const allRacers: Racer[] = [player, player2, ...aiRacers];
/** 当前参赛的 4 台车。单人 = P1 + 3 AI；双人 = P1 + P2 + 2 AI。 */
let racers: Racer[] = [player, ...aiRacers];
let allKarts = racers.map((r) => r.kart);

const cam1 = new ChaseCamera(window.innerWidth / window.innerHeight);
const cam2 = new ChaseCamera(window.innerWidth / window.innerHeight);
const cam = cam1;

const input = new Input();
const particles = new Particles(scene, 1000);

const hudRoot1 = document.getElementById('hudP1');
const hudRoot2 = document.getElementById('hudP2');
if (!hudRoot1 || !hudRoot2) throw new Error('HUD panels not found');
const hud1 = new Hud(hudRoot1);
const hud2 = new Hud(hudRoot2);

const minimapCanvas1 = document.querySelector<HTMLCanvasElement>('#hudP1 [data-hud="minimap"]');
const minimapCanvas2 = document.querySelector<HTMLCanvasElement>('#hudP2 [data-hud="minimap"]');
let minimap1: Minimap | null = null;
let minimap2: Minimap | null = null;
let minimapPlayers1: MinimapPlayer[] = [];
let minimapPlayers2: MinimapPlayer[] = [];

const audio = new GameAudio();
audio.attach();

// ---------------- 比赛状态 ----------------
type RaceState = 'menu' | 'countdown' | 'racing' | 'finished';
type GameMode = 1 | 2 | 3; // 3 = 房间码联机

let raceState: RaceState = 'menu';
let countdown = 3.2;
let goTimer = 0;
let raceTime = 0;
let totalLaps = track.def.laps;

/** 选图界面当前高亮的赛道，与已加载赛道分开：点选不重建，点开始才重建 */
let menuIndex = 0;

/** 选图界面选择的模式；真正生效在 startRace */
let pendingMode: GameMode = 1;
let twoPlayer = false;
let lastCountdownText = '';

// ---------------- 联机状态 ----------------
const net = new NetClient();
/** 当前这局是否是联机比赛 */
let onlineMode = false;
/** 联机比赛里本机是不是房主（房主跑完整物理） */
let onlineHost = false;
/** 本机 HUD / 镜头 / 输入对应的车；单人和本地双人都是 player，联机客机是 player2 */
let localRacer: Racer = player;

const remoteInput: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };
const netBuffer: { at: number; snap: NetSnapshot }[] = [];
let lastSnapshot: NetSnapshot | null = null;
let netClock = 0;
let netSendAcc = 0;
let hostSnapAcc = 0;
let netSeq = 0;
let snapshotTick = 0;
/** 本机 ↔ 房间服务器 的往返（ms，平滑后） */
let serverRtt = 0;
/** 客机：本机输入 → 房主 → 回到本机 的往返（ms，平滑后） */
let linkRtt = 0;
/** 测服务器往返的累计计时器 */
let pingAcc = 0;
/** 房主：最近一次收到的客机输入时间戳，随快照回显 */
let peerEchoTs = 0;
/** 延迟数字刷新节流 */
let netHudAcc = 0;
/** 物理累积器；提前声明，resetRace 在模块初始化阶段就会调用 */
let acc = 0;
let onlineNames = { host: '房主', guest: '玩家' };

function isOnlineGuest(): boolean {
  return onlineMode && !onlineHost;
}

/** 房主开局时客位没人（或客机已掉线）→ 由 AI 接管橙色车。 */
function onlineGuestSeatIsAi(): boolean {
  return onlineMode && onlineHost && net.players.length < 2;
}

/**
 * 发车位：两排两列。P1 第二排右，P2 第二排左；蓝影 / 青锋第一排。
 * 用米换算成当前赛道的采样进度，换赛道后依旧成立。
 */
function gridPose(slot: number): { pos: THREE.Vector3; heading: number } {
  const n = track.sampleCount;
  const slots = [
    { t: 16 / n, lat: -2.7 },
    { t: 16 / n, lat: 2.7 },
    { t: 10 / n, lat: 2.7 },
    { t: 10 / n, lat: -2.7 },
  ];
  const s = slots[Math.max(0, Math.min(3, slot))]!;
  return track.getPoseAt(s.t, s.lat);
}

/** 根据单人 / 双人 / 联机切换参赛名单，并隐藏不上场的车。 */
function rebuildActiveRacers(): void {
  const [ai1, ai2, ai3] = aiRacers;
  if (onlineMode) {
    racers = [player, player2, ai1!, ai2!];
  } else {
    racers = twoPlayer
      ? [player, player2, ai1!, ai2!]
      : [player, ai1!, ai2!, ai3!];
  }

  const active = new Set(racers);
  for (const r of allRacers) {
    r.active = active.has(r);
    r.visual.group.visible = r.active;
  }

  if (onlineMode) {
    player.name = onlineNames.host;
    player2.name = onlineNames.guest;
  } else {
    player.name = twoPlayer ? 'P1' : '你';
    player2.name = 'P2';
  }

  localRacer = onlineMode && !onlineHost ? player2 : player;
  allKarts = racers.map((r) => r.kart);
  rebuildMinimapPlayers();
}

function rebuildMinimapPlayers(): void {
  minimapPlayers1 = racers.map((r) => ({
    x: 0,
    z: 0,
    color: r.mapColor,
    isPlayer: r.isPlayer,
  }));
  minimapPlayers2 = racers.map((r) => ({
    x: 0,
    z: 0,
    color: r.mapColor,
    isPlayer: r.isPlayer,
  }));
}

/** 清空联机回放缓冲与远端输入：重开 / 开局时必须调用，否则会被上一局快照拉回。 */
function resetNetReplayState(): void {
  netBuffer.length = 0;
  lastSnapshot = null;
  netClock = 0;
  netSendAcc = 0;
  hostSnapAcc = 0;
  netSeq = 0;
  snapshotTick = 0;
  serverRtt = 0;
  linkRtt = 0;
  pingAcc = 0;
  peerEchoTs = 0;
  netHudAcc = 0;
  remoteInput.throttle = 0;
  remoteInput.brake = 0;
  remoteInput.steer = 0;
  remoteInput.drift = false;
  acc = 0;
}

function resetRace(): void {
  resetNetReplayState();
  for (const r of racers) {
    const pose = gridPose(r.gridSlot);
    r.kart.reset(pose.pos, pose.heading);
    r.visual.group.position.copy(pose.pos);
    r.visual.group.rotation.set(0, pose.heading, 0);
    r.visualPitch = 0;
    r.fxBoost = 0;
    r.prevLandImpact = 0;
    r.smokeAcc = 0;
    r.boostAcc = 0;
    r.boostCooldown = 0;
    r.lap = 0;
    r.finished = false;
    r.finishTime = 0;
    r.finishRank = 0;
    r.lapTime = 0;
    r.progress = track.progressAt(pose.pos);
    r.lastProgress = r.progress;
    r.autopilot = false;
    if (r.isPlayer) {
      r.driver = null;
      // 联机房主：客位空着 / 客机掉线时用 AI 补位
      if (r === player2 && onlineGuestSeatIsAi()) {
        r.autopilot = true;
        r.driver = new AiDriver(track, r.kart, CRUISE_SPEC);
      }
    } else if (isOnlineGuest()) {
      // 客机上的 AI 由房主快照驱动，本地不跑 AI 决策
      r.driver = null;
    } else {
      r.driver = r.aiSpec ? new AiDriver(track, r.kart, r.aiSpec) : null;
    }
    r.skids.clear();
  }

  // 不上场的车也清掉残留状态，切模式时不会突然出现在赛道上
  for (const r of allRacers) {
    if (r.active) continue;
    r.driver = null;
    r.autopilot = false;
    r.skids.clear();
  }

  cam1.snap(localRacer.kart);
  if (twoPlayer && !onlineMode) cam2.snap(player2.kart);
  input.releaseTouch();

  raceState = 'countdown';
  countdown = 3.2;
  goTimer = 0;
  raceTime = 0;
  document.body.classList.remove('finished');
  hideFinishOverlay();
  lastCountdownText = '';
  updateCountdownView();
  resizeCameras();
}

/**
 * 把当前 track 重新绑定到所有依赖它的对象：车辆地面采样、AI、小地图、HUD。
 * 换图时只重建 track / scenery，车辆与 DOM 复用。
 */
function bindTrack(): void {
  cam1.groundAt = (x, z) => track.groundHeightAt(x, z);
  cam2.groundAt = (x, z) => track.groundHeightAt(x, z);

  for (const r of allRacers) {
    r.kart.groundSampler = (x, z) => track.groundHeightAt(x, z);
    r.skids.clear();
  }

  minimap1?.dispose();
  minimap2?.dispose();
  minimap1 = minimapCanvas1 ? new Minimap(minimapCanvas1, track.layout) : null;
  minimap2 = minimapCanvas2 ? new Minimap(minimapCanvas2, track.layout) : null;

  totalLaps = track.def.laps;
  for (const el of document.querySelectorAll<HTMLElement>('[data-hud="trackName"]')) {
    el.textContent = track.def.name;
  }
  document.title = `Kart Prototype v0.5 — ${track.def.name}`;

  rebuildMinimapPlayers();
  resizeCameras();
}

/** 换赛道：重建赛道 / 环境 / 小地图 / AI，然后回到发车位。 */
function applyTrack(def: TrackDef): void {
  if (def.id !== track.def.id) {
    scene.remove(track.group);
    track.dispose();
    scene.remove(scenery.group);
    scenery.dispose();

    track = new Track(def);
    scene.add(track.group);
    scenery = createScenery(scene, track);
    scene.add(scenery.group);

    player.bestTime = 0;
    player2.bestTime = 0;
    particles.clear();
  }
  bindTrack();
  resetRace();
}

/** 选图 / 开赛 / 切模式时统一刷新镜头宽高比。 */
function resizeCameras(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const split = twoPlayer && !onlineMode && raceState !== 'menu';
  const aspect = split ? (w * 0.5) / h : w / h;
  cam1.resize(aspect);
  cam2.resize(aspect);
}

bindTrack();
resetRace();
createTuning({ teleport: resetRace });

// ---------------- 竖屏提示 ----------------
// 手机端只做横屏：竖屏时盖一层提示，转回横屏自动继续（比赛冻结，不偷偷跑掉）。
function setupOrientationGate(): void {
  if (!document.body.classList.contains('touch')) return;

  const sync = (): void => {
    const portrait = window.innerHeight > window.innerWidth;
    document.body.classList.toggle('portrait', portrait);
    // 转竖屏时松开所有触屏输入，免得转回来车还在自己加速
    if (portrait) input.releaseTouch();
  };
  sync();
  window.addEventListener('resize', sync);
  window.addEventListener('orientationchange', sync);

  const go = document.getElementById('rotateGo');
  go?.addEventListener('click', async () => {
    try {
      await document.documentElement.requestFullscreen?.();
    } catch {
      // 全屏被拒绝也不影响，手动旋转一样能玩
    }
    try {
      const orientation = (
        screen as Screen & { orientation?: { lock?: (o: string) => Promise<void> } }
      ).orientation;
      await orientation?.lock?.('landscape');
    } catch {
      // iOS 等不支持锁定的浏览器：用户手动横过来即可
    }
  });
}

setupOrientationGate();

// ---------------- 选图界面 ----------------
const trackCardsEl = document.getElementById('trackCards');
const trackHintEl = document.getElementById('trackHint');

function makeEl(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

function buildTrackCards(): void {
  if (!trackCardsEl) return;
  trackCardsEl.textContent = '';

  TRACK_DEFS.forEach((def, i) => {
    // 卡片上显示真实采样长度，和游戏里跑的完全一致
    const layout = createTrackLayout(def);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `track-card theme-${def.id}`;
    card.dataset.index = String(i);

    const body = makeEl('div', 'tc-body');
    const top = makeEl('div', 'tc-top');
    top.append(makeEl('span', 'tc-name', def.name));
    top.append(
      makeEl('span', 'tc-diff', '★'.repeat(def.difficulty) + '☆'.repeat(3 - def.difficulty)),
    );
    body.append(top);
    body.append(makeEl('div', 'tc-sub', def.subtitle));
    body.append(makeEl('p', 'tc-desc', def.description));

    const stats = makeEl('div', 'tc-stats');
    stats.append(makeEl('span', '', formatLength(layout.main.length)));
    stats.append(makeEl('span', '', `${def.laps} 圈`));
    stats.append(makeEl('span', '', `${def.branches.length} 条支路`));
    stats.append(
      makeEl(
        'span',
        '',
        `${def.boostPads.length + def.branches.reduce((n, b) => n + (b.boostPads?.length ?? 0), 0)} 处加速带`,
      ),
    );
    body.append(stats);

    const features = makeEl('div', 'tc-features');
    for (const f of def.features) features.append(makeEl('span', '', f));
    body.append(features);

    card.append(body);
    card.addEventListener('click', () => selectTrack(i));
    card.addEventListener('dblclick', () => {
      selectTrack(i);
      startRace();
    });
    trackCardsEl.append(card);
  });
}

function updateModeButtons(): void {
  document.querySelectorAll<HTMLElement>('.mode-btn').forEach((btn) => {
    btn.classList.toggle('selected', Number(btn.dataset.mode) === pendingMode);
  });
}

// ---------------- 联机大厅 ----------------
const lobbyEl = document.getElementById('onlineLobby');
const olSetupEl = document.getElementById('olSetup');
const olRoomEl = document.getElementById('olRoom');
const olNameEl = document.getElementById('olName') as HTMLInputElement | null;
const olCodeEl = document.getElementById('olCode') as HTMLInputElement | null;
const olStatusEl = document.getElementById('olStatus');
const olRoomStatusEl = document.getElementById('olRoomStatus');
const olCodeShowEl = document.getElementById('olCodeShow');
const olPlayersEl = document.getElementById('olPlayers');
const olTrackEl = document.getElementById('olTrack');
const olStartEl = document.getElementById('olStart') as HTMLButtonElement | null;

function updateTrackHint(): void {
  const def = TRACK_DEFS[menuIndex];
  if (!trackHintEl || !def) return;
  let modeText: string;
  if (pendingMode === 3) {
    modeText = net.inRoom ? '联机：等待房主开始 · Esc 关闭大厅' : '联机：创建房间 / 输入房间码';
  } else if (pendingMode === 2) {
    modeText = '双人：P1 WASD + 左Shift · P2 方向键 + 右Shift';
  } else {
    modeText = '← → 切换 · Enter 开始';
  }
  trackHintEl.textContent = `已选 ${def.name} · ${def.laps} 圈 · ${def.branches.length} 条支路 · ${modeText}`;
}

function selectTrack(index: number): void {
  if (TRACK_DEFS.length === 0) return;
  menuIndex = ((index % TRACK_DEFS.length) + TRACK_DEFS.length) % TRACK_DEFS.length;
  const def = TRACK_DEFS[menuIndex]!;

  if (trackCardsEl) {
    const cards = trackCardsEl.querySelectorAll<HTMLElement>('.track-card');
    cards.forEach((card, i) => card.classList.toggle('selected', i === menuIndex));
  }
  if (lobbyEl?.classList.contains('show')) updateLobbyView();
  updateTrackHint();
}

/** 切换单人 / 双人 / 联机。手机端强制单人，因为只有一套触屏控件。 */
function setMode(mode: GameMode): void {
  if (mode === 3) {
    openOnlineLobby();
    return;
  }

  if (mode === 2 && input.isTouch) mode = 1;
  if (net.inRoom) leaveRoom();
  onlineMode = false;
  onlineHost = false;
  closeOnlineLobby();
  pendingMode = mode;
  twoPlayer = mode === 2;
  input.setTwoPlayer(twoPlayer);
  rebuildActiveRacers();
  updateModeButtons();
  updateTrackHint();

  if (raceState !== 'menu') {
    document.body.classList.toggle('duo', twoPlayer);
    bindTrack();
    resetRace();
  }
}

/** 开始比赛：单人 / 双人直接开；联机由房主通知服务器，双方收到 start 后再开。 */
function startRace(): void {
  if (pendingMode === 3) {
    if (!net.inRoom) {
      openOnlineLobby();
      return;
    }
    if (!net.isHost) {
      setLobbyStatus('等待房主开始比赛…');
      return;
    }
    // 重复点开始 / 已在比赛中：不再发第二次 start，否则整局会被重置
    if (net.roomState === 'racing' || raceState !== 'menu') {
      setLobbyStatus('比赛已经开始');
      return;
    }
    net.start(TRACK_DEFS[menuIndex]!.id);
    return;
  }
  startLocalRace();
}

function startLocalRace(): void {
  if (input.isTouch && pendingMode === 2) pendingMode = 1;
  onlineMode = false;
  onlineHost = false;
  localRacer = player;
  twoPlayer = pendingMode === 2;
  input.setTwoPlayer(twoPlayer);

  const def = TRACK_DEFS[menuIndex]!;
  document.body.classList.remove('menu');
  document.body.classList.remove('finished');
  document.body.classList.toggle('duo', twoPlayer);
  rebuildActiveRacers();
  applyTrack(def);
  // 选图时小地图被隐藏，尺寸为 0；显示后强制重算一次投影
  minimap1?.resize();
  minimap2?.resize();
  resizeCameras();
}

function namesFromPlayers(players: NetPlayer[]): { host: string; guest: string } {
  return {
    host: players.find((p) => p.slot === 0)?.name ?? '房主',
    guest: players.find((p) => p.slot === 1)?.name ?? '玩家',
  };
}

/** 双方收到 start 后进入联机比赛。房主开始跑物理，客机等快照。 */
function beginOnlineRace(msg: NetStart): void {
  onlineMode = true;
  onlineHost = net.isHost;
  twoPlayer = false;
  pendingMode = 3;
  input.setTwoPlayer(false);
  onlineNames = namesFromPlayers(msg.players);
  if (msg.players.length < 2) onlineNames.guest = '电脑';

  const def = TRACK_DEFS.find((d) => d.id === msg.trackId) ?? TRACK_DEFS[0]!;
  menuIndex = Math.max(0, TRACK_DEFS.indexOf(def));
  closeOnlineLobby();

  document.body.classList.remove('menu', 'finished', 'duo');
  rebuildActiveRacers();
  player.bestTime = 0;
  player2.bestTime = 0;
  applyTrack(def);

  localRacer = onlineHost ? player : player2;
  setDynamicNameTag(player, onlineNames.host, '#ffd23f');
  setDynamicNameTag(player2, onlineNames.guest, '#ffb066');
  const tag = document.querySelector<HTMLElement>('#hudP1 .ph-tag');
  if (tag) tag.textContent = localRacer.name;

  minimap1?.resize();
  minimap2?.resize();
  resizeCameras();

  resetNetReplayState();
}

/** 离开房间 / 结束联机：清理网络状态和动态名字牌。 */
function leaveRoom(): void {
  if (net.inRoom) net.leave();
  onlineMode = false;
  onlineHost = false;
  netBuffer.length = 0;
  lastSnapshot = null;
  remoteInput.throttle = 0;
  remoteInput.brake = 0;
  remoteInput.steer = 0;
  remoteInput.drift = false;
  localRacer = player;
  clearDynamicNameTag(player);
  setDynamicNameTag(player2, 'P2', '#ffb066');
  player.name = '你';
  player2.name = 'P2';
  const tag = document.querySelector<HTMLElement>('#hudP1 .ph-tag');
  if (tag) tag.textContent = 'P1';
}

/** 完赛 / 返回：冻结比赛，显示选图层。 */
function openTrackMenu(): void {
  if (onlineMode || net.inRoom) leaveRoom();
  closeOnlineLobby();
  raceState = 'menu';
  document.body.classList.add('menu');
  document.body.classList.remove('finished');
  document.body.classList.remove('duo');
  input.releaseTouch();
  hideFinishOverlay();
  const el = document.getElementById('countdown');
  if (el) {
    el.textContent = '';
    el.classList.remove('show', 'go');
  }
  lastCountdownText = '';
  const idx = TRACK_DEFS.findIndex((d) => d.id === track.def.id);
  selectTrack(idx >= 0 ? idx : 0);
  rebuildActiveRacers();
  resizeCameras();
}

// ---------------- 大厅 UI ----------------
/** 关闭大厅时回到打开前的模式，避免按 Esc 后仍停在「联机」。 */
let lobbyReturnMode: 1 | 2 = 1;

function openOnlineLobby(): void {
  if (!lobbyEl) return;
  if (raceState !== 'menu') openTrackMenu();
  if (pendingMode !== 3) lobbyReturnMode = pendingMode === 2 ? 2 : 1;

  pendingMode = 3;
  twoPlayer = false;
  onlineMode = false;
  onlineHost = false;
  input.setTwoPlayer(false);
  document.body.classList.remove('duo');
  rebuildActiveRacers();
  updateModeButtons();
  updateTrackHint();
  lobbyEl.classList.add('show');
  updateLobbyView();
  if (!net.inRoom) {
    setLobbyStatus(net.connected ? '已连接房间服务器' : '创建或加入房间后开始');
  }
}

function closeOnlineLobby(): void {
  lobbyEl?.classList.remove('show');
  if (net.inRoom || onlineMode || pendingMode !== 3) return;

  pendingMode = lobbyReturnMode;
  twoPlayer = pendingMode === 2;
  input.setTwoPlayer(twoPlayer);
  rebuildActiveRacers();
  updateModeButtons();
  updateTrackHint();
}

function setLobbyStatus(message: string, isError = false): void {
  for (const el of [olStatusEl, olRoomStatusEl]) {
    if (!el) continue;
    el.textContent = message;
    el.classList.toggle('error', isError);
  }
}

function updateLobbyView(): void {
  if (!lobbyEl) return;
  const inRoom = net.inRoom;
  if (olSetupEl) olSetupEl.hidden = inRoom;
  if (olRoomEl) olRoomEl.hidden = !inRoom;
  if (!inRoom) return;

  if (olCodeShowEl) olCodeShowEl.textContent = net.code || '----';
  if (olTrackEl) olTrackEl.textContent = `赛道：${TRACK_DEFS[menuIndex]?.name ?? '翡翠森林'}`;

  if (olPlayersEl) {
    olPlayersEl.textContent = '';
    for (const p of net.players) {
      const li = document.createElement('li');
      li.className = 'ol-player';

      const dot = document.createElement('span');
      dot.className = 'ol-dot';
      dot.style.background = p.slot === 0 ? '#ffd23f' : '#ff9a3d';

      const name = document.createElement('span');
      name.className = 'ol-pname';
      name.textContent = p.name;

      const tag = document.createElement('span');
      tag.className = 'ol-ptag';
      const role = p.id === net.hostId ? '房主' : '玩家';
      tag.textContent = p.id === net.selfId ? `${role} · 你` : role;

      li.append(dot, name, tag);
      olPlayersEl.append(li);
    }

    if (net.players.length < 2) {
      const li = document.createElement('li');
      li.className = 'ol-player waiting';

      const dot = document.createElement('span');
      dot.className = 'ol-dot';

      const name = document.createElement('span');
      name.className = 'ol-pname';
      name.textContent = '等待另一位玩家…';

      const tag = document.createElement('span');
      tag.className = 'ol-ptag';
      tag.textContent = '空位';

      li.append(dot, name, tag);
      olPlayersEl.append(li);
    }
  }

  if (olStartEl) olStartEl.hidden = !net.isHost;
  setLobbyStatus(
    net.isHost
      ? '把房间码发给朋友；开始后空位由 AI 补齐'
      : '等待房主开始比赛…',
  );
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : '联机出错';
}

const hudNetEl = document.getElementById('hudNet');

/**
 * 联机延迟显示。
 * 房主显示「本机 ↔ 服务器」，客机显示「本机输入 → 房主 → 本机」（含房主处理与回程）。
 */
function updateNetHud(): void {
  if (!hudNetEl) return;
  if (!onlineMode || raceState === 'menu') {
    hudNetEl.hidden = true;
    return;
  }
  hudNetEl.hidden = false;
  const ms = onlineHost ? serverRtt : linkRtt;
  const label = onlineHost ? '服务器' : '链路';
  if (!(ms > 0)) {
    hudNetEl.textContent = `${label} --`;
    hudNetEl.dataset.level = 'unknown';
    return;
  }
  hudNetEl.textContent = `${label} ${Math.round(ms)}ms`;
  hudNetEl.dataset.level = ms <= 120 ? 'good' : ms <= 250 ? 'ok' : 'bad';
}

// ---------------- 网络事件 ----------------
net.onRoom = (room) => {
  updateLobbyView();
  // 客机中途掉线：房主让 AI 接管橙色车，比赛继续
  if (onlineMode && onlineHost && room.players.length < 2 && raceState !== 'menu') {
    // 先清掉客机残留输入，避免 AI 接管瞬间还带着旧油门/转向
    remoteInput.throttle = 0;
    remoteInput.brake = 0;
    remoteInput.steer = 0;
    remoteInput.drift = false;
    if (!player2.autopilot) {
      player2.autopilot = true;
      player2.driver = new AiDriver(track, player2.kart, CRUISE_SPEC);
      player2.name = '离线玩家';
      setDynamicNameTag(player2, '离线玩家', '#9aa4b2');
    }
  }
};

net.onStart = (msg) => {
  beginOnlineRace(msg);
};

net.onInput = (_id, input, _seq, ts) => {
  if (!onlineMode || !onlineHost) return;
  if (ts > 0) peerEchoTs = ts;
  remoteInput.throttle = Math.max(0, Math.min(1, Number(input.throttle) || 0));
  remoteInput.brake = Math.max(0, Math.min(1, Number(input.brake) || 0));
  remoteInput.steer = Math.max(-1, Math.min(1, Number(input.steer) || 0));
  remoteInput.drift = !!input.drift;
};

net.onPong = (ts) => {
  if (!(ts > 0)) return;
  const rtt = performance.now() - ts;
  if (!(rtt >= 0 && rtt < 10_000)) return;
  serverRtt = serverRtt === 0 ? rtt : serverRtt * 0.7 + rtt * 0.3;
};

net.onState = (snapshot) => {
  if (isOnlineGuest()) applySnapshot(snapshot);
};

net.onRestart = () => {
  if (isOnlineGuest()) resetRace();
};

net.onRequestRestart = () => {
  if (onlineMode && onlineHost) {
    net.restart();
    resetRace();
  }
};

net.onRoomClosed = (reason) => {
  const wasRacing = onlineMode;
  leaveRoom();
  if (wasRacing) openTrackMenu();
  openOnlineLobby();
  setLobbyStatus(reason, true);
};

net.onError = (message) => {
  setLobbyStatus(message, true);
};

net.onClose = (wasInRoom) => {
  const wasRacing = onlineMode;
  leaveRoom();
  if (wasRacing) openTrackMenu();
  openOnlineLobby();
  setLobbyStatus(wasInRoom || wasRacing ? '与房间服务器断开' : '无法连接房间服务器', true);
};

function restartRace(): void {
  if (onlineMode) {
    if (onlineHost) {
      net.restart();
      resetRace();
    } else {
      net.requestRestart();
    }
    return;
  }
  resetRace();
}

try {
  const savedName = localStorage.getItem('kart.playerName');
  if (savedName && olNameEl) olNameEl.value = savedName;
} catch {
  // 隐私模式 / 禁用 localStorage 时忽略
}

function lobbyName(): string {
  const name = olNameEl?.value.trim() || '玩家';
  try {
    localStorage.setItem('kart.playerName', name);
  } catch {
    // 忽略
  }
  return name;
}

/** 创建 / 加入正在进行时忽略重复点击，避免并发请求把状态覆盖成错误。 */
let lobbyBusy = false;

async function withLobbyBusy(fn: () => Promise<void>): Promise<void> {
  if (lobbyBusy) return;
  lobbyBusy = true;
  try {
    await fn();
  } finally {
    lobbyBusy = false;
  }
}

async function joinRoomFromLobby(): Promise<void> {
  const code = olCodeEl?.value.trim().toUpperCase() ?? '';
  if (code.length !== 4) {
    setLobbyStatus('请输入 4 位房间码', true);
    return;
  }
  await withLobbyBusy(async () => {
    setLobbyStatus('正在加入房间…');
    try {
      await net.joinRoom(code, lobbyName());
    } catch (err) {
      setLobbyStatus(errorText(err), true);
    }
  });
}

document.getElementById('olCreate')?.addEventListener('click', () => {
  void withLobbyBusy(async () => {
    setLobbyStatus('正在创建房间…');
    try {
      await net.createRoom(lobbyName());
    } catch (err) {
      setLobbyStatus(errorText(err), true);
    }
  });
});

document.getElementById('olJoin')?.addEventListener('click', () => {
  void joinRoomFromLobby();
});

olCodeEl?.addEventListener('input', () => {
  olCodeEl.value = olCodeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
});

olCodeEl?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void joinRoomFromLobby();
  }
});

document.getElementById('olLeave')?.addEventListener('click', () => {
  leaveRoom();
  openTrackMenu();
  openOnlineLobby();
  setLobbyStatus('已离开房间');
});

document.getElementById('olStart')?.addEventListener('click', startRace);

document.getElementById('olClose')?.addEventListener('click', () => {
  closeOnlineLobby();
});

document.getElementById('olCopy')?.addEventListener('click', async () => {
  if (!net.code) return;
  try {
    await navigator.clipboard.writeText(net.code);
    setLobbyStatus('房间码已复制');
  } catch {
    setLobbyStatus(`房间码：${net.code}`);
  }
});

buildTrackCards();
updateModeButtons();

document.getElementById('trackStart')?.addEventListener('click', startRace);
// 手机没有 R 键，完赛遮罩里放一个「再来一局」
document.getElementById('finishRestart')?.addEventListener('click', restartRace);
document.getElementById('finishSelect')?.addEventListener('click', openTrackMenu);
document.querySelectorAll<HTMLElement>('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const mode = Number(btn.dataset.mode);
    setMode(mode === 3 ? 3 : mode === 2 ? 2 : 1);
  });
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

  if (e.code === 'Escape' && lobbyEl?.classList.contains('show')) {
    closeOnlineLobby();
    e.preventDefault();
    return;
  }

  if (raceState === 'menu') {
    if (e.code === 'ArrowLeft') {
      selectTrack(menuIndex - 1);
      e.preventDefault();
    } else if (e.code === 'ArrowRight') {
      selectTrack(menuIndex + 1);
      e.preventDefault();
    } else if (e.code === 'Enter') {
      startRace();
      e.preventDefault();
    } else if (e.code === 'Digit1' || e.code === 'Numpad1') {
      setMode(1);
      e.preventDefault();
    } else if (e.code === 'Digit2' || e.code === 'Numpad2') {
      setMode(2);
      e.preventDefault();
    } else if (e.code === 'Digit3' || e.code === 'Numpad3') {
      openOnlineLobby();
      e.preventDefault();
    }
    return;
  }

  if (e.code === 'KeyR') restartRace();
  if (e.code === 'KeyM') audio.toggleMute();
  if (e.code === 'Escape') openTrackMenu();
});

window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(BASE_DPR * resScale);
  renderer.setSize(w, h);
  resizeCameras();
  postfx.setSize();
  minimap1?.resize();
  minimap2?.resize();
});

// ---------------- 动态分辨率 ----------------
// 后处理是填充率瓶颈，按实测帧时间自动缩放渲染分辨率。
// 目标是「贴着显示器刷新率跑」，而不是固定画质。
let resScale = 1;
let resCooldown = 1.5;
let statAcc = 0;
let statCount = 0;
let statMin = 1;

function applyResolution(): void {
  renderer.setPixelRatio(BASE_DPR * resScale);
  renderer.setSize(window.innerWidth, window.innerHeight);
  postfx.setSize();
}

function updateDynamicResolution(dt: number): void {
  statAcc += dt;
  statCount++;
  if (dt < statMin) statMin = dt;

  resCooldown -= dt;
  if (resCooldown > 0 || statCount < 12) return;

  const avg = statAcc / statCount;
  // 用窗口内的最快帧估算刷新率，60Hz 屏就不会被误判成性能不足
  const target = Math.max(statMin * 1.12, 1 / 240);
  const prev = resScale;

  if (avg > target * 1.16 && resScale > 0.62) {
    resScale = Math.max(0.62, resScale - 0.09);
    resCooldown = 0.7;
  } else if (avg < target * 0.96 && resScale < 1) {
    resScale = Math.min(1, resScale + 0.05);
    resCooldown = 1.4;
  } else {
    resCooldown = 0.5;
  }

  if (Math.abs(resScale - prev) > 0.001) applyResolution();

  statAcc = 0;
  statCount = 0;
  statMin = 1;
}

// ---------------- 粒子用临时对象 ----------------
const smokeColor = new THREE.Color(0xd9dee4);
const dustColor = new THREE.Color(0xcbbfa8);
const boostColor = new THREE.Color(0xffa347);
const tp = new THREE.Vector3();
const tv = new THREE.Vector3();
const sceneryFocus = new THREE.Vector3();

function localToWorld(k: Kart, lx: number, lz: number, out: { x: number; z: number }): void {
  const s = Math.sin(k.heading);
  const c = Math.cos(k.heading);
  out.x = k.pos.x + lx * c + lz * s;
  out.z = k.pos.z - lx * s + lz * c;
}

const out2 = { x: 0, z: 0 };

// ---------------- 车与车碰撞 ----------------
const CAR_RADIUS = 2.0;

function collideKarts(): void {
  for (let i = 0; i < allKarts.length; i++) {
    const a = allKarts[i]!;
    for (let j = i + 1; j < allKarts.length; j++) {
      const b = allKarts[j]!;
      if (Math.abs(a.pos.y - b.pos.y) > 2.2) continue;

      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      let d2 = dx * dx + dz * dz;
      if (d2 > CAR_RADIUS * CAR_RADIUS) continue;

      let d = Math.sqrt(d2);
      if (d < 1e-4) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      const nx = dx / d;
      const nz = dz / d;
      const overlap = CAR_RADIUS - d;

      // 位置各退一半，避免高速追尾时叠在一起
      a.pos.x -= nx * overlap * 0.5;
      a.pos.z -= nz * overlap * 0.5;
      b.pos.x += nx * overlap * 0.5;
      b.pos.z += nz * overlap * 0.5;

      const rv = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
      if (rv < 0) {
        const imp = -rv * 0.7;
        a.vel.x -= nx * imp * 0.5;
        a.vel.z -= nz * imp * 0.5;
        b.vel.x += nx * imp * 0.5;
        b.vel.z += nz * imp * 0.5;
        const hit = Math.min(1, -rv * 0.12);
        a.wallHit = Math.max(a.wallHit, hit);
        b.wallHit = Math.max(b.wallHit, hit);
      }
    }
  }
}

// ---------------- 加速带 ----------------
function updateBoostPads(dt: number): void {
  const pads = track.layout.boostPads;
  for (const r of racers) {
    // 客机只预测自己的车；其他车的加速带由房主快照体现
    if (isOnlineGuest() && r !== localRacer) continue;
    r.boostCooldown = Math.max(0, r.boostCooldown - dt);
    if (r.boostCooldown > 0) continue;
    for (const pad of pads) {
      const dx = r.kart.pos.x - pad.x;
      const dz = r.kart.pos.z - pad.z;
      if (dx * dx + dz * dz > pad.radius * pad.radius) continue;
      if (Math.abs(r.kart.pos.y - pad.y) > 2.6) continue;
      r.kart.applyBoost(pad.boostTime, 3.2);
      r.boostCooldown = 0.85;
      break;
    }
  }
}

// ---------------- 名次 ----------------
function rankOf(r: Racer): number {
  if (r.finished) {
    let rank = 1;
    for (const o of racers) {
      if (o !== r && o.finished && o.finishTime > 0 && o.finishTime < r.finishTime) rank++;
    }
    return rank;
  }

  const mine = r.lap + r.progress;
  let rank = 1;
  for (const o of racers) {
    if (o === r) continue;
    if (o.finished || o.lap + o.progress > mine) rank++;
  }
  return rank;
}

function activeHumans(): Racer[] {
  return racers.filter((r) => r.isPlayer);
}

function leadingHumanScore(): number {
  let best = 0;
  for (const r of racers) {
    if (!r.isPlayer) continue;
    best = Math.max(best, r.lap + r.progress);
  }
  return best;
}

function humanInput(r: Racer, locked: boolean): KartInput {
  if (onlineMode) {
    if (r === localRacer) {
      const block = locked || r.finished;
      return {
        throttle: block ? 0 : input.throttle,
        brake: block ? 0 : input.brake,
        steer: block ? 0 : input.steer,
        drift: block ? false : input.drift,
      };
    }
    if (onlineHost && r === player2) {
      if (locked || r.finished) {
        return { throttle: 0, brake: 0, steer: 0, drift: false };
      }
      return remoteInput;
    }
    return { throttle: 0, brake: 0, steer: 0, drift: false };
  }

  if (r.playerSlot === 0) {
    return {
      throttle: locked ? 0 : input.throttle,
      brake: locked ? 0 : input.brake,
      steer: locked ? 0 : input.steer,
      drift: locked ? false : input.drift,
    };
  }
  return {
    throttle: locked ? 0 : input.throttle2,
    brake: locked ? 0 : input.brake2,
    steer: locked ? 0 : input.steer2,
    drift: locked ? false : input.drift2,
  };
}

// ---------------- 联机快照 ----------------
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** 房主：把当前 4 台车打包成快照。 */
function buildSnapshot(): NetSnapshot {
  const state: NetSnapshot['state'] =
    raceState === 'countdown' ? 'countdown' : raceState === 'finished' ? 'finished' : 'racing';

  return {
    tick: ++snapshotTick,
    time: round2(raceTime),
    state,
    countdown: round2(countdown),
    laps: totalLaps,
    echoTs: peerEchoTs > 0 ? peerEchoTs : undefined,
    karts: racers.map((r) => {
      const k = r.kart;
      return {
        x: round2(k.pos.x),
        y: round2(k.pos.y),
        z: round2(k.pos.z),
        h: round3(k.heading),
        speed: round2(k.vel.length()),
        kmh: Math.round(k.speedKmh),
        charge: round2(k.charge),
        drift: k.drifting,
        boost: round2(k.boostFlash),
        boostTimer: round2(k.boostTimer),
        slip: round2(k.slipAngle),
        grounded: k.grounded,
        pitch: round3(r.visualPitch),
        lap: r.lap,
        progress: round3(r.progress),
        finished: r.finished,
        finishTime: round2(r.finishTime),
        finishRank: r.finishRank,
        lapTime: round2(r.lapTime),
        bestTime: round2(r.bestTime),
      };
    }),
  };
}

/** 客机：收到房主快照，更新比赛状态和圈速（位置在 update 里插值）。 */
function applySnapshot(snapshot: NetSnapshot): void {
  const wasCountdown = raceState === 'countdown';
  lastSnapshot = snapshot;
  netBuffer.push({ at: netClock, snap: snapshot });
  if (netBuffer.length > 90) netBuffer.shift();

  // 客机：房主回显了我们的输入时间戳 → 算 输入→房主→回到本机 的往返
  const echo = Number(snapshot.echoTs ?? 0);
  if (echo > 0) {
    const rtt = performance.now() - echo;
    if (rtt >= 0 && rtt < 3000) {
      linkRtt = linkRtt === 0 ? rtt : linkRtt * 0.7 + rtt * 0.3;
    }
  }

  raceState = snapshot.state;
  countdown = snapshot.countdown;
  raceTime = snapshot.time;
  totalLaps = snapshot.laps;
  if (wasCountdown && snapshot.state === 'racing') goTimer = 0.85;

  for (let i = 0; i < snapshot.karts.length && i < racers.length; i++) {
    const s = snapshot.karts[i]!;
    const r = racers[i]!;
    r.lap = s.lap;
    r.progress = s.progress;
    r.finished = s.finished;
    r.finishTime = s.finishTime;
    r.finishRank = s.finishRank;
    r.lapTime = s.lapTime;
    r.bestTime = s.bestTime;
    r.autopilot = s.finished;
  }

  if (snapshot.state === 'finished') {
    if (!document.getElementById('finish')?.classList.contains('show')) showFinishOverlay();
  } else if (document.getElementById('finish')?.classList.contains('show')) {
    hideFinishOverlay();
  }
}

/** 从快照缓冲里取两台快照之间的插值，远端车看起来才顺。 */
function sampleKart(index: number, at: number): NetKartSnapshot | null {
  const buf = netBuffer;
  if (buf.length === 0) return null;

  const first = buf[0]!;
  const last = buf[buf.length - 1]!;
  let a = first;
  let b = last;

  if (at <= first.at) {
    a = first;
    b = first;
  } else if (at >= last.at) {
    a = last;
    b = last;
  } else {
    for (let i = 0; i < buf.length - 1; i++) {
      const lo = buf[i]!;
      const hi = buf[i + 1]!;
      if (lo.at <= at && hi.at >= at) {
        a = lo;
        b = hi;
        break;
      }
    }
  }

  const ka = a.snap.karts[index];
  const kb = b.snap.karts[index];
  if (!ka || !kb) return null;

  const span = b.at - a.at;
  const t = span > 1e-4 ? Math.max(0, Math.min(1, (at - a.at) / span)) : 1;
  return {
    ...kb,
    x: ka.x + (kb.x - ka.x) * t,
    y: ka.y + (kb.y - ka.y) * t,
    z: ka.z + (kb.z - ka.z) * t,
    h: lerpAngle(ka.h, kb.h, t),
    speed: ka.speed + (kb.speed - ka.speed) * t,
  };
}

/** 客机：本地车做预测 + 误差回拉；远端车直接套插值快照。 */
function applyOnlineGuest(dt: number): void {
  if (!lastSnapshot) return;
  const renderAt = netClock - 0.1;

  for (let i = 0; i < racers.length; i++) {
    const r = racers[i]!;
    const latest = lastSnapshot.karts[i];

    // 本地车用最新权威状态回拉（不能拿 100 ms 前的插值，否则一直被往回拽）
    if (r === localRacer) {
      if (latest) correctLocal(r, latest, dt);
      continue;
    }

    const s = sampleKart(i, renderAt) ?? latest;
    if (!s) continue;

    const k = r.kart;
    k.pos.set(s.x, s.y, s.z);
    k.heading = s.h;
    k.vel.set(Math.sin(s.h) * s.speed, 0, Math.cos(s.h) * s.speed);
    k.speedKmh = s.kmh;
    k.charge = s.charge;
    k.drifting = s.drift;
    k.boostFlash = s.boost;
    k.boostTimer = s.boostTimer;
    k.slipAngle = s.slip;
    k.grounded = s.grounded;
    k.groundSlope = Math.tan(Math.max(-1.2, Math.min(1.2, -s.pitch)));
    r.visualPitch = s.pitch;
    r.fxBoost = Math.max(r.fxBoost, s.boost);
  }

  const lk = localRacer.kart;
  if (!Number.isFinite(lk.pos.x) || !Number.isFinite(lk.pos.z)) {
    const pose = track.getPoseAt(0.02);
    lk.reset(pose.pos, pose.heading);
  }
}

function correctLocal(r: Racer, s: NetKartSnapshot, dt: number): void {
  const k = r.kart;
  const err = Math.hypot(k.pos.x - s.x, k.pos.z - s.z);

  // 误差太大或已经完赛（房主 AI 接管）时直接对齐，别让本地预测跑飞
  if (!Number.isFinite(k.pos.x) || !Number.isFinite(k.pos.z) || err > 6 || r.finished) {
    k.pos.set(s.x, s.y, s.z);
    k.heading = s.h;
    if (r.finished) k.vel.set(Math.sin(s.h) * s.speed, 0, Math.cos(s.h) * s.speed);
    return;
  }

  const t = 1 - Math.exp(-10 * dt);
  k.pos.x += (s.x - k.pos.x) * t;
  k.pos.y += (s.y - k.pos.y) * t;
  k.pos.z += (s.z - k.pos.z) * t;
  k.heading = lerpAngle(k.heading, s.h, t);
  // 速度也向权威值收敛，否则纠偏后本地速度又把车推走，形成来回拉
  const vx = Math.sin(k.heading) * s.speed;
  const vz = Math.cos(k.heading) * s.speed;
  k.vel.x += (vx - k.vel.x) * t;
  k.vel.z += (vz - k.vel.z) * t;
}

/** 客机本地车只被远端车推开，不修改远端快照位置。 */
function collideLocalWithRemotes(): void {
  const a = localRacer.kart;
  for (const r of racers) {
    if (r === localRacer) continue;
    const b = r.kart;
    if (Math.abs(a.pos.y - b.pos.y) > 2.2) continue;

    let dx = b.pos.x - a.pos.x;
    let dz = b.pos.z - a.pos.z;
    let d2 = dx * dx + dz * dz;
    if (d2 > CAR_RADIUS * CAR_RADIUS) continue;

    let d = Math.sqrt(d2);
    if (d < 1e-4) {
      dx = 1;
      dz = 0;
      d = 1;
    }
    const nx = dx / d;
    const nz = dz / d;
    const overlap = CAR_RADIUS - d;

    a.pos.x -= nx * overlap;
    a.pos.z -= nz * overlap;

    const rv = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
    if (rv < 0) {
      const imp = -rv * 0.7;
      a.vel.x -= nx * imp;
      a.vel.z -= nz * imp;
      a.wallHit = Math.max(a.wallHit, Math.min(1, -rv * 0.12));
    }
  }
}

// ---------------- 倒计时 / 结算 UI ----------------
function countdownText(): string {
  if (raceState === 'countdown') return String(Math.min(3, Math.max(1, Math.ceil(countdown))));
  if (goTimer > 0) return 'GO!';
  return '';
}

function updateCountdownView(): void {
  const el = document.getElementById('countdown');
  if (!el) return;
  const text = countdownText();
  if (text === lastCountdownText) return;
  lastCountdownText = text;

  if (!text) {
    el.classList.remove('show', 'go');
    return;
  }

  el.textContent = text;
  el.classList.toggle('go', text === 'GO!');
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

function hideFinishOverlay(): void {
  document.getElementById('finish')?.classList.remove('show');
  document.body.classList.remove('finished');
}

function showFinishOverlay(): void {
  const list = document.getElementById('finishResults');
  if (list) {
    list.textContent = '';
    const sorted = [...racers].sort((a, b) => {
      if (a.finished && b.finished) return a.finishTime - b.finishTime;
      if (a.finished) return -1;
      if (b.finished) return 1;
      return b.lap + b.progress - (a.lap + a.progress);
    });

    sorted.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = `finish-row${r.isPlayer ? ' is-human' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'fr-rank';
      rank.textContent = String(i + 1);

      const dot = document.createElement('span');
      dot.className = 'fr-dot';
      dot.style.background = r.mapColor;

      const name = document.createElement('span');
      name.className = 'fr-name';
      name.textContent = r.name;

      const time = document.createElement('span');
      time.className = `fr-time${r.finished ? '' : ' fr-dnf'}`;
      time.textContent = r.finished ? formatTime(r.finishTime) : '未完赛';

      row.append(rank, dot, name, time);
      list.append(row);
    });
  }

  document.getElementById('finish')?.classList.add('show');
  document.body.classList.add('finished');
}

function endRace(): void {
  if (raceState === 'finished') return;
  raceState = 'finished';
  showFinishOverlay();
}

function allHumansFinished(): boolean {
  const humans = activeHumans();
  return humans.length > 0 && humans.every((r) => r.finished);
}

function hudStateFor(r: Racer): {
  speedKmh: number;
  charge: number;
  drifting: boolean;
  boostFlash: number;
  lapTime: number;
  bestTime: number;
  lap: number;
  totalLaps: number;
  rank: number;
  totalRacers: number;
  finished: boolean;
  finishRank: number;
  finishTime: number;
} {
  return {
    speedKmh: r.kart.speedKmh,
    charge: r.kart.charge,
    drifting: r.kart.drifting,
    boostFlash: r.kart.boostFlash,
    lapTime: r.lapTime,
    bestTime: r.bestTime,
    lap: r.lap,
    totalLaps,
    rank: rankOf(r),
    totalRacers: racers.length,
    finished: r.finished,
    finishRank: r.finishRank,
    finishTime: r.finishTime,
  };
}

// ---------------- 主循环 ----------------
const TICK = 1 / 120;
let last = performance.now();

function frame(now: number): void {
  requestAnimationFrame(frame);

  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  update(dt);
}

function update(dt: number): void {
  // 竖屏提示期间冻结比赛，转回横屏再继续。
  // 直接按视口比例判断，不依赖 resize / orientationchange 事件的到达时机。
  if (
    document.body.classList.contains('touch') &&
    window.innerHeight > window.innerWidth
  ) {
    if (!document.body.classList.contains('portrait')) {
      document.body.classList.add('portrait');
    }
    input.releaseTouch();
    return;
  }
  document.body.classList.remove('portrait');

  netClock += dt;

  // 本帧第一次场景渲染时更新一次阴影贴图（autoUpdate 已关闭）
  renderer.shadowMap.needsUpdate = true;

  // 选图时只渲染静态背景（选图层自带模糊遮罩），比赛逻辑完全冻结
  if (raceState === 'menu') {
    if (hudNetEl && !hudNetEl.hidden) hudNetEl.hidden = true;
    postfx.render(scene, cam1.camera, { boost: 0, flash: 0, speed: 0 }, dt);
    updateDynamicResolution(dt);
    return;
  }

  input.update(dt);
  const guest = isOnlineGuest();

  // ---------------- 倒计时 ----------------
  // 客机的倒计时和比赛状态由房主快照驱动，本地不自己数
  if (raceState === 'countdown' && !guest) {
    countdown -= dt;
    if (countdown <= 0) {
      raceState = 'racing';
      goTimer = 0.85;
      raceTime = 0;
      for (const r of racers) {
        if (r.isPlayer) r.lapTime = 0;
      }
    }
  } else if (goTimer > 0) {
    goTimer -= dt;
  }
  if (raceState !== 'countdown' && !guest) raceTime += dt;
  if (raceState === 'racing') {
    for (const r of racers) {
      if (r.isPlayer && !r.finished && (!guest || r === localRacer)) r.lapTime += dt;
    }
  }

  const locked = raceState === 'countdown';
  // 倒计时和赛后结算都锁真人输入；AI 巡航不受影响，完赛后继续跑
  const humanLocked = locked || raceState === 'finished';

  // ---------------- AI 决策 ----------------
  const leadHuman = leadingHumanScore();
  for (const r of racers) {
    if (!r.driver) continue;
    if (locked) {
      r.driver.input.throttle = 0;
      r.driver.input.brake = 0;
      r.driver.input.steer = 0;
      r.driver.input.drift = false;
    } else {
      r.driver.think(dt, allKarts, leadHuman, r.lap + r.progress);
    }
  }

  // ---------------- 物理 ----------------
  acc += dt;
  let steps = 0;
  while (acc >= TICK && steps < 10) {
    if (guest) {
      // 客机只预测自己的车；其他车由快照插值
      const me = localRacer;
      if (!me.finished) {
        me.kart.step(TICK, humanInput(me, humanLocked));
        track.collide(me.kart);
        collideLocalWithRemotes();
        track.collide(me.kart);
      }
    } else {
      for (const r of racers) {
        const inp = r.driver ? r.driver.input : humanInput(r, humanLocked);
        r.kart.step(TICK, inp);
      }
      // 先让车互相推开，再夹一次护栏 —— 否则碰撞可能把车顶到护栏外面
      for (const r of racers) track.collide(r.kart);
      collideKarts();
      for (const r of racers) track.collide(r.kart);
    }
    acc -= TICK;
    steps++;
  }
  if (steps >= 10) acc = 0;

  updateBoostPads(dt);

  // ---------------- 进度 / 圈数 ----------------
  // 联机客机不本地计圈，圈数 / 完赛 / 名次全部以房主快照为准
  if (!guest) {
    for (const r of racers) {
      r.progress = track.progressAt(r.kart.pos);

      // 数值兜底：万一出现 NaN 就放回赛道
      const p = r.kart.pos;
      if (
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        !Number.isFinite(p.z) ||
        !Number.isFinite(r.kart.heading)
      ) {
        const pose = track.getPoseAt(Math.max(0, Math.min(0.999, r.progress)));
        r.kart.reset(pose.pos, pose.heading);
        r.driver?.reset();
      }

      if (!locked && !r.finished && r.lastProgress > 0.75 && r.progress < 0.25) {
        r.lap++;

        if (r.isPlayer) {
          if (r.bestTime <= 0 || r.lapTime < r.bestTime) r.bestTime = r.lapTime;
          r.lapTime = 0;
        }

        if (r.lap >= totalLaps) {
          r.finished = true;
          r.finishTime = raceTime;
          r.finishRank = 1;
          for (const o of racers) {
            if (o !== r && o.finished && o.finishTime > 0 && o.finishTime < r.finishTime) {
              r.finishRank++;
            }
          }

          // 真人完赛后交给 AI 巡航，别停在终点线挡路
          if (r.isPlayer) {
            r.autopilot = true;
            r.driver = new AiDriver(track, r.kart, CRUISE_SPEC);
          }

          if (allHumansFinished()) endRace();
        }
      }
      r.lastProgress = r.progress;
    }
  } else {
    applyOnlineGuest(dt);
  }

  // ---------------- 车辆视觉 ----------------
  for (const r of racers) {
    const k = r.kart;
    const spd = k.vel.length();

    // 车身俯仰：贴地时跟随地面坡度，腾空时跟随抛物线
    let targetPitch: number;
    if (k.grounded) {
      targetPitch = -Math.atan(k.groundSlope);
    } else {
      targetPitch = -Math.atan2(k.velY, Math.max(10, spd)) * 0.8;
      targetPitch = Math.max(-0.45, Math.min(0.45, targetPitch));
    }
    r.visualPitch += (targetPitch - r.visualPitch) * (1 - Math.exp(-14 * dt));

    r.visual.group.position.copy(k.pos);
    r.visual.group.rotation.set(r.visualPitch, k.heading, 0);

    const steer = r.driver
      ? r.driver.input.steer
      : onlineMode
        ? r === localRacer
          ? input.steer
          : r === player2
            ? remoteInput.steer
            : 0
        : r.playerSlot === 1
          ? input.steer2
          : input.steer;
    const wantBoost = k.boostTimer > 0 ? 1 : 0;
    r.fxBoost += (wantBoost - r.fxBoost) * (1 - Math.exp(-(wantBoost > r.fxBoost ? 18 : 2.4) * dt));
    r.visual.update(dt, spd, steer, k.drifting, r.fxBoost);
  }

  // ---------------- 落地扬尘（真人） ----------------
  for (const r of racers) {
    if (!r.isPlayer) {
      r.prevLandImpact = r.kart.landImpact;
      continue;
    }
    if (r.kart.landImpact > r.prevLandImpact + 0.12) {
      audio.land(r.kart.landImpact);
      // 落地时车还在 40 m/s 往前冲，粒子必须够大、够久，才来得及在画面里被看见
      const count = Math.round(16 + r.kart.landImpact * 26);
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const rr = 0.3 + Math.random() * 1.1;
        tp.set(
          r.kart.pos.x + Math.cos(a) * rr,
          r.kart.pos.y + 0.1,
          r.kart.pos.z + Math.sin(a) * rr,
        );
        const outward = 1.0 + Math.random() * 2.2;
        tv.set(Math.cos(a) * outward, 0.6 + Math.random() * 1.4, Math.sin(a) * outward);
        particles.spawn(tp, tv, 0.55 + Math.random() * 0.4, 0.45 + Math.random() * 0.4, dustColor, 2.4);
      }
    }
    r.prevLandImpact = r.kart.landImpact;
  }

  // ---------------- 漂移烟雾 / 胎痕 ----------------
  for (const r of racers) {
    const k = r.kart;
    const spd = k.vel.length();

    if (k.drifting && spd > 5 && k.slipAngle > 0.22) {
      const rate = r.isPlayer ? 85 : 42;
      r.smokeAcc += dt * rate;
      while (r.smokeAcc >= 1) {
        r.smokeAcc -= 1;
        const side = Math.random() < 0.5 ? -0.84 : 0.84;
        localToWorld(k, side + (Math.random() - 0.5) * 0.3, -0.9 + (Math.random() - 0.5) * 0.3, out2);
        tp.set(out2.x, k.pos.y + 0.18 + Math.random() * 0.12, out2.z);
        tv.set((Math.random() - 0.5) * 2.6, 0.7 + Math.random() * 1.1, (Math.random() - 0.5) * 2.6);
        particles.spawn(tp, tv, 0.4 + Math.random() * 0.4, 0.24 + Math.random() * 0.2, smokeColor, 1.6);
      }
    } else {
      r.smokeAcc = 0;
    }

    if (k.drifting && spd > 4 && k.grounded) {
      const intensity = Math.min(1, k.slipAngle * 1.5);
      // 胎痕要贴后轮下方的地面，不能用车身高度：坡道上后轮和车身能差 0.15 m，
      // 用车身高度会让胎痕一半埋进路面、一半浮在空中。
      localToWorld(k, -0.84, -0.9, out2);
      r.skids.emit(0, out2.x, track.groundHeightAt(out2.x, out2.z) + 0.02, out2.z, intensity);
      localToWorld(k, 0.84, -0.9, out2);
      r.skids.emit(1, out2.x, track.groundHeightAt(out2.x, out2.z) + 0.02, out2.z, intensity);
    }
  }

  // ---------------- 真人冲刺火星 ----------------
  for (const r of racers) {
    if (!r.isPlayer) continue;
    const k = r.kart;
    if (k.boostTimer > 0) {
      r.boostAcc += dt * 210;
      const s = Math.sin(k.heading);
      const c = Math.cos(k.heading);
      while (r.boostAcc >= 1) {
        r.boostAcc -= 1;
        // 尾焰火星：小、快、越飞越小（不要像烟雾那样膨胀）
        const lx = Math.random() < 0.5 ? -0.34 : 0.34;
        localToWorld(k, lx, -1.2, out2);
        tp.set(out2.x, k.pos.y + 0.6 + Math.random() * 0.12, out2.z);
        const kick = 7 + Math.random() * 6;
        tv.set(
          -s * kick + (Math.random() - 0.5) * 1.2,
          Math.random() * 0.6 + 0.1,
          -c * kick + (Math.random() - 0.5) * 1.2,
        );
        particles.spawn(tp, tv, 0.1 + Math.random() * 0.08, 0.14 + Math.random() * 0.1, boostColor, -0.6);
      }
    } else {
      r.boostAcc = 0;
    }
  }

  particles.update(dt);

  for (const r of racers) r.skids.update(dt);

  // ---------------- 镜头 / 环境 ----------------
  cam1.setShake(
    Math.max(
      localRacer.fxBoost * 0.95,
      localRacer.kart.wallHit,
      localRacer.kart.landImpact * 1.2,
    ),
  );
  cam1.update(dt, localRacer.kart);
  if (twoPlayer && !onlineMode) {
    cam2.setShake(
      Math.max(player2.fxBoost * 0.95, player2.kart.wallHit, player2.kart.landImpact * 1.2),
    );
    cam2.update(dt, player2.kart);
  }

  // 本地双人时阴影焦点放在两台真人中间；联机只看自己的车
  if (onlineMode) {
    sceneryFocus.copy(localRacer.kart.pos);
  } else {
    sceneryFocus.set(0, 0, 0);
    let focusCount = 0;
    for (const r of racers) {
      if (!r.isPlayer) continue;
      sceneryFocus.add(r.kart.pos);
      focusCount++;
    }
    if (focusCount > 0) sceneryFocus.multiplyScalar(1 / focusCount);
  }
  scenery.update(sceneryFocus);
  track.update(dt);

  // ---------------- 音频 ----------------
  const localKart = localRacer.kart;
  audio.update(dt, {
    speed: localKart.vel.length(),
    maxSpeed: P.maxSpeed,
    drifting: localKart.drifting,
    slip: localKart.slipAngle,
    boostTimer: localKart.boostTimer,
    throttle: input.throttle,
  });

  // ---------------- 小地图 ----------------
  for (let i = 0; i < racers.length; i++) {
    const r = racers[i]!;
    const p1 = minimapPlayers1[i];
    if (p1) {
      p1.x = r.kart.pos.x;
      p1.z = r.kart.pos.z;
      p1.heading = r.kart.heading;
    }
    const p2 = minimapPlayers2[i];
    if (p2) {
      p2.x = r.kart.pos.x;
      p2.z = r.kart.pos.z;
      p2.heading = r.kart.heading;
    }
  }
  minimap1?.update(minimapPlayers1);
  if (twoPlayer && !onlineMode) minimap2?.update(minimapPlayers2);

  // ---------------- 联机收发 ----------------
  if (onlineMode) {
    pingAcc += dt;
    if (pingAcc >= 1) {
      pingAcc = 0;
      net.ping(performance.now());
    }

    if (onlineHost) {
      hostSnapAcc += dt;
      if (hostSnapAcc >= 1 / 30) {
        hostSnapAcc = 0;
        net.sendState(buildSnapshot());
      }
    } else {
      netSendAcc += dt;
      if (netSendAcc >= 1 / 30) {
        netSendAcc = 0;
        net.sendInput(
          {
            throttle: input.throttle,
            brake: input.brake,
            steer: input.steer,
            drift: input.drift,
          },
          ++netSeq,
          performance.now(),
        );
      }
    }
  }

  // ---------------- 延迟显示 ----------------
  netHudAcc += dt;
  if (netHudAcc >= 0.2) {
    netHudAcc = 0;
    updateNetHud();
  }

  // ---------------- HUD ----------------
  hud1.update(hudStateFor(localRacer));
  if (twoPlayer && !onlineMode) hud2.update(hudStateFor(player2));
  updateCountdownView();

  // ---------------- 渲染 ----------------
  if (twoPlayer && !onlineMode) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const half = Math.floor(size.x / 2);
    const views: SplitView[] = [
      {
        camera: cam1.camera,
        fx: {
          boost: player.fxBoost,
          flash: player.kart.boostFlash,
          speed: Math.min(1, player.kart.vel.length() / P.maxSpeed),
        },
        x: 0,
        y: 0,
        w: half,
        h: size.y,
      },
      {
        camera: cam2.camera,
        fx: {
          boost: player2.fxBoost,
          flash: player2.kart.boostFlash,
          speed: Math.min(1, player2.kart.vel.length() / P.maxSpeed),
        },
        x: half,
        y: 0,
        w: size.x - half,
        h: size.y,
      },
    ];
    postfx.renderSplit(scene, views, dt);
  } else {
    postfx.render(
      scene,
      cam1.camera,
      {
        boost: localRacer.fxBoost,
        flash: localRacer.kart.boostFlash,
        speed: Math.min(1, localRacer.kart.vel.length() / P.maxSpeed),
      },
      dt,
    );
  }

  updateDynamicResolution(dt);
}

openTrackMenu();

requestAnimationFrame(frame);

// 调试用句柄：浏览器控制台里可以直接摸到游戏对象
(window as unknown as Record<string, unknown>).__game = {
  kart: playerKart,
  player,
  player2,
  get racers() {
    return racers;
  },
  get allKarts() {
    return allKarts;
  },
  allRacers,
  get track() {
    return track;
  },
  get minimap() {
    return minimap1;
  },
  get minimap2() {
    return minimap2;
  },
  TRACK_DEFS,
  cam: cam1,
  cam1,
  cam2,
  hud1,
  hud2,
  input,
  particles,
  scene,
  renderer,
  postfx,
  net,
  resetRace,
  applyTrack,
  startRace,
  restartRace,
  openTrackMenu,
  selectTrack,
  setMode,
  endRace,
  openOnlineLobby,
  closeOnlineLobby,
  beginOnlineRace,
  buildSnapshot,
  applySnapshot,
  get localRacer() {
    return localRacer;
  },
  get online() {
    return onlineMode;
  },
  get onlineHost() {
    return onlineHost;
  },
  getRoomCode: () => net.code,
  getOnlinePlayers: () => net.players,
  getLastSnapshot: () => lastSnapshot,
  getRemoteInput: () => ({ ...remoteInput }),
  getNetSeq: () => netSeq,
  getNetStats: () => ({ serverRtt, linkRtt }),
  getTrackId: () => track.def.id,
  getMenuIndex: () => menuIndex,
  getMode: () => pendingMode,
  getTwoPlayer: () => twoPlayer,
  getTotalLaps: () => totalLaps,
  getRaceState: () => raceState,
  /**
   * 自动化测试用：手动推进 n 帧（每帧 dt 秒），不依赖 requestAnimationFrame。
   * 浏览器窗口失焦时 rAF 会被节流到 1~2 fps，脚本测试走这里才稳定。
   */
  tick: (n = 1, dt = 1 / 60): void => {
    for (let i = 0; i < n; i++) update(dt);
  },
};
