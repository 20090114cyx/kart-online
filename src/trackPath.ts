import * as THREE from 'three';
import type { LayoutPath } from './trackLayout';

const RAIL_HEIGHT = 1.1;

export interface KartBody {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
}

export interface PathProjection {
  idx: number;
  offset: number;
  along: number;
  nx: number;
  nz: number;
}

/**
 * 一条可驾驶路径（主环或分叉支路）。
 *
 * 负责「点 → 最近采样点 / 横向偏移 / 地面高度 / 护栏碰撞 / 进度」，
 * 不负责渲染。主环和支路共用同一套逻辑，区别只有 closed 和半宽数组。
 */
export class TrackPath {
  readonly points: THREE.Vector3[];
  readonly tangents: THREE.Vector3[];
  readonly halfWidths: Float32Array;
  readonly closed: boolean;
  readonly spacing: number;
  readonly length: number;
  readonly count: number;

  private readonly cx: Float32Array;
  private readonly cz: Float32Array;
  private readonly cy: Float32Array;
  private readonly tx: Float32Array;
  private readonly tz: Float32Array;

  /** 空间哈希：20 m 网格，查询时只算附近几十个采样点 */
  private readonly grid = new Map<number, number[]>();
  private static readonly CELL = 20;

  constructor(layout: LayoutPath) {
    this.points = layout.points;
    this.tangents = layout.tangents;
    this.halfWidths = layout.halfWidths;
    this.closed = layout.closed;
    this.spacing = Math.max(0.01, layout.spacing);
    this.length = layout.length;
    this.count = layout.points.length;

    const n = this.count;
    this.cx = new Float32Array(n);
    this.cz = new Float32Array(n);
    this.cy = new Float32Array(n);
    this.tx = new Float32Array(n);
    this.tz = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const p = this.points[i]!;
      const t = this.tangents[i]!;
      this.cx[i] = p.x;
      this.cz[i] = p.z;
      this.cy[i] = p.y;
      this.tx[i] = t.x;
      this.tz[i] = t.z;

      const key = this.cellKey(
        Math.floor(p.x / TrackPath.CELL),
        Math.floor(p.z / TrackPath.CELL),
      );
      let bucket = this.grid.get(key);
      if (!bucket) {
        bucket = [];
        this.grid.set(key, bucket);
      }
      bucket.push(i);
    }
  }

  private cellKey(ix: number, iz: number): number {
    return (ix + 512) * 4096 + (iz + 512);
  }

  /**
   * 最近采样点。先查 3×3 网格；离路很远时逐圈扩大，最后退化为全量搜索。
   * 对正常在路面上的车，通常只算 100~200 个点，比全量 2000 点快一个数量级。
   */
  nearestIndex(px: number, pz: number): number {
    const cs = TrackPath.CELL;
    const ix = Math.floor(px / cs);
    const iz = Math.floor(pz / cs);
    let best = -1;
    let bestD = Infinity;

    for (let r = 0; r <= 6; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dz) !== r) continue;
          const bucket = this.grid.get(this.cellKey(ix + dx, iz + dz));
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const i = bucket[k]!;
            const ddx = px - this.cx[i]!;
            const ddz = pz - this.cz[i]!;
            const d = ddx * ddx + ddz * ddz;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // 3×3 之外至少还有一个完整网格（20 m）的距离，找到更近的就可以停
      if (r >= 1 && best >= 0 && bestD <= (r * cs) * (r * cs)) break;
    }

    if (best < 0) {
      for (let i = 0; i < this.count; i++) {
        const ddx = px - this.cx[i]!;
        const ddz = pz - this.cz[i]!;
        const d = ddx * ddx + ddz * ddz;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return Math.max(0, best);
  }

  distanceToCenterline(px: number, pz: number): number {
    const i = this.nearestIndex(px, pz);
    return Math.hypot(px - this.cx[i]!, pz - this.cz[i]!);
  }

  project(p: THREE.Vector3): PathProjection {
    const idx = this.nearestIndex(p.x, p.z);
    const nx = -this.tz[idx]!;
    const nz = this.tx[idx]!;
    const dx = p.x - this.cx[idx]!;
    const dz = p.z - this.cz[idx]!;
    return {
      idx,
      nx,
      nz,
      offset: dx * nx + dz * nz,
      along: dx * this.tx[idx]! + dz * this.tz[idx]!,
    };
  }

  halfWidthAt(idx: number): number {
    return this.halfWidths[idx] ?? this.halfWidths[0] ?? 10;
  }

  /**
   * 0..1 的进度。闭合路径会环绕；开放路径（支路）0 = 分叉口，1 = 汇合口。
   * 用最近采样点 + 沿切线方向的插值，避免每 1 m 跳一格。
   */
  progressAt(px: number, pz: number): number {
    const idx = this.nearestIndex(px, pz);
    const along =
      (px - this.cx[idx]!) * this.tx[idx]! + (pz - this.cz[idx]!) * this.tz[idx]!;
    const n = this.count;
    if (this.closed) {
      const u = (idx + along / this.spacing) / n;
      return ((u % 1) + 1) % 1;
    }
    const u = (idx + along / this.spacing) / Math.max(1, n - 1);
    return Math.min(1, Math.max(0, u));
  }

  /**
   * 赛道表面高度。横向是平的，纵向用 Catmull-Rom 插值，
   * 保证坡度 C1 连续（否则车下坡时会一顿一顿）。
   */
  groundHeightAt(x: number, z: number): number {
    const idx = this.nearestIndex(x, z);
    return this.groundHeightAtIndex(idx, x, z);
  }

  groundHeightAtIndex(idx: number, x: number, z: number): number {
    const n = this.count;
    const along = (x - this.cx[idx]!) * this.tx[idx]! + (z - this.cz[idx]!) * this.tz[idx]!;
    let i0 = idx;
    let i1 = idx + 1;
    let k = along / this.spacing;
    if (k < 0) {
      i0 = idx - 1;
      i1 = idx;
      k += 1;
    }

    if (this.closed) {
      i0 = ((i0 % n) + n) % n;
      i1 = ((i1 % n) + n) % n;
    } else if (i0 < 0 || i1 > n - 1) {
      // 支路端点外：直接取端点高度，不要外插出悬崖
      i0 = Math.max(0, Math.min(n - 1, i0));
      i1 = Math.max(0, Math.min(n - 1, i1));
      k = 0;
    }
    k = Math.min(1, Math.max(0, k));

    const cy = this.cy;
    const p0 = cy[this.closed ? (i0 - 1 + n) % n : Math.max(0, i0 - 1)]!;
    const p1 = cy[i0]!;
    const p2 = cy[i1]!;
    const p3 = cy[this.closed ? (i1 + 1) % n : Math.min(n - 1, i1 + 1)]!;
    const k2 = k * k;
    const k3 = k2 * k;
    return (
      0.5 *
      (2 * p1 +
        (p2 - p0) * k +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * k2 +
        (3 * p1 - p0 - 3 * p2 + p3) * k3)
    );
  }

  collide(k: KartBody): void {
    const { offset, nx, nz, idx } = this.project(k.pos);
    const limit = Math.max(2, this.halfWidthAt(idx) - 1.0);
    const airborne = k.pos.y - this.cy[idx]! > RAIL_HEIGHT + 0.4;

    if (Math.abs(offset) <= limit) return;

    const sign = Math.sign(offset) || 1;
    const push = Math.abs(offset) - limit;
    k.pos.x -= nx * push * sign;
    k.pos.z -= nz * push * sign;

    // 空中只夹位置、不反弹速度：贴着空气墙滑出去，落地不会被瞬移回来
    if (airborne) return;
    const vn = k.vel.x * nx + k.vel.z * nz;
    if (vn * sign > 0) {
      k.vel.x -= nx * vn * 1.35;
      k.vel.z -= nz * vn * 1.35;
      k.vel.multiplyScalar(0.9);
    }
  }

  /** 取某个进度处的位姿，lateral 为右法向偏移（米，正 = 右） */
  poseAt(t: number, lateral = 0): { pos: THREE.Vector3; heading: number } {
    const n = this.count;
    let idx: number;
    if (this.closed) {
      idx = ((Math.round(t * n) % n) + n) % n;
    } else {
      idx = Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
    }
    const p = this.points[idx]!;
    const tan = this.tangents[idx]!;
    return {
      pos: new THREE.Vector3(
        p.x - tan.z * lateral,
        p.y,
        p.z + tan.x * lateral,
      ),
      heading: Math.atan2(tan.x, tan.z),
    };
  }

  /** 路径上第 i 个采样点的单位切线（水平） */
  tangentAt(idx: number): THREE.Vector3 {
    return this.tangents[idx]!;
  }
}
