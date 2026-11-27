import * as THREE from 'three';
import type { BranchDef, TrackDef, TrackTheme } from './trackDefs';

/**
 * 赛道布局生成：把 `TrackDef` 里的圆角多边形 / 支路控制点采样成
 * 可驾驶路径。这里只做几何，不碰 DOM / 渲染。
 *
 * 主环是「圆角多边形」：直道 + 各种半径的弯，保证闭合且没有自交。
 * 支路是独立的内场曲线，两端与主路重合，所以走哪条都能正常计圈。
 */

const STEP = 0.9;

interface Vec2 {
  x: number;
  z: number;
}

interface FilletCorner {
  x: number;
  z: number;
  turn: number;
  interiorHalf: number;
  d: number;
  ax: number;
  az: number;
  bx: number;
  bz: number;
  ex: number;
  ez: number;
  xx: number;
  xz: number;
  cx: number;
  cz: number;
  a0: number;
  a1: number;
}

function roundedPolygon(verts: Array<[number, number, number]>): Vec2[] {
  const n = verts.length;
  const corners: FilletCorner[] = [];

  for (let i = 0; i < n; i++) {
    const p0 = verts[(i - 1 + n) % n]!;
    const p1 = verts[i]!;
    const p2 = verts[(i + 1) % n]!;
    const inX = p1[0] - p0[0];
    const inZ = p1[1] - p0[1];
    const outX = p2[0] - p1[0];
    const outZ = p2[1] - p1[1];
    const inLen = Math.hypot(inX, inZ) || 1;
    const outLen = Math.hypot(outX, outZ) || 1;
    const ax = inX / inLen;
    const az = inZ / inLen;
    const bx = outX / outLen;
    const bz = outZ / outLen;
    const cross = ax * bz - az * bx;
    const dot = ax * bx + az * bz;
    const turn = Math.atan2(cross, dot);
    const r = p1[2];
    // turn 是偏转角（直行 = 0）。圆角的切线长要用内角的一半：
    //   interiorHalf = (π - |turn|) / 2
    //   d = r / tan(interiorHalf)
    const interiorHalf = (Math.PI - Math.abs(turn)) / 2;
    const d = Math.abs(turn) < 1e-5 ? 0 : r / Math.tan(interiorHalf);
    corners.push({
      x: p1[0],
      z: p1[1],
      turn,
      interiorHalf,
      d,
      ax,
      az,
      bx,
      bz,
      ex: 0,
      ez: 0,
      xx: 0,
      xz: 0,
      cx: 0,
      cz: 0,
      a0: 0,
      a1: 0,
    });
  }

  // 相邻圆角不能互相吃掉
  for (let iter = 0; iter < 8; iter++) {
    for (let i = 0; i < n; i++) {
      const c = corners[i]!;
      const next = corners[(i + 1) % n]!;
      const edgeLen = Math.hypot(
        verts[(i + 1) % n]![0] - verts[i]![0],
        verts[(i + 1) % n]![1] - verts[i]![1],
      );
      const sum = c.d + next.d;
      if (sum > edgeLen - 0.5) {
        const k = Math.max(0, (edgeLen - 0.5) / sum);
        c.d *= k;
        next.d *= k;
      }
    }
  }

  for (const c of corners) {
    c.ex = c.x - c.ax * c.d;
    c.ez = c.z - c.az * c.d;
    c.xx = c.x + c.bx * c.d;
    c.xz = c.z + c.bz * c.d;
    const centerDist = c.d / Math.cos(c.interiorHalf);
    let mx = -c.ax + c.bx;
    let mz = -c.az + c.bz;
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    c.cx = c.x + mx * centerDist;
    c.cz = c.z + mz * centerDist;
    c.a0 = Math.atan2(c.ez - c.cz, c.ex - c.cx);
    c.a1 = Math.atan2(c.xz - c.cz, c.xx - c.cx);
  }

  const pts: Vec2[] = [];
  const pushLine = (x0: number, z0: number, x1: number, z1: number): void => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / STEP));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      pts.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t });
    }
  };
  const pushArc = (c: FilletCorner): void => {
    if (Math.abs(c.turn) < 1e-4) return;
    const r = Math.hypot(c.ex - c.cx, c.ez - c.cz);
    const a0 = c.a0;
    let da = c.a1 - c.a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    if (Math.sign(da) !== Math.sign(c.turn) && Math.abs(c.turn) > 1e-4) {
      da = da > 0 ? da - Math.PI * 2 : da + Math.PI * 2;
    }
    const steps = Math.max(2, Math.ceil((Math.abs(da) * r) / STEP));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const a = a0 + da * t;
      pts.push({ x: c.cx + Math.cos(a) * r, z: c.cz + Math.sin(a) * r });
    }
  };

  for (let i = 0; i < n; i++) {
    const c = corners[i]!;
    const prev = corners[(i - 1 + n) % n]!;
    pushLine(prev.xx, prev.xz, c.ex, c.ez);
    pushArc(c);
  }
  return pts;
}

function smoothClosed(points: Vec2[], window: number): Vec2[] {
  const n = points.length;
  const out: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    let x = 0;
    let z = 0;
    let wsum = 0;
    for (let k = -window; k <= window; k++) {
      const w = 1 - Math.abs(k) / (window + 1);
      const p = points[(i + k + n) % n]!;
      x += p.x * w;
      z += p.z * w;
      wsum += w;
    }
    out.push({ x: x / wsum, z: z / wsum });
  }
  return out;
}

/** 向心 Catmull-Rom（alpha = 0.5）采样一条开放曲线。 */
function catmullRomOpen(points: Vec2[], perMeter: number): Vec2[] {
  const out: Vec2[] = [];
  const dist = (a: Vec2, b: Vec2): number =>
    Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.z - a.z), 0.5));

  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p0 =
      i === 0 ? { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z } : points[i - 1]!;
    const p3 =
      i === points.length - 2
        ? { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z }
        : points[i + 2]!;

    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);
    const count = Math.max(
      2,
      Math.round(perMeter * Math.hypot(p2.x - p1.x, p2.z - p1.z)),
    );

    for (let k = 0; k < count; k++) {
      const u = k / count;
      const t = t1 + (t2 - t1) * u;

      const a1x = ((t1 - t) / (t1 - t0)) * p0.x + ((t - t0) / (t1 - t0)) * p1.x;
      const a1z = ((t1 - t) / (t1 - t0)) * p0.z + ((t - t0) / (t1 - t0)) * p1.z;
      const a2x = ((t2 - t) / (t2 - t1)) * p1.x + ((t - t1) / (t2 - t1)) * p2.x;
      const a2z = ((t2 - t) / (t2 - t1)) * p1.z + ((t - t1) / (t2 - t1)) * p2.z;
      const a3x = ((t3 - t) / (t3 - t2)) * p2.x + ((t - t2) / (t3 - t2)) * p3.x;
      const a3z = ((t3 - t) / (t3 - t2)) * p2.z + ((t - t2) / (t3 - t2)) * p3.z;

      const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
      const b1z = ((t2 - t) / (t2 - t0)) * a1z + ((t - t0) / (t2 - t0)) * a2z;
      const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
      const b2z = ((t3 - t) / (t3 - t1)) * a2z + ((t - t1) / (t3 - t1)) * a3z;

      out.push({
        x: ((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x,
        z: ((t2 - t) / (t2 - t1)) * b1z + ((t - t1) / (t2 - t1)) * b2z,
      });
    }
  }

  out.push({ ...points[points.length - 1]! });
  return out;
}

function tangentsFor(points: Vec2[], closed: boolean): THREE.Vector3[] {
  const n = points.length;
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < n; i++) {
    let a: Vec2;
    let b: Vec2;
    if (closed) {
      a = points[(i - 1 + n) % n]!;
      b = points[(i + 1) % n]!;
    } else {
      a = points[Math.max(0, i - 1)]!;
      b = points[Math.min(n - 1, i + 1)]!;
    }
    const tx = b.x - a.x;
    const tz = b.z - a.z;
    const len = Math.hypot(tx, tz) || 1;
    tangents.push(new THREE.Vector3(tx / len, 0, tz / len));
  }
  return tangents;
}

function totalLength(points: Vec2[], closed: boolean): number {
  let total = 0;
  const n = points.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    total += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return total;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function wrapDelta(t: number): number {
  let d = t % 1;
  if (d > 0.5) d -= 1;
  if (d < -0.5) d += 1;
  return d;
}

function kickerAt(t: number, k: { t: number; height: number; up: number; down: number }): number {
  const d = wrapDelta(t - k.t);
  if (d <= -k.up || d >= k.down) return 0;
  if (d < 0) {
    const u = (d + k.up) / k.up;
    return k.height * (1 - Math.cos((Math.PI / 2) * u));
  }
  const u = d / k.down;
  const f = 1 - u;
  return k.height * f * f;
}

function branchKickerAt(u: number, k: { t: number; height: number; up: number; down: number }): number {
  const d = u - k.t;
  if (d <= -k.up || d >= k.down) return 0;
  if (d < 0) {
    const q = (d + k.up) / k.up;
    return k.height * (1 - Math.cos((Math.PI / 2) * q));
  }
  const q = d / k.down;
  const f = 1 - q;
  return k.height * f * f;
}

export interface LayoutPath {
  points: THREE.Vector3[];
  tangents: THREE.Vector3[];
  halfWidths: Float32Array;
  closed: boolean;
  spacing: number;
  length: number;
}

export interface BranchLayout extends LayoutPath {
  index: number;
  id: string;
  name: string;
  /** 支路在主路进度上的起点 / 终点（0..1） */
  tStart: number;
  tEnd: number;
  /** 每个支路采样点对应的主路进度，用于计圈 */
  mainT: Float32Array;
  /** 主路对应路段长度 */
  mainSegmentLength: number;
  /** 正数 = 支路比主路短 */
  lengthGain: number;
  /** 支路最大曲率（1/m） */
  maxCurvature: number;
  /** 设计者给的风险系数 0..1 */
  risk: number;
  /** 这条支路上的加速带数量 */
  boostPadCount: number;
}

export interface BoostPad {
  x: number;
  z: number;
  y: number;
  heading: number;
  radius: number;
  boostTime: number;
  path: 'main' | number;
}

export interface DragZone {
  x: number;
  z: number;
  y: number;
  heading: number;
  radius: number;
  strength: number;
  path: 'main' | number;
}

export interface TrackLayout {
  def: TrackDef;
  theme: TrackTheme;
  main: LayoutPath;
  branches: BranchLayout[];
  tunnel: { tStart: number; tEnd: number } | null;
  boostPads: BoostPad[];
  dragZones: DragZone[];
  /** 主路发车点（索引 0）的世界坐标 */
  start: THREE.Vector3;
}

/** 兼容旧代码的别名：第一版只有一条支路。 */
export type LegacyBranchLayout = BranchLayout;

function mainHalfWidthAt(t: number, def: TrackDef): number {
  let hw = def.mainHalfWidth;
  if (!def.widthZones) return hw;
  for (const zone of def.widthZones) {
    const ramp = 0.012;
    const w =
      smoothstep(zone.t0 - ramp, zone.t0 + ramp, t) *
      (1 - smoothstep(zone.t1 - ramp, zone.t1 + ramp, t));
    if (w > 0) hw = hw * (1 - w) + zone.halfWidth * w;
  }
  return hw;
}

function curvatureOf(points: Vec2[], closed: boolean): {
  max: number;
  smooth: Float32Array;
} {
  const n = points.length;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 开放路径的首尾没有「前一点 / 后一点」，差分会退化成零向量，
    // 算出 100°+/m 的假曲率。先置零，交给后面的平滑窗口补。
    if (!closed && (i === 0 || i === n - 1)) {
      raw[i] = 0;
      continue;
    }
    let a: Vec2;
    let b: Vec2;
    if (closed) {
      a = points[(i - 1 + n) % n]!;
      b = points[(i + 1) % n]!;
    } else {
      a = points[Math.max(0, i - 1)]!;
      b = points[Math.min(n - 1, i + 1)]!;
    }
    const h0 = Math.atan2(points[i]!.x - a.x, points[i]!.z - a.z);
    const h1 = Math.atan2(b.x - points[i]!.x, b.z - points[i]!.z);
    let d = h1 - h0;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    // 用真实弧长，而不是平均采样间距：Catmull-Rom 在控制点附近采样更密，
    // 用平均间距会把正常弯道误判成半径 1 m 的发夹弯。
    const ds =
      Math.hypot(points[i]!.x - a.x, points[i]!.z - a.z) +
      Math.hypot(b.x - points[i]!.x, b.z - points[i]!.z);
    raw[i] = d / Math.max(0.01, ds);
  }
  const smooth = new Float32Array(n);
  const W = 8;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = -W; k <= W; k++) {
      const j = closed ? (i + k + n) % n : Math.max(0, Math.min(n - 1, i + k));
      sum += raw[j]!;
    }
    smooth[i] = sum / (2 * W + 1);
  }
  let max = 0;
  for (let i = 0; i < n; i++) max = Math.max(max, Math.abs(smooth[i]!));
  return { max, smooth };
}

export function createTrackLayout(def: TrackDef): TrackLayout {
  const scaled = def.verts.map(
    ([x, z, r]) => [x * def.scale, z * def.scale, r] as [number, number, number],
  );
  const raw = roundedPolygon(scaled);
  let pts = smoothClosed(raw, 10);

  // 让索引 0 正好落在起跑线顶点上
  const startVertex = scaled[0]!;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i]!.x - startVertex[0];
    const dz = pts[i]!.z - startVertex[1];
    const d = dx * dx + dz * dz;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  const n = pts.length;
  const rotated: Vec2[] = [];
  for (let i = 0; i < n; i++) rotated.push(pts[(i + bestIdx) % n]!);
  pts = rotated;

  const mainLength = totalLength(pts, true);
  const mainSpacing = mainLength / n;

  const elevationAt = (t: number): number => {
    let h = 0;
    for (const [c, a, w] of def.hills) {
      const d = (t - c) / w;
      h += a * Math.exp(-d * d);
    }
    for (const k of def.kickers) h += kickerAt(t, k);
    return h;
  };

  const mainPoints: THREE.Vector3[] = [];
  const mainHalfWidths = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    mainPoints.push(new THREE.Vector3(pts[i]!.x, elevationAt(t), pts[i]!.z));
    mainHalfWidths[i] = mainHalfWidthAt(t, def);
  }
  const mainTangents = tangentsFor(pts, true);

  const frameAt = (idx: number): { p: Vec2; tx: number; tz: number; nx: number; nz: number } => {
    const i = ((idx % n) + n) % n;
    const p = pts[i]!;
    const next = pts[(i + 1) % n]!;
    const tx = next.x - p.x;
    const tz = next.z - p.z;
    const len = Math.hypot(tx, tz) || 1;
    return { p, tx: tx / len, tz: tz / len, nx: -tz / len, nz: tx / len };
  };

  const branches: BranchLayout[] = [];
  const boostPads: BoostPad[] = [];
  const dragZones: DragZone[] = [];

  for (let bi = 0; bi < def.branches.length; bi++) {
    const bd: BranchDef = def.branches[bi]!;
    if (bd.tEnd <= bd.tStart) {
      throw new Error(`[trackLayout] branch ${bd.id}: tEnd must be > tStart`);
    }
    const i0 = Math.round(bd.tStart * n);
    const i1 = Math.round(bd.tEnd * n);
    const span = i1 - i0;
    const startFrame = frameAt(i0);
    const endFrame = frameAt(i1);
    const lead = bd.lead ?? 14;

    const innerPoint = (u: number, off: number): Vec2 => {
      const f = frameAt(i0 + Math.round(span * u));
      return { x: f.p.x - f.nx * off, z: f.p.z - f.nz * off };
    };

    const ctrl: Vec2[] = [
      { x: startFrame.p.x, z: startFrame.p.z },
      { x: startFrame.p.x + startFrame.tx * lead, z: startFrame.p.z + startFrame.tz * lead },
      ...bd.controls.map(([u, off]) => innerPoint(u, off)),
      { x: endFrame.p.x - endFrame.tx * lead, z: endFrame.p.z - endFrame.tz * lead },
      { x: endFrame.p.x, z: endFrame.p.z },
    ];

    const branchRaw = catmullRomOpen(ctrl, 1.1);
    const branchCount = branchRaw.length;

    const branchCum = new Float32Array(branchCount);
    let branchLength = 0;
    for (let j = 1; j < branchCount; j++) {
      const a = branchRaw[j - 1]!;
      const b = branchRaw[j]!;
      branchLength += Math.hypot(b.x - a.x, b.z - a.z);
      branchCum[j] = branchLength;
    }
    const branchSpacing = branchLength / Math.max(1, branchCount - 1);

    const branchPoints: THREE.Vector3[] = [];
    const branchHalfWidths = new Float32Array(branchCount);
    const branchMainT = new Float32Array(branchCount);
    const targetHalf = bd.halfWidth ?? def.mainHalfWidth * 0.86;
    const startHalf = mainHalfWidths[((i0 % n) + n) % n]!;
    const endHalf = mainHalfWidths[((i1 % n) + n) % n]!;
    for (let j = 0; j < branchCount; j++) {
      const s = branchCum[j]! / (branchLength || 1);
      const t = bd.tStart + s * (bd.tEnd - bd.tStart);
      const taper = Math.sin(Math.PI * s) ** 2;
      const edgeHalf = startHalf + (endHalf - startHalf) * s;
      branchHalfWidths[j] = edgeHalf + (targetHalf - edgeHalf) * taper;
      branchMainT[j] = t;
      let y = elevationAt(t);
      if (bd.kickers) {
        for (const k of bd.kickers) y += branchKickerAt(s, k);
      }
      branchPoints.push(new THREE.Vector3(branchRaw[j]!.x, y, branchRaw[j]!.z));
    }

    const branchTangents = tangentsFor(branchRaw, false);
    branchTangents[0]!.copy(mainTangents[i0 % n]!);
    branchTangents[branchCount - 1]!.copy(mainTangents[i1 % n]!);

    const curv = curvatureOf(branchRaw, false);
    const mainSegmentLength = (bd.tEnd - bd.tStart) * mainLength;

    const branch: BranchLayout = {
      index: bi,
      id: bd.id,
      name: bd.name,
      points: branchPoints,
      tangents: branchTangents,
      halfWidths: branchHalfWidths,
      closed: false,
      spacing: branchSpacing,
      length: branchLength,
      tStart: i0 / n,
      tEnd: i1 / n,
      mainT: branchMainT,
      mainSegmentLength,
      lengthGain: (mainSegmentLength - branchLength) / Math.max(1, mainSegmentLength),
      maxCurvature: curv.max,
      risk: bd.risk ?? 0.4,
      boostPadCount: bd.boostPads?.length ?? 0,
    };
    branches.push(branch);

    if (bd.boostPads) {
      for (const pad of bd.boostPads) {
        const idx = Math.max(0, Math.min(branchCount - 1, Math.round((branchCount - 1) * pad.u)));
        const p = branchPoints[idx]!;
        const t = branchTangents[idx]!;
        boostPads.push({
          x: p.x,
          z: p.z,
          y: p.y,
          heading: Math.atan2(t.x, t.z),
          radius: pad.radius ?? 4.2,
          boostTime: pad.boostTime ?? 1.3,
          path: bi,
        });
      }
    }
    if (bd.dragZones) {
      for (const zone of bd.dragZones) {
        const idx = Math.max(0, Math.min(branchCount - 1, Math.round((branchCount - 1) * zone.u)));
        const p = branchPoints[idx]!;
        const t = branchTangents[idx]!;
        dragZones.push({
          x: p.x,
          z: p.z,
          y: p.y,
          heading: Math.atan2(t.x, t.z),
          radius: zone.radius,
          strength: zone.strength,
          path: bi,
        });
      }
    }
  }

  for (const pad of def.boostPads) {
    const idx = Math.round(pad.t * n) % n;
    const p = mainPoints[idx]!;
    const t = mainTangents[idx]!;
    boostPads.push({
      x: p.x,
      z: p.z,
      y: p.y,
      heading: Math.atan2(t.x, t.z),
      radius: pad.radius ?? 4.2,
      boostTime: pad.boostTime ?? 1.2,
      path: 'main',
    });
  }

  if (def.dragZones) {
    for (const zone of def.dragZones) {
      const idx = Math.round(zone.t * n) % n;
      const p = mainPoints[idx]!;
      const t = mainTangents[idx]!;
      dragZones.push({
        x: p.x,
        z: p.z,
        y: p.y,
        heading: Math.atan2(t.x, t.z),
        radius: zone.radius,
        strength: zone.strength,
        path: 'main',
      });
    }
  }

  return {
    def,
    theme: def.theme,
    main: {
      points: mainPoints,
      tangents: mainTangents,
      halfWidths: mainHalfWidths,
      closed: true,
      spacing: mainSpacing,
      length: mainLength,
    },
    branches,
    tunnel: def.tunnel ? { ...def.tunnel } : null,
    boostPads,
    dragZones,
    start: mainPoints[0]!.clone(),
  };
}
