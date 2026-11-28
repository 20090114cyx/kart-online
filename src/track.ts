import * as THREE from 'three';
import {
  createTrackLayout,
  type BoostPad,
  type BranchLayout,
  type DragZone,
  type TrackLayout,
} from './trackLayout';
import { TrackPath, type KartBody } from './trackPath';
import { createTunnel, type TunnelVisual } from './tunnel';
import type { Kicker, TrackDef, TrackTheme } from './trackDefs';

const ROAD_Y = 0.02;
const START_LINE_Y = 0.03;
const RAIL_HEIGHT = 1.1;
const RAIL_SIDE_OFFSET = 0.7;
const TEXTURE_SIZE = 512;

function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 赛道：主环 + 任意条内场支路。
 *
 * 物理上所有路径共用 TrackPath；Track 负责在几条路里选最近的一条，
 * 这样玩家 / AI 从任意一条走都能正常计圈、贴地、撞护栏。
 */
export class Track {
  readonly group: THREE.Group = new THREE.Group();
  readonly def: TrackDef;
  readonly theme: TrackTheme;
  readonly layout: TrackLayout;
  readonly main: TrackPath;
  readonly branches: TrackPath[];
  readonly paths: TrackPath[];

  /** 兼容旧代码 / AI：主环中心线 */
  readonly centerline: THREE.Vector3[];
  readonly sampleCount: number;
  readonly spacing: number;
  readonly halfWidth: number;

  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly textures: THREE.Texture[] = [];

  private readonly boostMap: THREE.CanvasTexture;
  private readonly boostMaterial: THREE.MeshBasicMaterial;
  private readonly tunnel: TunnelVisual | null;

  constructor(def: TrackDef) {
    this.def = def;
    this.theme = def.theme;
    this.layout = createTrackLayout(def);
    this.main = new TrackPath(this.layout.main);
    this.branches = this.layout.branches.map((b) => new TrackPath(b));
    this.paths = [this.main, ...this.branches];
    this.centerline = this.main.points;
    this.sampleCount = this.main.count;
    this.spacing = this.main.spacing;
    this.halfWidth = def.mainHalfWidth;

    this.group.name = `Track:${def.id}`;

    const asphalt = this.createAsphaltTexture(this.theme);
    this.textures.push(asphalt);
    this.buildRoad(this.main, asphalt, 0, 'RoadMain');
    for (let i = 0; i < this.branches.length; i++) {
      this.buildRoad(this.branches[i]!, asphalt, 0.012, `RoadBranch${i}`);
    }

    this.buildKickerDecals();

    this.buildEmbankment(
      this.main,
      'EmbankmentMain',
      0,
      (this.def.bridgeZones ?? []).map((z) => [z.t0, z.t1] as [number, number]),
      false,
      true,
    );
    for (let i = 0; i < this.branches.length; i++) {
      this.buildEmbankment(this.branches[i]!, `EmbankmentBranch${i}`, -0.02, [], true, false);
    }

    // 主路内侧护栏只在支路真正贴过来的地方断开，而不是整段 tStart..tEnd。
    // 支路靠主路的一侧也做同样的避让。
    this.buildGuardrails(this.main, 'Main', -1, [], false, true);
    this.buildGuardrails(this.main, 'Main', 1, []);
    for (let i = 0; i < this.branches.length; i++) {
      this.buildGuardrails(this.branches[i]!, `Branch${i}`, 1, [], true, true);
      this.buildGuardrails(this.branches[i]!, `Branch${i}`, -1, [], false, false);
    }

    this.buildStartLine();
    for (const b of this.layout.branches) this.buildForkDecal(b);
    for (const b of this.layout.branches) this.buildForkSign(b);

    const boost = this.createBoostPadTexture();
    this.boostMap = boost;
    this.textures.push(boost);
    this.boostMaterial = new THREE.MeshBasicMaterial({
      map: boost,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.materials.push(this.boostMaterial);
    this.buildBoostPads();
    this.buildDragZones();
    this.buildCanyonWalls();
    this.buildBridgeSupports();

    this.tunnel = this.layout.tunnel
      ? createTunnel(this.main, this.layout.tunnel.tStart, this.layout.tunnel.tEnd)
      : null;
    if (this.tunnel) this.group.add(this.tunnel.group);
  }

  getStartPose(): { pos: THREE.Vector3; heading: number } {
    return this.getPoseAt(10 / this.sampleCount);
  }

  /** 主环某个进度处的位姿，lateral 为右法向偏移（米，正 = 右） */
  getPoseAt(t: number, lateral = 0): { pos: THREE.Vector3; heading: number } {
    return this.main.poseAt(t, lateral);
  }

  /**
   * 计圈进度。支路按「弧长比例 → 主环 t」映射，
   * 所以走支路时进度也是从 tStart 平滑走到 tEnd，不会跳变。
   */
  progressAt(p: THREE.Vector3): number {
    let bestIsBranch = false;
    let bestIndex = -1;
    let bestDist = Infinity;

    for (let b = 0; b < this.branches.length; b++) {
      const path = this.branches[b]!;
      const i = path.nearestIndex(p.x, p.z);
      const q = path.points[i]!;
      const d = (p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z);
      if (d < bestDist) {
        bestDist = d;
        bestIsBranch = true;
        bestIndex = b;
      }
    }

    const mi = this.main.nearestIndex(p.x, p.z);
    const mp = this.main.points[mi]!;
    const md = (p.x - mp.x) * (p.x - mp.x) + (p.z - mp.z) * (p.z - mp.z);
    if (!bestIsBranch || md < bestDist) {
      return this.main.progressAt(p.x, p.z);
    }

    const branch = this.branches[bestIndex]!;
    const u = branch.progressAt(p.x, p.z);
    const f = u * (branch.count - 1);
    const i = Math.min(branch.count - 2, Math.max(0, Math.floor(f)));
    const k = Math.min(1, Math.max(0, f - i));
    const a = this.layout.branches[bestIndex]!.mainT[i]!;
    const b = this.layout.branches[bestIndex]!.mainT[i + 1]!;
    return a + (b - a) * k;
  }

  /** 到任意一条路中心线的最短距离（种树、避让用） */
  distanceToCenterline(px: number, pz: number): number {
    let best = this.main.distanceToCenterline(px, pz);
    for (const branch of this.branches) {
      const d = branch.distanceToCenterline(px, pz);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * 世界点是否落在某条支路的可行驶区内（margin 为额外余量）。
   * 峡谷岩壁 / 路堤 / 桥墩等沿主路生成的装饰必须用这个避让，
   * 否则会把支路出口堵住（车还能穿过去，看起来就像穿模）。
   */
  private nearBranchArea(
    px: number,
    pz: number,
    margin: number,
    exclude?: TrackPath,
  ): boolean {
    for (const branch of this.branches) {
      if (branch === exclude) continue;
      const i = branch.nearestIndex(px, pz);
      const p = branch.points[i]!;
      const d = Math.hypot(px - p.x, pz - p.z);
      if (d > branch.halfWidthAt(i) + margin) continue;
      // 端点外不算：支路已经结束，再断护栏就会在岔路口前后多出一个缺口。
      const tan = branch.tangents[i]!;
      const along = (px - p.x) * tan.x + (pz - p.z) * tan.z;
      if (i === 0 && along < 0) continue;
      if (i === branch.count - 1 && along > 0) continue;
      return true;
    }
    return false;
  }

  /** 到隧道中心线的最短距离（隧道山体避让） */
  distanceToTunnel(px: number, pz: number): number {
    return this.tunnel ? this.tunnel.distanceToCenterline(px, pz) : Infinity;
  }

  isInTunnel(x: number, z: number, margin = 0): boolean {
    return this.tunnel ? this.tunnel.contains(x, z, margin) : false;
  }

  groundHeightAt(x: number, z: number): number {
    let bestH = 0;
    let bestScore = Infinity;
    let sumW = 0;
    let sumH = 0;

    for (const path of this.paths) {
      const i = path.nearestIndex(x, z);
      const p = path.points[i]!;
      const d = Math.hypot(x - p.x, z - p.z);
      const hw = path.halfWidthAt(i);
      const h = path.groundHeightAtIndex(i, x, z);
      const score = d - hw;
      if (score < bestScore) {
        bestScore = score;
        bestH = h;
      }
      // 重叠区（分叉口 / 汇合口）做平滑混合，避免高度瞬间切换。
      const w = 1 - smoothstep(hw, hw + 8, d);
      if (w > 0.001) {
        sumW += w;
        sumH += h * w;
      }
    }

    if (sumW > 0.001) return sumH / sumW;
    return bestH;
  }

  collide(k: KartBody): void {
    // 先看车是不是还在任意一条路的可行驶区内。分叉口两条路重叠，
    // 只要有一条路认为它在路内，就不应该被另一条路的墙推出去。
    let bestPath = this.main;
    let bestPenetration = Infinity;

    for (const path of this.paths) {
      const proj = path.project(k.pos);
      const limit = Math.max(2, path.halfWidthAt(proj.idx) - 1.0);
      const penetration = Math.abs(proj.offset) - limit;
      if (penetration <= 0) return;
      if (penetration < bestPenetration) {
        bestPenetration = penetration;
        bestPath = path;
      }
    }

    bestPath.collide(k);
  }

  update(dt: number): void {
    this.boostMap.offset.y -= dt * 2.4;
    this.tunnel?.update(dt);
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const t of this.textures) t.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.textures.length = 0;
    this.tunnel?.dispose();
    this.group.clear();
  }

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------

  private createAsphaltTexture(theme: TrackTheme): THREE.CanvasTexture {
    const size = TEXTURE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create 2D context for asphalt texture');

    ctx.fillStyle = theme.asphalt;
    ctx.fillRect(0, 0, size, size);

    for (let i = 0; i < 20000; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const light = Math.random() < 0.5;
      const v = light ? 255 : 0;
      const alpha = 0.03 + Math.random() * 0.09;
      ctx.fillStyle = `rgba(${v}, ${v}, ${v}, ${alpha.toFixed(3)})`;
      ctx.fillRect(x, y, 1, 1);
    }

    // 中央虚线：60 像素亮 / 60 像素暗
    ctx.fillStyle = theme.asphaltLine;
    for (let y = 0; y < size; y += 120) {
      ctx.fillRect(256 - 3.5, y, 7, 60);
    }

    // 两侧实线
    ctx.fillRect(14 - 3, 0, 6, size);
    ctx.fillRect(498 - 3, 0, 6, size);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  }

  private buildRoad(
    path: TrackPath,
    map: THREE.Texture,
    yOffset: number,
    name: string,
  ): void {
    const n = path.count;
    const closed = path.closed;
    const positions = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const indices: number[] = [];

    let dist = 0;
    for (let i = 0; i < n; i++) {
      const p = path.points[i]!;
      const tan = path.tangents[i]!;
      const hw = path.halfWidths[i] ?? this.halfWidth;
      const nx = -tan.z;
      const nz = tan.x;

      const o = i * 6;
      positions[o] = p.x - nx * hw;
      positions[o + 1] = p.y + ROAD_Y + yOffset;
      positions[o + 2] = p.z - nz * hw;
      positions[o + 3] = p.x + nx * hw;
      positions[o + 4] = p.y + ROAD_Y + yOffset;
      positions[o + 5] = p.z + nz * hw;

      if (i > 0) {
        const prev = path.points[i - 1]!;
        dist += Math.hypot(p.x - prev.x, p.z - prev.z);
      }

      const v = dist / 12;
      const uo = i * 4;
      uvs[uo] = 0;
      uvs[uo + 1] = v;
      uvs[uo + 2] = 1;
      uvs[uo + 3] = v;
    }

    const segs = closed ? n : n - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % n;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = j * 2;
      const d = j * 2 + 1;
      indices.push(a, b, c, b, d, c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;

    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
  }

  private buildKickerDecals(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#2f3237';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#f0b81d';
    for (let y = -128; y < 384; y += 128) {
      ctx.beginPath();
      ctx.moveTo(0, y + 100);
      ctx.lineTo(128, y);
      ctx.lineTo(256, y + 100);
      ctx.lineTo(256, y + 148);
      ctx.lineTo(128, y + 48);
      ctx.lineTo(0, y + 148);
      ctx.closePath();
      ctx.fill();
    }

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = 8;
    map.needsUpdate = true;
    this.textures.push(map);

    const material = new THREE.MeshStandardMaterial({
      map,
      roughness: 0.95,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.materials.push(material);

    for (const k of this.def.kickers) {
      this.buildKickerRibbon(
        this.main,
        Math.round(k.t * this.main.count),
        Math.max(2, Math.round(k.up * this.main.count)),
        material,
      );
    }

    for (let bi = 0; bi < this.layout.branches.length; bi++) {
      const b = this.layout.branches[bi]!;
      const def = this.def.branches[bi]!;
      if (!def.kickers) continue;
      const path = this.branches[bi]!;
      for (const k of def.kickers) {
        this.buildKickerRibbon(
          path,
          Math.round(k.t * (path.count - 1)),
          Math.max(2, Math.round(k.up * (path.count - 1))),
          material,
        );
      }
    }
  }

  private buildKickerRibbon(
    path: TrackPath,
    lip: number,
    len: number,
    material: THREE.Material,
  ): void {
    const n = path.count;
    const count = len + 1;
    const positions = new Float32Array(count * 2 * 3);
    const uvs = new Float32Array(count * 2 * 2);
    const indices: number[] = [];

    for (let j = 0; j <= len; j++) {
      let i = lip - len + j;
      if (path.closed) i = ((i % n) + n) % n;
      else i = Math.max(0, Math.min(n - 1, i));
      const p = path.points[i]!;
      const tan = path.tangents[i]!;
      const hw = Math.max(1, (path.halfWidths[i] ?? this.halfWidth) - 0.85);
      const nx = -tan.z;
      const nz = tan.x;
      const y = p.y + 0.055;
      const o = j * 6;
      positions[o] = p.x - nx * hw;
      positions[o + 1] = y;
      positions[o + 2] = p.z - nz * hw;
      positions[o + 3] = p.x + nx * hw;
      positions[o + 4] = y;
      positions[o + 5] = p.z + nz * hw;

      const v = (j / len) * 2.2;
      const uo = j * 4;
      uvs[uo] = 0;
      uvs[uo + 1] = v;
      uvs[uo + 2] = 3;
      uvs[uo + 3] = v;
    }

    for (let j = 0; j < len; j++) {
      const a = j * 2;
      const b = j * 2 + 1;
      const c = (j + 1) * 2;
      const d = (j + 1) * 2 + 1;
      indices.push(a, b, c, b, d, c);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'KickerDecal';
    mesh.receiveShadow = true;
    this.geometries.push(geometry);
    this.group.add(mesh);
  }

  /**
   * 路堤：把路面两侧向下延伸到地面。
   * 三列顶点：路肩（泥土）→ 坡面（泥土）→ 地面（草 / 沙）。
   */
  private buildEmbankment(
    path: TrackPath,
    label: string,
    yOffset: number,
    skipRanges: Array<[number, number]> = [],
    checkMainClearance = false,
    checkBranchClearance = false,
  ): void {
    const n = path.count;
    const closed = path.closed;
    const cols = 3;
    const dirtLight = new THREE.Color(this.theme.dirtLight);
    const dirtDark = new THREE.Color(this.theme.dirtDark);
    const grass = new THREE.Color(this.theme.grass);

    for (const side of [-1, 1] as const) {
      const positions = new Float32Array(n * cols * 3);
      const colors = new Float32Array(n * cols * 3);
      const indices: number[] = [];

      for (let i = 0; i < n; i++) {
        const p = path.points[i]!;
        const tan = path.tangents[i]!;
        const hw = path.halfWidths[i] ?? this.halfWidth;
        const nx = -tan.z * side;
        const nz = tan.x * side;

        const shoulder = hw;
        const mid = hw + 1.6;
        const outward = 2.6 + p.y * 1.15;

        const base = i * cols * 3;
        positions[base] = p.x + nx * shoulder;
        positions[base + 1] = p.y + ROAD_Y + yOffset;
        positions[base + 2] = p.z + nz * shoulder;
        positions[base + 3] = p.x + nx * mid;
        positions[base + 4] = p.y - 0.08 + yOffset;
        positions[base + 5] = p.z + nz * mid;
        positions[base + 6] = p.x + nx * (mid + outward);
        positions[base + 7] = 0.04;
        positions[base + 8] = p.z + nz * (mid + outward);

        colors[base] = dirtLight.r;
        colors[base + 1] = dirtLight.g;
        colors[base + 2] = dirtLight.b;
        colors[base + 3] = dirtDark.r;
        colors[base + 4] = dirtDark.g;
        colors[base + 5] = dirtDark.b;
        colors[base + 6] = grass.r;
        colors[base + 7] = grass.g;
        colors[base + 8] = grass.b;
      }

      const segs = closed ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        // 桥段不铺路堤：否则整座桥会被土坡埋住，只剩一个土包
        const tMid = (i + 0.5) / segs;
        if (skipRanges.some(([a, b]) => tMid >= a && tMid <= b)) continue;
        const j = (i + 1) % n;
        const ai = i * cols * 3;
        const aj = j * cols * 3;
        const mx = (positions[ai]! + positions[aj]!) * 0.5;
        const mz = (positions[ai + 2]! + positions[aj + 2]!) * 0.5;
        // 支路靠主路的一侧：路堤压在主路面上会形成一道土坎，先让开。
        if (checkMainClearance && this.main.distanceToCenterline(mx, mz) <= this.halfWidth + 1.0) {
          continue;
        }
        // 主路内侧：支路出口处不要铺土坡，否则会把岔路口埋掉。
        if (checkBranchClearance && side < 0 && this.nearBranchArea(mx, mz, 0.8)) {
          continue;
        }
        for (let c = 0; c < cols - 1; c++) {
          const a = i * cols + c;
          const b = i * cols + c + 1;
          const d = j * cols + c;
          const e = j * cols + c + 1;
          if (side > 0) indices.push(a, b, d, b, e, d);
          else indices.push(a, d, b, b, d, e);
        }
      }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geometry.setIndex(indices);
      geometry.computeVertexNormals();

      const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${label}${side < 0 ? 'Left' : 'Right'}`;
      mesh.receiveShadow = true;

      this.geometries.push(geometry);
      this.materials.push(material);
      this.group.add(mesh);
    }
  }

  /**
   * 护栏。gaps 是沿路径的 0..1 区间，落在区间里的路段不生成。
   * checkMainClearance 用于支路靠主路那一侧：如果护栏会压在主路路面上，
   * 就先不生成，等两条路真正分开再出现。
   * checkBranchClearance 用于主路内侧：只在支路真的靠近时断开。
   */
  private buildGuardrails(
    path: TrackPath,
    label: string,
    side: -1 | 1,
    gaps: Array<[number, number]>,
    checkMainClearance = false,
    checkBranchClearance = false,
  ): void {
    const n = path.count;
    const closed = path.closed;
    const segs = closed ? n : n - 1;
    const red = new THREE.Color(this.theme.railRed);
    const white = new THREE.Color(this.theme.railWhite);

    const positions: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];
    let vert = 0;

    for (let i = 0; i < segs; i++) {
      const tMid = (i + 0.5) / segs;
      let skip = false;
      for (const [a, b] of gaps) {
        if (tMid >= a && tMid <= b) {
          skip = true;
          break;
        }
      }
      if (skip) continue;

      const j = (i + 1) % n;
      const pi = path.points[i]!;
      const pj = path.points[j]!;
      const ti = path.tangents[i]!;
      const tj = path.tangents[j]!;
      const hwi = (path.halfWidths[i] ?? this.halfWidth) + RAIL_SIDE_OFFSET;
      const hwj = (path.halfWidths[j] ?? this.halfWidth) + RAIL_SIDE_OFFSET;

      const ix = pi.x - ti.z * hwi * side;
      const iz = pi.z + ti.x * hwi * side;
      const jx = pj.x - tj.z * hwj * side;
      const jz = pj.z + tj.x * hwj * side;

      if (checkMainClearance) {
        const mx = (ix + jx) * 0.5;
        const mz = (iz + jz) * 0.5;
        if (this.main.distanceToCenterline(mx, mz) <= this.halfWidth + 0.6) {
          continue;
        }
      }

      if (checkBranchClearance) {
        const mx = (ix + jx) * 0.5;
        const mz = (iz + jz) * 0.5;
        if (this.nearBranchArea(mx, mz, 1.4, path)) continue;
      }

      const c = Math.floor(i / 8) % 2 === 0 ? red : white;
      positions.push(
        ix, pi.y, iz,
        ix, pi.y + RAIL_HEIGHT, iz,
        jx, pj.y, jz,
        jx, pj.y + RAIL_HEIGHT, jz,
      );
      for (let k = 0; k < 4; k++) colors.push(c.r, c.g, c.b);
      indices.push(
        vert, vert + 2, vert + 1,
        vert + 1, vert + 2, vert + 3,
      );
      vert += 4;
    }

    if (vert === 0) return;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `Guardrail${label}${side < 0 ? 'Left' : 'Right'}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
  }

  private buildStartLine(): void {
    const p = this.main.points[0]!;
    const tan = this.main.tangents[0]!;
    const nx = -tan.z;
    const nz = tan.x;
    const hw = this.halfWidth;
    const ht = 1.25;

    const ax = p.x - nx * hw - tan.x * ht;
    const az = p.z - nz * hw - tan.z * ht;
    const bx = p.x + nx * hw - tan.x * ht;
    const bz = p.z + nz * hw - tan.z * ht;
    const cx = p.x + nx * hw + tan.x * ht;
    const cz = p.z + nz * hw + tan.z * ht;
    const dx = p.x - nx * hw + tan.x * ht;
    const dz = p.z - nz * hw + tan.z * ht;

    const positions = new Float32Array([
      ax, p.y + START_LINE_Y, az,
      bx, p.y + START_LINE_Y, bz,
      cx, p.y + START_LINE_Y, cz,
      dx, p.y + START_LINE_Y, dz,
    ]);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 32;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const cols = 16;
      const rows = 2;
      const cw = canvas.width / cols;
      const ch = canvas.height / rows;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          ctx.fillStyle = (x + y) % 2 === 0 ? '#f4f4f4' : '#1b1d21';
          ctx.fillRect(x * cw, y * ch, cw, ch);
        }
      }
    }
    const checker = new THREE.CanvasTexture(canvas);
    checker.colorSpace = THREE.SRGBColorSpace;
    checker.anisotropy = 8;
    this.textures.push(checker);

    const material = new THREE.MeshBasicMaterial({
      map: checker,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'StartLine';
    mesh.renderOrder = 1;

    this.geometries.push(geometry);
    this.materials.push(material);
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------------------
  // 分叉提示 / 加速带 / 地形
  // ---------------------------------------------------------------------------

  private buildForkDecal(branch: BranchLayout): void {
    const tStart = branch.tStart;
    const t0 = tStart - 0.022;
    const t1 = tStart - 0.006;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, 512, 512);

    // 左箭头：内线（青色），先直行再向左弯
    ctx.strokeStyle = '#35e6ff';
    ctx.lineWidth = 34;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#35e6ff';
    ctx.shadowBlur = 16;
    ctx.beginPath();
    ctx.moveTo(150, 470);
    ctx.lineTo(150, 250);
    ctx.quadraticCurveTo(150, 150, 80, 120);
    ctx.stroke();
    ctx.fillStyle = '#35e6ff';
    ctx.beginPath();
    ctx.moveTo(34, 96);
    ctx.lineTo(104, 70);
    ctx.lineTo(112, 150);
    ctx.closePath();
    ctx.fill();

    // 右箭头：外线（橙色），直行
    ctx.strokeStyle = '#ffb02e';
    ctx.shadowColor = '#ffb02e';
    ctx.beginPath();
    ctx.moveTo(362, 470);
    ctx.lineTo(362, 130);
    ctx.stroke();
    ctx.fillStyle = '#ffb02e';
    ctx.beginPath();
    ctx.moveTo(362, 64);
    ctx.lineTo(420, 150);
    ctx.lineTo(304, 150);
    ctx.closePath();
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = '#eafcff';
    ctx.font = 'bold 44px "Microsoft YaHei", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(branch.name, 140, 496);
    ctx.fillStyle = '#fff2d8';
    ctx.fillText('主路', 372, 496);

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    this.textures.push(map);

    const material = new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    this.materials.push(material);

    this.buildDecalRibbon(this.main, t0, t1, map, `ForkDecal${branch.index}`, material);
  }

  private buildDecalRibbon(
    path: TrackPath,
    t0: number,
    t1: number,
    map: THREE.Texture,
    name: string,
    material: THREE.Material,
  ): void {
    const n = path.count;
    let a: number;
    let b: number;
    if (path.closed) {
      a = ((Math.round(t0 * n) % n) + n) % n;
      b = ((Math.round(t1 * n) % n) + n) % n;
      if (b <= a) b += n;
    } else {
      a = Math.max(0, Math.min(n - 1, Math.round(t0 * (n - 1))));
      b = Math.max(0, Math.min(n - 1, Math.round(t1 * (n - 1))));
      if (b <= a) b = Math.min(n - 1, a + 1);
    }

    const count = b - a + 1;
    const positions = new Float32Array(count * 2 * 3);
    const uvs = new Float32Array(count * 2 * 2);
    const indices: number[] = [];

    for (let j = 0; j < count; j++) {
      const raw = a + j;
      const i = path.closed ? ((raw % n) + n) % n : Math.min(n - 1, raw);
      const p = path.points[i]!;
      const tan = path.tangents[i]!;
      const hw = Math.max(1, (path.halfWidths[i] ?? this.halfWidth) - 0.55);
      const nx = -tan.z;
      const nz = tan.x;
      const y = p.y + 0.065;
      const o = j * 6;
      positions[o] = p.x - nx * hw;
      positions[o + 1] = y;
      positions[o + 2] = p.z - nz * hw;
      positions[o + 3] = p.x + nx * hw;
      positions[o + 4] = y;
      positions[o + 5] = p.z + nz * hw;

      const v = j / Math.max(1, count - 1);
      const uo = j * 4;
      uvs[uo] = 0;
      uvs[uo + 1] = v;
      uvs[uo + 2] = 1;
      uvs[uo + 3] = v;
    }

    for (let j = 0; j < count - 1; j++) {
      const p = j * 2;
      const q = p + 1;
      const r = p + 2;
      const s = p + 3;
      indices.push(p, q, r, q, s, r);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    this.geometries.push(geometry);
    this.group.add(mesh);
  }

  /** 分叉前的高龙门架：左「支路名」、右「主路」 */
  private buildForkSign(branch: BranchLayout): void {
    const t = branch.tStart - 0.028;
    const idx = ((Math.round(t * this.sampleCount) % this.sampleCount) + this.sampleCount) % this.sampleCount;
    const p = this.main.points[idx]!;
    const tan = this.main.tangents[idx]!;
    const heading = Math.atan2(tan.x, tan.z);

    const group = new THREE.Group();
    group.name = `ForkSign${branch.index}`;
    group.position.copy(p);
    group.rotation.y = heading;

    const metal = new THREE.MeshStandardMaterial({
      color: 0x2b3038,
      roughness: 0.5,
      metalness: 0.65,
    });
    this.materials.push(metal);

    const postGeo = new THREE.BoxGeometry(0.35, 8.0, 0.35);
    this.geometries.push(postGeo);
    for (const side of [-1, 1] as const) {
      const post = new THREE.Mesh(postGeo, metal);
      post.position.set(side * (this.halfWidth + 1.4), 2.2, 0);
      post.castShadow = true;
      group.add(post);
    }

    const beamGeo = new THREE.BoxGeometry(2 * (this.halfWidth + 1.4) + 0.7, 0.5, 0.55);
    this.geometries.push(beamGeo);
    const beam = new THREE.Mesh(beamGeo, metal);
    beam.position.set(0, 6.35, 0);
    beam.castShadow = true;
    group.add(beam);

    const makePanel = (branchSide: boolean): THREE.Mesh => {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 160;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const bg = ctx.createLinearGradient(0, 0, 512, 0);
        bg.addColorStop(0, branchSide ? '#062c38' : '#33200a');
        bg.addColorStop(1, branchSide ? '#0a4a5c' : '#4a2e0d');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, 512, 160);
        ctx.strokeStyle = branchSide ? '#35e6ff' : '#ffb02e';
        ctx.lineWidth = 8;
        ctx.strokeRect(6, 6, 500, 148);

        ctx.fillStyle = branchSide ? '#35e6ff' : '#ffb02e';
        ctx.font = 'bold 52px "Microsoft YaHei", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(branchSide ? branch.name : '主路', 300, 84);

        ctx.beginPath();
        if (branchSide) {
          ctx.moveTo(44, 80);
          ctx.lineTo(128, 30);
          ctx.lineTo(128, 62);
          ctx.lineTo(190, 62);
          ctx.lineTo(190, 98);
          ctx.lineTo(128, 98);
          ctx.lineTo(128, 130);
        } else {
          ctx.moveTo(468, 80);
          ctx.lineTo(384, 30);
          ctx.lineTo(384, 62);
          ctx.lineTo(322, 62);
          ctx.lineTo(322, 98);
          ctx.lineTo(384, 98);
          ctx.lineTo(384, 130);
        }
        ctx.closePath();
        ctx.fill();
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 8;
      this.textures.push(texture);

      const mat = new THREE.MeshBasicMaterial({ map: texture, side: THREE.FrontSide });
      this.materials.push(mat);
      const geo = new THREE.PlaneGeometry(7.6, 2.3);
      this.geometries.push(geo);
      const panel = new THREE.Mesh(geo, mat);
      panel.position.set(branchSide ? 4.5 : -4.5, 5.0, -0.3);
      panel.rotation.y = Math.PI;
      return panel;
    };

    group.add(makePanel(true));
    group.add(makePanel(false));
    this.group.add(group);
  }

  private createBoostPadTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Unable to create 2D context for boost pad');

    ctx.clearRect(0, 0, 256, 512);
    ctx.fillStyle = 'rgba(32, 210, 255, 0.10)';
    ctx.fillRect(12, 8, 232, 496);

    const grad = ctx.createLinearGradient(0, 480, 0, 40);
    grad.addColorStop(0, 'rgba(70, 225, 255, 0.25)');
    grad.addColorStop(1, 'rgba(235, 255, 255, 1)');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 26;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#39e7ff';
    ctx.shadowBlur = 22;

    for (const y of [350, 230, 110]) {
      ctx.beginPath();
      ctx.moveTo(36, y + 76);
      ctx.lineTo(128, y);
      ctx.lineTo(220, y + 76);
      ctx.stroke();
    }

    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(150, 245, 255, 0.7)';
    ctx.lineWidth = 5;
    ctx.strokeRect(14, 10, 228, 492);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
    return texture;
  }

  private buildBoostPads(): void {
    for (let i = 0; i < this.layout.boostPads.length; i++) {
      const pad: BoostPad = this.layout.boostPads[i]!;
      this.buildPadQuad(pad, this.boostMaterial, `BoostPad${i}`, 2);
    }
  }

  private buildDragZones(): void {
    if (this.layout.dragZones.length === 0) return;

    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 512;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgba(120, 82, 38, 0.55)';
    ctx.fillRect(0, 0, 256, 512);
    for (let i = 0; i < 5000; i++) {
      const g = 80 + Math.floor(Math.random() * 100);
      ctx.fillStyle = `rgba(${g}, ${g * 0.72}, ${g * 0.4}, ${(0.1 + Math.random() * 0.25).toFixed(2)})`;
      ctx.fillRect(Math.random() * 256, Math.random() * 512, 2 + Math.random() * 4, 2 + Math.random() * 4);
    }
    ctx.strokeStyle = 'rgba(255, 230, 180, 0.35)';
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, 248, 504);

    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    map.anisotropy = 8;
    this.textures.push(map);

    const material = new THREE.MeshStandardMaterial({
      map,
      transparent: true,
      roughness: 1,
      metalness: 0,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.materials.push(material);

    for (let i = 0; i < this.layout.dragZones.length; i++) {
      this.buildPadQuad(this.layout.dragZones[i]!, material, `DragZone${i}`, 1);
    }
  }

  private buildPadQuad(
    pad: BoostPad | DragZone,
    material: THREE.Material,
    name: string,
    renderOrder: number,
  ): void {
    const tanX = Math.sin(pad.heading);
    const tanZ = Math.cos(pad.heading);
    const rightX = -tanZ;
    const rightZ = tanX;
    const halfW = pad.radius * 0.95;
    const halfL = pad.radius * 1.25;
    const y = pad.y + 0.075;

    const bx = pad.x - tanX * halfL;
    const bz = pad.z - tanZ * halfL;
    const fx = pad.x + tanX * halfL;
    const fz = pad.z + tanZ * halfL;

    const positions = new Float32Array([
      bx - rightX * halfW, y, bz - rightZ * halfW,
      bx + rightX * halfW, y, bz + rightZ * halfW,
      fx + rightX * halfW, y, fz + rightZ * halfW,
      fx - rightX * halfW, y, fz - rightZ * halfW,
    ]);
    const uvs = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.computeVertexNormals();

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    this.geometries.push(geometry);
    this.group.add(mesh);
  }

  /** 峡谷岩壁：沿主路两侧立起来的层状石墙，视觉上把这一段夹成峡谷。 */
  private buildCanyonWalls(): void {
    if (!this.def.canyonZones || this.def.canyonZones.length === 0) return;

    const rock = new THREE.Color(this.theme.rockColor);

    for (let z = 0; z < this.def.canyonZones.length; z++) {
      const zone = this.def.canyonZones[z]!;
      const n = this.main.count;
      const i0 = Math.round(zone.t0 * n);
      const i1 = Math.round(zone.t1 * n);
      const height = zone.height ?? 11;

      for (const side of [-1, 1] as const) {
        const count = i1 - i0 + 1;
        if (count < 2) continue;

        // 5 层：底部暗、往上逐层变亮，再压一条深色层 —— 砂岩的横向层理。
        const rows = 5;
        const rowY = [0, 0.22, 0.48, 0.74, 1];
        const rowOff = [0, 0.25, 0.5, 0.8, 1.2];
        const rowShade = [0.42, 0.68, 0.98, 0.82, 1.14];

        const positions = new Float32Array(count * rows * 3);
        const colors = new Float32Array(count * rows * 3);
        const indices: number[] = [];
        // 支路穿过的位置必须留缺口：岩壁只沿主路生成，不知道支路的存在，
        // 会把峡谷险道的岔路口堵死（车却能从岩壁里穿过去）。
        const blocked = new Array<boolean>(count).fill(false);

        for (let k = 0; k < count; k++) {
          const i = (i0 + k) % n;
          const p = this.main.points[i]!;
          const tan = this.main.tangents[i]!;
          const hw = this.main.halfWidthAt(i) + 2.2;
          const nx = -tan.z * side;
          const nz = tan.x * side;
          blocked[k] = this.nearBranchArea(
            p.x + nx * (hw + 1.3),
            p.z + nz * (hw + 1.3),
            4.5,
          );

          // 低频起伏 + 小噪声：像风化的峡谷边缘，而不是一排尖刺
          const wave =
            Math.sin(k * 0.11 + z * 1.7) * 0.1 + Math.sin(k * 0.37 + 2.1) * 0.035;
          const top = height * (0.9 + wave);
          const bulge = Math.sin(k * 0.07 + z * 2.3) * 0.7;

          for (let r = 0; r < rows; r++) {
            const base = (k * rows + r) * 3;
            const off = hw + rowOff[r]! + bulge * (1 - rowOff[r]! * 0.45);
            positions[base] = p.x + nx * off;
            positions[base + 1] = p.y - 0.35 + top * rowY[r]!;
            positions[base + 2] = p.z + nz * off;

            const shade = rowShade[r]!;
            colors[base] = rock.r * shade;
            colors[base + 1] = rock.g * shade;
            colors[base + 2] = rock.b * shade;
          }
        }

        // 缺口两端把岩壁逐渐降下去，避免留下刀片状的断口。
        for (let k = 0; k < count; k++) {
          let gapDist = Infinity;
          for (let j = 0; j < count; j++) {
            if (blocked[j]) gapDist = Math.min(gapDist, Math.abs(j - k));
          }
          if (!Number.isFinite(gapDist) || gapDist > 8) continue;
          const f = smoothstep(0, 8, gapDist);
          const baseY = this.main.points[(i0 + k) % n]!.y - 0.35;
          for (let r = 1; r < rows; r++) {
            const yi = (k * rows + r) * 3 + 1;
            positions[yi] = baseY + (positions[yi]! - baseY) * f;
          }
        }

        for (let k = 0; k < count - 1; k++) {
          if (blocked[k] || blocked[k + 1]) continue;
          for (let r = 0; r < rows - 1; r++) {
            const a = k * rows + r;
            const b = a + 1;
            const c = (k + 1) * rows + r;
            const d = c + 1;
            if (side > 0) indices.push(a, b, c, b, d, c);
            else indices.push(a, c, b, b, c, d);
          }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 1,
          metalness: 0,
          side: THREE.DoubleSide,
          flatShading: true,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = `CanyonWall${z}${side < 0 ? 'L' : 'R'}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.geometries.push(geometry);
        this.materials.push(material);
        this.group.add(mesh);
      }
    }
  }

  /** 高架桥：在抬高的路段下面加桥墩和横梁。 */
  private buildBridgeSupports(): void {
    if (!this.def.bridgeZones || this.def.bridgeZones.length === 0) return;

    const concrete = new THREE.MeshStandardMaterial({
      color: 0x8f877c,
      roughness: 0.9,
      metalness: 0,
    });
    this.materials.push(concrete);

    const pillarGeo = new THREE.BoxGeometry(1.8, 1, 1.8);
    const beamGeo = new THREE.BoxGeometry(1, 0.55, 1.1);
    this.geometries.push(pillarGeo, beamGeo);

    const n = this.main.count;
    for (const zone of this.def.bridgeZones) {
      const i0 = Math.round(zone.t0 * n);
      const i1 = Math.round(zone.t1 * n);
      const step = Math.max(8, Math.round(24 / this.main.spacing));
      for (let i = i0; i <= i1; i += step) {
        const idx = ((i % n) + n) % n;
        const p = this.main.points[idx]!;
        if (p.y < 1.4) continue;
        const tan = this.main.tangents[idx]!;
        const nx = -tan.z;
        const nz = tan.x;
        const hw = this.main.halfWidthAt(idx) + 0.9;
        const h = p.y - 0.15;
        for (const side of [-1, 1] as const) {
          const px = p.x + nx * hw * side;
          const pz = p.z + nz * hw * side;
          // 桥墩正好落在支路出口上时直接不生成，否则会挡住岔路。
          if (this.nearBranchArea(px, pz, 2.5)) continue;
          const pillar = new THREE.Mesh(pillarGeo, concrete);
          pillar.name = 'BridgePillar';
          pillar.position.set(px, h * 0.5, pz);
          pillar.scale.y = Math.max(0.2, h);
          pillar.castShadow = true;
          pillar.receiveShadow = true;
          this.group.add(pillar);
        }
        const beam = new THREE.Mesh(beamGeo, concrete);
        beam.name = 'BridgeBeam';
        // 横梁必须在路面以下，否则会从沥青里冒出来，像一道减速带
        beam.position.set(p.x, p.y - 0.55, p.z);
        beam.rotation.y = Math.atan2(tan.x, tan.z);
        beam.scale.x = hw * 2 + 0.8;
        beam.scale.y = 1.4;
        beam.castShadow = true;
        this.group.add(beam);
      }
    }
  }
}
