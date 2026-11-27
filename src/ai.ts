import * as THREE from 'three';
import { Kart, type KartInput } from './kart';
import type { Track } from './track';
import type { TrackPath } from './trackPath';
import { P } from './config';

export interface AiSpec {
  name: string;
  /** 相对玩家极速的比例：1 = 同速，0.9 = 慢 10% */
  pace: number;
  /** 0 = 只跑主路，1 = 看到捷径就走 */
  branchAffinity?: number;
}

interface RacingLine {
  path: TrackPath;
  n: number;
  spacing: number;
  closed: boolean;
  /** 每个采样点的目标世界坐标（已向弯心偏移） */
  px: Float32Array;
  pz: Float32Array;
  /** 平滑后的曲率（rad/m，正 = 左转） */
  curv: Float32Array;
}

const lineCache = new WeakMap<Track, RacingLine[]>();

/**
 * 赛车线：在中心线基础上向弯心偏移。
 * 曲率大的地方贴内侧，直道回到中间 —— 这样 AI 不会像电车一样死贴着中心线跑。
 */
function buildRacingLine(path: TrackPath): RacingLine {
  const n = path.count;
  const spacing = path.spacing;
  const closed = path.closed;
  const idxAt = (i: number): number =>
    closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i));

  const heading = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = path.points[idxAt(i - 1)]!;
    const b = path.points[idxAt(i + 1)]!;
    heading[i] = Math.atan2(b.x - a.x, b.z - a.z);
  }

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let d = heading[idxAt(i + 1)]! - heading[idxAt(i - 1)]!;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    raw[i] = d / (2 * spacing);
  }

  // 两级平滑：先把曲率抹平，再抹平偏移量，避免采样点级别的锯齿让 AI 画龙
  const smoothCurv = new Float32Array(n);
  const W = 12;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) sum += raw[idxAt(i + k)]!;
    smoothCurv[i] = sum / (2 * W + 1);
  }

  const rawOffset = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const maxOff = Math.min(5.2, Math.max(0, path.halfWidthAt(i) - 2.2));
    rawOffset[i] = Math.max(-maxOff, Math.min(maxOff, -smoothCurv[i] * 150));
  }

  const px = new Float32Array(n);
  const pz = new Float32Array(n);
  const W2 = 8;
  for (let i = 0; i < n; i++) {
    let off = 0;
    for (let k = -W2; k <= W2; k++) off += rawOffset[idxAt(i + k)]!;
    off /= 2 * W2 + 1;

    const p = path.points[i]!;
    const q = path.points[idxAt(i + 1)]!;
    const tx = q.x - p.x;
    const tz = q.z - p.z;
    const len = Math.hypot(tx, tz) || 1;
    // 右法向 = (-tz, tx) / len
    px[i] = p.x + (-tz / len) * off;
    pz[i] = p.z + (tx / len) * off;
  }

  return { path, n, spacing, closed, px, pz, curv: smoothCurv };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function wrapDelta(t: number): number {
  let d = t % 1;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

/**
 * 单个 AI 车手。每帧根据赛道曲率和前车位置产出一份和玩家完全相同的
 * KartInput，然后走同一套 Kart 物理 —— AI 不会作弊加速，只靠开得好。
 *
 * 现在 AI 会在分叉前评估支路：长度收益、加速带、风险、自己是否落后，
 * 再结合车手性格决定走哪条。进入支路后会一直跟到汇合口。
 */
export class AiDriver {
  readonly input: KartInput = { throttle: 0, brake: 0, steer: 0, drift: false };

  private readonly lines: RacingLine[];
  private line: RacingLine;
  private pathIndex = 0;
  private idx = 0;
  private stuck = 0;
  private reverse = 0;
  private lastErr = 1;
  private prevSteer = 0;
  private driftTimer = 0;
  private driftCooldown = 0;

  private chosenBranch: number | null = null;
  private branchCooldown = 0;
  private lastDecisionT = -1;

  constructor(
    private readonly track: Track,
    private readonly kart: Kart,
    readonly spec: AiSpec,
  ) {
    let lines = lineCache.get(track);
    if (!lines) {
      lines = track.paths.map((p) => buildRacingLine(p));
      lineCache.set(track, lines);
    }
    this.lines = lines;
    this.line = lines[0]!;
    this.reset();
  }

  reset(): void {
    let bestLine = 0;
    let bestIdx = 0;
    let bestD = Infinity;
    for (let li = 0; li < this.lines.length; li++) {
      const line = this.lines[li]!;
      const i = this.nearestOn(line, this.kart.pos.x, this.kart.pos.z, true);
      const p = line.path.points[i]!;
      const d = (this.kart.pos.x - p.x) ** 2 + (this.kart.pos.z - p.z) ** 2;
      if (d < bestD) {
        bestD = d;
        bestLine = li;
        bestIdx = i;
      }
    }
    this.pathIndex = bestLine;
    this.line = this.lines[bestLine]!;
    this.idx = bestIdx;
    this.stuck = 0;
    this.reverse = 0;
    this.lastErr = 1;
    this.prevSteer = 0;
    this.driftTimer = 0;
    this.driftCooldown = 0;
    this.chosenBranch = null;
    this.branchCooldown = 0;
    this.lastDecisionT = -1;
    this.input.throttle = 0;
    this.input.brake = 0;
    this.input.steer = 0;
    this.input.drift = false;
  }

  /** 在物理子步之前调用（每渲染帧一次即可） */
  think(dt: number, others: Kart[], playerProgress: number, myProgress: number): void {
    const kart = this.kart;
    const speed = Math.hypot(kart.vel.x, kart.vel.z);

    // ---------------- 卡住自救 ----------------
    if (this.reverse > 0) {
      this.reverse -= dt;
      this.input.throttle = 0;
      this.input.brake = 1;
      this.input.steer = -Math.sign(this.lastErr || 1);
      this.input.drift = false;
      return;
    }
    if (kart.grounded && speed < 3 && kart.speedKmh < 12) {
      this.stuck += dt;
    } else {
      this.stuck = 0;
    }
    if (this.stuck > 1.3) {
      this.reverse = 0.85;
      this.stuck = 0;
      return;
    }

    this.branchCooldown = Math.max(0, this.branchCooldown - dt);

    // ---------------- 路径切换 ----------------
    if (this.pathIndex > 0) {
      const branch = this.track.branches[this.pathIndex - 1]!;
      const u = branch.progressAt(kart.pos.x, kart.pos.z);
      if (u > 0.955) {
        // 汇合口前切回主路，避免在支路终点被夹住
        this.pathIndex = 0;
        this.line = this.lines[0]!;
        this.idx = this.nearestOn(this.line, kart.pos.x, kart.pos.z, true);
        this.chosenBranch = null;
        this.branchCooldown = 1.2;
      }
    } else {
      this.chooseBranch(playerProgress, myProgress);
    }

    const line = this.line;
    const path = line.path;
    const n = line.n;
    const spacing = line.spacing;

    this.idx = this.nearestOn(line, kart.pos.x, kart.pos.z, false);
    const i = this.idx;

    // ---------------- 前视目标 ----------------
    const drifting = kart.drifting;
    const look = drifting ? 11 + speed * 0.62 : 8 + speed * 0.48;
    const aheadSteps = Math.max(4, Math.round(look / spacing));
    const ahead = line.closed
      ? (i + aheadSteps) % n
      : Math.min(n - 1, i + aheadSteps);

    const tx = line.px[ahead]!;
    const tz = line.pz[ahead]!;
    const desired = Math.atan2(tx - kart.pos.x, tz - kart.pos.z);
    const err = wrapAngle(desired - kart.heading);
    this.lastErr = err;

    // ---------------- 曲率 ----------------
    const nearSteps = Math.max(4, Math.round(22 / spacing));
    const entrySteps = Math.max(nearSteps, Math.round((18 + speed * 0.85) / spacing));
    const holdSteps = Math.max(3, Math.round((8 + speed * 0.5) / spacing));
    let curvNear = 0;
    let curvEntry = 0;
    let curvHold = 0;
    for (let k = 3; k <= entrySteps; k += 2) {
      const j = line.closed ? (i + k) % n : Math.min(n - 1, i + k);
      const c = Math.abs(line.curv[j]!);
      if (c > curvEntry) curvEntry = c;
      if (k <= holdSteps && c > curvHold) curvHold = c;
      if (k <= nearSteps && c > curvNear) curvNear = c;
    }

    // ---------------- 漂移决策 ----------------
    this.driftCooldown = Math.max(0, this.driftCooldown - dt);
    let wantDrift = false;
    if (drifting) {
      this.driftTimer += dt;
      const overRotated = Math.abs(err) > 0.16 && Math.sign(err) !== kart.driftDir;
      wantDrift =
        (this.driftTimer < 0.35 || curvHold > 0.012) &&
        speed > 11 &&
        !overRotated &&
        Math.abs(err) < 0.95;
      if (!wantDrift) this.driftCooldown = 0.3;
    } else {
      this.driftTimer = 0;
      wantDrift =
        kart.grounded &&
        speed > 16 &&
        curvEntry > 0.019 &&
        Math.abs(err) > 0.075 &&
        this.driftCooldown <= 0;
    }

    // ---------------- 转向 ----------------
    const gain = drifting ? 1.05 : 2.25;
    let steer = err * gain - kart.yawRate * 0.075;

    // ---------------- 避让前车 ----------------
    const fx = Math.sin(kart.heading);
    const fz = Math.cos(kart.heading);
    let avoid = 0;
    for (const o of others) {
      if (o === kart) continue;
      const dx = o.pos.x - kart.pos.x;
      const dz = o.pos.z - kart.pos.z;
      if (dx * dx + dz * dz > 15 * 15) continue;
      if (Math.abs(o.pos.y - kart.pos.y) > 2.2) continue;
      const fwd = dx * fx + dz * fz;
      const lat = -dx * fz + dz * fx; // 正 = 在右侧
      if (fwd > -2 && fwd < 14 && Math.abs(lat) < 2.7) {
        const w = 1 - Math.max(0, fwd) / 14;
        avoid += (lat >= 0 ? -1 : 1) * w * 0.55;
      }
    }
    steer = Math.max(-1, Math.min(1, steer + avoid));

    const maxRate = drifting ? 5.5 : 9;
    const maxDelta = maxRate * Math.max(dt, 1 / 240);
    steer = this.prevSteer + Math.max(-maxDelta, Math.min(maxDelta, steer - this.prevSteer));
    this.prevSteer = steer;

    // Kart 要求入漂时 |steer| > 0.25。AI 跟线很准时舵量可能只有 0.15，
    // 这里补一个最小入漂舵量，不然永远进不了漂移。
    if (wantDrift && !drifting && Math.abs(steer) < 0.3) {
      steer = (Math.sign(steer) || Math.sign(err) || 1) * 0.3;
    }

    // ---------------- 速度目标 ----------------
    const gap = myProgress - playerProgress;
    let rubber = 0;
    if (gap > 0.03) {
      rubber = -Math.min(0.22, (gap - 0.03) * 1.6);
    } else if (gap < -0.03) {
      rubber = Math.min(0.1, (-gap - 0.03) * 1.2);
    }
    rubber *= P.aiRubberBand;

    const pace = Math.max(0.55, this.spec.pace * P.aiPace + rubber);
    const vCap = P.maxSpeed * pace;

    const aLat = drifting ? 46 : 32;
    const vCorner = curvNear > 1e-4 ? Math.sqrt(aLat / curvNear) : 999;
    const vTarget = Math.min(vCap, vCorner);

    this.input.throttle = speed < vTarget ? 1 : 0;
    this.input.brake =
      kart.grounded && speed > vTarget + 3.5 ? Math.min(0.8, (speed - vTarget) * 0.08) : 0;
    this.input.steer = steer;
    this.input.drift = wantDrift;

    // 反向行驶（撞墙后车头朝后）时先掉头，别一直顶着墙推
    const fwdSpeed = kart.vel.x * fx + kart.vel.z * fz;
    if (speed > 4 && fwdSpeed < -1) {
      this.input.throttle = 0;
      this.input.brake = 0.6;
      this.input.steer = Math.sign(err) || 1;
      this.input.drift = false;
    }
  }

  /**
   * 分叉决策：在分叉口前 ~120 m 评估一次。
   * 评分 = 长度收益 + 加速带收益 - 风险 - 车手性格阈值，落后时额外加分。
   */
  private chooseBranch(playerProgress: number, myProgress: number): void {
    if (this.branchCooldown > 0) return;

    const main = this.track.layout.main;
    const p = this.track.main.progressAt(this.kart.pos.x, this.kart.pos.z);
    const affinity = this.spec.branchAffinity ?? 0.5;

    // 上一次决策已经过去很远：允许下一圈重新评估同一条支路
    if (this.lastDecisionT >= 0) {
      const since = wrapDelta(p - this.lastDecisionT);
      if (since > 0.06 && since < 0.5) this.lastDecisionT = -1;
    }

    // 已经选了某条支路：等它靠近入口再切过去
    if (this.chosenBranch !== null) {
      const bd = this.track.layout.branches[this.chosenBranch]!;
      const d = wrapDelta(bd.tStart - p) * main.length;
      if (d <= 2.5 && d >= -10) {
        this.pathIndex = this.chosenBranch + 1;
        this.line = this.lines[this.pathIndex]!;
        this.idx = this.nearestOn(this.line, this.kart.pos.x, this.kart.pos.z, true);
        this.chosenBranch = null;
        this.lastDecisionT = bd.tStart;
        return;
      }
      if (d < -10) this.chosenBranch = null;
      return;
    }

    // 只看最近的一个分叉口，避免一次评估多条支路
    let pick = -1;
    let pickD = Infinity;
    for (let b = 0; b < this.track.layout.branches.length; b++) {
      const bd = this.track.layout.branches[b]!;
      if (Math.abs(wrapDelta(bd.tStart - this.lastDecisionT)) < 1e-6) continue;
      const d = wrapDelta(bd.tStart - p) * main.length;
      if (d > 120 || d < 2) continue;
      if (d < pickD) {
        pickD = d;
        pick = b;
      }
    }
    if (pick < 0) return;

    const bd = this.track.layout.branches[pick]!;
    const gain = bd.lengthGain;
    // 一个加速带约等于 0.1~0.15 的收益；风险按「车手性格」折算成阈值
    const boostBonus = bd.boostPadCount * 0.14;
    const riskPenalty = bd.risk * 0.18 + Math.max(0, bd.maxCurvature - 0.04) * 0.8;
    const behind = playerProgress - myProgress;
    const catchUp = behind > 0.01 ? 0.05 : 0;
    const threshold = 0.035 + (1 - affinity) * 0.09 + bd.risk * 0.04;
    const score = gain + boostBonus - riskPenalty + catchUp;

    this.lastDecisionT = bd.tStart;
    if (score > threshold) {
      this.chosenBranch = pick;
      if (pickD <= 2.5) {
        this.pathIndex = pick + 1;
        this.line = this.lines[this.pathIndex]!;
        this.idx = this.nearestOn(this.line, this.kart.pos.x, this.kart.pos.z, true);
        this.chosenBranch = null;
      }
    }
  }

  /** 在 lastIdx 附近找最近采样点；离得太远（传送/重置）时退化为全量搜索 */
  private nearestOn(line: RacingLine, px: number, pz: number, full: boolean): number {
    const n = line.n;
    const path = line.path;

    if (!full) {
      let best = this.idx;
      let bestD = Infinity;
      const W = 70;
      for (let k = -W; k <= W; k++) {
        const i = line.closed ? (this.idx + k + n) % n : Math.max(0, Math.min(n - 1, this.idx + k));
        const p = path.points[i]!;
        const dx = px - p.x;
        const dz = pz - p.z;
        const d = dx * dx + dz * dz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (bestD < 30 * 30) return best;
    }

    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < n; i++) {
      const p = path.points[i]!;
      const dx = px - p.x;
      const dz = pz - p.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
}
