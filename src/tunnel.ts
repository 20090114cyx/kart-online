import * as THREE from 'three';
import type { TrackPath } from './trackPath';

/**
 * 隧道：沿主路扫掠出的洞壁 + 顶棚 + 门洞 + 灯带 + 外部山体。
 *
 * 隧道段必须放在曲率很小的路段（createTrackLayout 负责选位置），
 * 这样横截面扫掠不会自交。渲染全部挂在 group 下，物理/碰撞仍由 Track 负责。
 */
export interface TunnelVisual {
  group: THREE.Group;
  update(dt: number): void;
  dispose(): void;
  contains(x: number, z: number, margin?: number): boolean;
  distanceToCenterline(x: number, z: number): number;
}

const INNER_HALF_WIDTH = 15.5;
const INNER_HEIGHT = 8.6;
const OUTER_SCALE_X = 1.55;
const OUTER_SCALE_Y = 1.9;
const OUTER_Y_OFFSET = -1.6;
const OUTER_HALF_WIDTH = INNER_HALF_WIDTH * OUTER_SCALE_X;

/**
 * 外壳墙脚落到的世界高度。地面平面在 y = -0.03，
 * 这里再埋深一点，保证上坡路段的洞口不会悬在半空（之前就悬了 3 米）。
 */
const SKIRT_Y = -0.9;

/** 内壁横截面：[横向偏移, 高度]（从左侧墙脚开始，绕过拱顶到右侧墙脚） */
const INNER_RING: Array<[number, number]> = [
  [-INNER_HALF_WIDTH, 0],
  [-INNER_HALF_WIDTH, INNER_HEIGHT * 0.48],
  [-INNER_HALF_WIDTH * 0.84, INNER_HEIGHT * 0.76],
  [-INNER_HALF_WIDTH * 0.46, INNER_HEIGHT * 0.94],
  [0, INNER_HEIGHT],
  [INNER_HALF_WIDTH * 0.46, INNER_HEIGHT * 0.94],
  [INNER_HALF_WIDTH * 0.84, INNER_HEIGHT * 0.76],
  [INNER_HALF_WIDTH, INNER_HEIGHT * 0.48],
  [INNER_HALF_WIDTH, 0],
];

function ringPoint(k: number, outer: boolean): [number, number] {
  const [x, y] = INNER_RING[k]!;
  if (!outer) return [x, y];
  return [x * OUTER_SCALE_X, y * OUTER_SCALE_Y + OUTER_Y_OFFSET];
}

function concreteTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create concrete texture');

  ctx.fillStyle = '#5b5d60';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 9000; i++) {
    const v = Math.random() < 0.5 ? 0 : 255;
    ctx.fillStyle = `rgba(${v},${v},${v},${(0.02 + Math.random() * 0.06).toFixed(3)})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, 2, 2);
  }

  // 横向伸缩缝 + 纵向模板缝
  ctx.strokeStyle = 'rgba(22, 24, 26, 0.55)';
  ctx.lineWidth = 5;
  for (let y = 0; y <= size; y += 128) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
  }
  ctx.lineWidth = 3;
  for (let x = 0; x <= size; x += 256) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }

  // 水渍
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * size;
    const w = 8 + Math.random() * 40;
    const h = 80 + Math.random() * 260;
    const g = ctx.createLinearGradient(x, 0, x + w, 0);
    g.addColorStop(0, 'rgba(30, 32, 34, 0)');
    g.addColorStop(0.5, 'rgba(30, 32, 34, 0.18)');
    g.addColorStop(1, 'rgba(30, 32, 34, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, Math.random() * size, w, h);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function rockTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create rock texture');

  ctx.fillStyle = '#4a4a42';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 2400; i++) {
    const g = 40 + Math.floor(Math.random() * 55);
    ctx.fillStyle = `rgba(${g},${g - 4},${g - 10},${(0.1 + Math.random() * 0.35).toFixed(2)})`;
    const r = 2 + Math.random() * 9;
    ctx.beginPath();
    ctx.arc(Math.random() * size, Math.random() * size, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 30; i++) {
    ctx.strokeStyle = 'rgba(24, 24, 20, 0.3)';
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    let x = Math.random() * size;
    let y = Math.random() * size;
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (Math.random() - 0.5) * 70;
      y += (Math.random() - 0.5) * 70;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

function hazardTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Unable to create hazard texture');

  ctx.fillStyle = '#f2c21b';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1c1d20';
  for (let x = -h; x < w + h; x += 56) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 28, 0);
    ctx.lineTo(x + 28 - h, h);
    ctx.lineTo(x - h, h);
    ctx.closePath();
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

export function createTunnel(path: TrackPath, tStart: number, tEnd: number): TunnelVisual {
  const group = new THREE.Group();
  group.name = 'Tunnel';

  const n = path.count;
  const i0 = Math.max(0, Math.min(n - 2, Math.round(tStart * n)));
  const i1 = Math.max(i0 + 1, Math.min(n - 1, Math.round(tEnd * n)));
  const rings = i1 - i0 + 1;

  const innerGeos: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  // ---------------- 顶点网格 ----------------
  const innerPos = new Float32Array(rings * INNER_RING.length * 3);
  const outerPos = new Float32Array(rings * INNER_RING.length * 3);
  const centerPoints: THREE.Vector3[] = [];
  let dist = 0;

  for (let r = 0; r < rings; r++) {
    const i = i0 + r;
    const p = path.points[i]!;
    const tan = path.tangents[i]!;
    const rx = -tan.z;
    const rz = tan.x;
    if (r > 0) {
      const prev = path.points[i - 1]!;
      dist += Math.hypot(p.x - prev.x, p.z - prev.z);
    }
    centerPoints.push(new THREE.Vector3(p.x, p.y, p.z));

    for (let k = 0; k < INNER_RING.length; k++) {
      const [ix, iy] = ringPoint(k, false);
      const [ox, oy] = ringPoint(k, true);
      const vi = (r * INNER_RING.length + k) * 3;
      innerPos[vi] = p.x + rx * ix;
      innerPos[vi + 1] = p.y + iy;
      innerPos[vi + 2] = p.z + rz * ix;
      outerPos[vi] = p.x + rx * ox;
      // 墙脚（内圈最下两个点）必须一直落到地面以下，否则路面抬高时外壳会悬空
      const foot = k === 0 || k === INNER_RING.length - 1;
      outerPos[vi + 1] = foot ? Math.min(p.y + oy, SKIRT_Y) : p.y + oy;
      outerPos[vi + 2] = p.z + rz * ox;
    }
  }

  const uv = new Float32Array(rings * INNER_RING.length * 2);
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < INNER_RING.length; k++) {
      const o = (r * INNER_RING.length + k) * 2;
      uv[o] = k / (INNER_RING.length - 1);
      uv[o + 1] = (r * path.spacing) / 8;
    }
  }

  // 外壳比内壁大一圈，共用一套 UV 会被拉成木纹；单独给它一套按面积铺的 UV
  const outerUv = new Float32Array(rings * INNER_RING.length * 2);
  for (let r = 0; r < rings; r++) {
    for (let k = 0; k < INNER_RING.length; k++) {
      const o = (r * INNER_RING.length + k) * 2;
      outerUv[o] = k * 1.1;
      outerUv[o + 1] = (r * path.spacing) / 9;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < rings - 1; r++) {
    for (let k = 0; k < INNER_RING.length - 1; k++) {
      const a = r * INNER_RING.length + k;
      const b = a + 1;
      const c = (r + 1) * INNER_RING.length + k;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const concrete = concreteTexture();
  textures.push(concrete);
  const innerMat = new THREE.MeshStandardMaterial({
    map: concrete,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(innerMat);

  const innerGeo = new THREE.BufferGeometry();
  innerGeo.setAttribute('position', new THREE.BufferAttribute(innerPos, 3));
  innerGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  innerGeo.setIndex(indices);
  innerGeo.computeVertexNormals();
  const innerMesh = new THREE.Mesh(innerGeo, innerMat);
  innerMesh.name = 'TunnelInner';
  innerMesh.receiveShadow = true;
  group.add(innerMesh);
  innerGeos.push(innerGeo);

  const rock = rockTexture();
  textures.push(rock);
  const outerMat = new THREE.MeshStandardMaterial({
    map: rock,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(outerMat);

  const outerGeo = new THREE.BufferGeometry();
  outerGeo.setAttribute('position', new THREE.BufferAttribute(outerPos, 3));
  outerGeo.setAttribute('uv', new THREE.BufferAttribute(outerUv, 2));
  outerGeo.setIndex(indices);
  outerGeo.computeVertexNormals();
  const outerMesh = new THREE.Mesh(outerGeo, outerMat);
  outerMesh.name = 'TunnelOuter';
  outerMesh.castShadow = true;
  outerMesh.receiveShadow = true;
  group.add(outerMesh);
  innerGeos.push(outerGeo);

  // ---------------- 洞门 ----------------
  // 岩壁立面 + 洞口一圈凸出的黄黑门套。以前整面都是黄黑条纹，面积大得离谱。
  const hazard = hazardTexture();
  textures.push(hazard);
  const portalBandMat = new THREE.MeshStandardMaterial({
    map: hazard,
    roughness: 0.8,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(portalBandMat);

  const portalRockMat = new THREE.MeshStandardMaterial({
    map: rock,
    color: 0xd8d2c4,
    // 洞口朝背光面，纯靠环境光会黑成一片；用纹理本身做一点自发光把暗部提起来
    emissive: 0xffffff,
    emissiveMap: rock,
    emissiveIntensity: 0.45,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(portalRockMat);

  /** 在「内圈 → 外圈」之间取一条环形带（t0..t1 为插值比例），两个洞口各一条 */
  const buildPortalBand = (
    t0: number,
    t1: number,
    mat: THREE.Material,
    name: string,
    uScale: number,
  ): void => {
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    let pv = 0;
    const mix = (i3: number, t: number): [number, number, number] => [
      innerPos[i3]! + (outerPos[i3]! - innerPos[i3]!) * t,
      innerPos[i3 + 1]! + (outerPos[i3 + 1]! - innerPos[i3 + 1]!) * t,
      innerPos[i3 + 2]! + (outerPos[i3 + 2]! - innerPos[i3 + 2]!) * t,
    ];
    for (const r of [0, rings - 1]) {
      for (let k = 0; k < INNER_RING.length - 1; k++) {
        const a = (r * INNER_RING.length + k) * 3;
        const b = a + 3;
        pos.push(...mix(a, t0), ...mix(b, t0), ...mix(b, t1), ...mix(a, t1));
        const u0 = k * uScale;
        const u1 = (k + 1) * uScale;
        uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
        idx.push(pv, pv + 1, pv + 2, pv, pv + 2, pv + 3);
        pv += 4;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.castShadow = true;
    group.add(mesh);
    innerGeos.push(geo);
  };

  buildPortalBand(0, 1, portalRockMat, 'TunnelPortalRock', 2.4);

  /** 洞口外沿的「门套」：沿路方向凸出 1.5 m，让洞口有厚度和阴影 */
  const buildPortalCollar = (): void => {
    const depth = 1.5;
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    let pv = 0;
    for (const end of [0, rings - 1] as const) {
      const outSign = end === 0 ? -1 : 1;
      const tan = path.tangents[i0 + end]!;
      const ox = tan.x * depth * outSign;
      const oz = tan.z * depth * outSign;
      for (let k = 0; k < INNER_RING.length - 1; k++) {
        const a = (end * INNER_RING.length + k) * 3;
        const b = a + 3;
        const ax = innerPos[a]!;
        const ay = innerPos[a + 1]!;
        const az = innerPos[a + 2]!;
        const bx = innerPos[b]!;
        const by = innerPos[b + 1]!;
        const bz = innerPos[b + 2]!;
        pos.push(ax, ay, az, bx, by, bz, bx + ox, by, bz + oz, ax + ox, ay, az + oz);
        const u0 = k * 2.0;
        const u1 = (k + 1) * 2.0;
        uvs.push(u0, 0, u1, 0, u1, 1, u0, 1);
        idx.push(pv, pv + 1, pv + 2, pv, pv + 2, pv + 3);
        pv += 4;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, portalBandMat);
    mesh.name = 'TunnelPortalCollar';
    mesh.castShadow = true;
    group.add(mesh);
    innerGeos.push(geo);
  };

  buildPortalCollar();

  // ---------------- 洞内路肩 ----------------
  const shoulderMat = new THREE.MeshStandardMaterial({
    map: concrete,
    color: 0x9a9a96,
    roughness: 0.96,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(shoulderMat);

  const shoulderPos: number[] = [];
  const shoulderUv: number[] = [];
  const shoulderIdx: number[] = [];
  let sv = 0;
  for (let r = 0; r < rings; r++) {
    const i = i0 + r;
    const p = path.points[i]!;
    const tan = path.tangents[i]!;
    const rx = -tan.z;
    const rz = tan.x;
    const hw = path.halfWidths[i] ?? 10;
    for (const side of [-1, 1] as const) {
      shoulderPos.push(
        p.x + rx * hw * side, p.y + 0.021, p.z + rz * hw * side,
        p.x + rx * INNER_HALF_WIDTH * side, p.y + 0.021, p.z + rz * INNER_HALF_WIDTH * side,
      );
      shoulderUv.push(0, r / 4, 1, r / 4);
    }
  }
  for (let r = 0; r < rings - 1; r++) {
    for (let side = 0; side < 2; side++) {
      const a = (r * 2 + side) * 2;
      const b = a + 1;
      const c = ((r + 1) * 2 + side) * 2;
      const d = c + 1;
      shoulderIdx.push(a, b, c, b, d, c);
    }
  }
  const shoulderGeo = new THREE.BufferGeometry();
  shoulderGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(shoulderPos), 3));
  shoulderGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(shoulderUv), 2));
  shoulderGeo.setIndex(shoulderIdx);
  shoulderGeo.computeVertexNormals();
  const shoulderMesh = new THREE.Mesh(shoulderGeo, shoulderMat);
  shoulderMesh.name = 'TunnelShoulder';
  shoulderMesh.receiveShadow = true;
  group.add(shoulderMesh);
  innerGeos.push(shoulderGeo);

  // ---------------- 墙脚污渍带 ----------------
  // 内壁最下面 0.9 m 压一条深色，视觉上把墙和路面「焊」在一起，不会显得墙是浮着的。
  const skirtMat = new THREE.MeshStandardMaterial({
    color: 0x3b3b36,
    roughness: 1,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  materials.push(skirtMat);
  const skirtPos: number[] = [];
  const skirtIdx: number[] = [];
  for (const side of [-1, 1] as const) {
    const base = skirtPos.length / 3;
    for (let r = 0; r < rings; r++) {
      const i = i0 + r;
      const p = path.points[i]!;
      const tan = path.tangents[i]!;
      const rx = -tan.z;
      const rz = tan.x;
      const off = (INNER_HALF_WIDTH - 0.06) * side;
      skirtPos.push(
        p.x + rx * off, p.y + 0.02, p.z + rz * off,
        p.x + rx * off, p.y + 0.9, p.z + rz * off,
      );
    }
    for (let r = 0; r < rings - 1; r++) {
      const a = base + r * 2;
      skirtIdx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const skirtGeo = new THREE.BufferGeometry();
  skirtGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPos), 3));
  skirtGeo.setIndex(skirtIdx);
  skirtGeo.computeVertexNormals();
  const skirtMesh = new THREE.Mesh(skirtGeo, skirtMat);
  skirtMesh.name = 'TunnelSkirt';
  skirtMesh.receiveShadow = true;
  group.add(skirtMesh);
  innerGeos.push(skirtGeo);

  // ---------------- 灯带 ----------------
  const lightMat = new THREE.MeshBasicMaterial({
    color: 0x9feaff,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  materials.push(lightMat);

  for (const side of [-1, 1] as const) {
    const pos = new Float32Array(rings * 2 * 3);
    const idx: number[] = [];
    for (let r = 0; r < rings; r++) {
      const i = i0 + r;
      const p = path.points[i]!;
      const tan = path.tangents[i]!;
      const rx = -tan.z;
      const rz = tan.x;
      const off = (INNER_HALF_WIDTH - 0.12) * side;
      const y0 = p.y + INNER_HEIGHT * 0.5;
      const y1 = y0 + 0.2;
      const o = r * 6;
      pos[o] = p.x + rx * off;
      pos[o + 1] = y0;
      pos[o + 2] = p.z + rz * off;
      pos[o + 3] = p.x + rx * off;
      pos[o + 4] = y1;
      pos[o + 5] = p.z + rz * off;
    }
    for (let r = 0; r < rings - 1; r++) {
      const a = r * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, lightMat);
    mesh.name = side < 0 ? 'TunnelLightLeft' : 'TunnelLightRight';
    group.add(mesh);
    innerGeos.push(geo);
  }

  // 顶部灯条
  const barGeo = new THREE.BoxGeometry(2.6, 0.12, 0.55);
  innerGeos.push(barGeo);
  const barMat = new THREE.MeshBasicMaterial({ color: 0xfff3cf, toneMapped: false });
  materials.push(barMat);
  const barCount = Math.max(2, Math.floor(rings / 7));
  const bars = new THREE.InstancedMesh(barGeo, barMat, barCount * 2);
  bars.name = 'TunnelCeilingLights';
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let bar = 0;
  for (let b = 0; b < barCount; b++) {
    const r = Math.round((b + 0.5) * ((rings - 1) / barCount));
    const i = Math.min(i1, i0 + r);
    const p = path.points[i]!;
    const tan = path.tangents[i]!;
    const rx = -tan.z;
    const rz = tan.x;
    const heading = Math.atan2(tan.x, tan.z);
    quat.setFromAxisAngle(up, heading);
    for (const side of [-1, 1] as const) {
      const off = 5.2 * side;
      matrix.compose(
        new THREE.Vector3(p.x + rx * off, p.y + INNER_HEIGHT - 0.35, p.z + rz * off),
        quat,
        new THREE.Vector3(1, 1, 1),
      );
      bars.setMatrixAt(bar++, matrix);
    }
  }
  bars.count = bar;
  bars.instanceMatrix.needsUpdate = true;
  group.add(bars);

  // ---------------- 点光源 ----------------
  const pointLights: THREE.PointLight[] = [];
  for (const u of [0.12, 0.32, 0.5, 0.68, 0.88]) {
    const r = Math.round(u * (rings - 1));
    const p = path.points[i0 + r]!;
    const light = new THREE.PointLight(0xffd8a6, 150, 52, 1.5);
    light.position.set(p.x, p.y + INNER_HEIGHT * 0.7, p.z);
    light.castShadow = false;
    group.add(light);
    pointLights.push(light);
  }

  // ---------------- 外部山体 ----------------
  // 注意：这些石头必须完全在洞壁外侧。之前把 18 m 的巨石放在洞顶，
  // 结果石头直接插进隧道内部，把路挡成了黑墙。
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  innerGeos.push(rockGeo);
  const moundMat = new THREE.MeshStandardMaterial({
    map: rock,
    color: 0x9a9684,
    emissive: 0xffffff,
    emissiveMap: rock,
    emissiveIntensity: 0.3,
    roughness: 1,
    metalness: 0,
  });
  materials.push(moundMat);

  // 两侧山脚：两排乱石，全部埋进地面，把外壳墙脚和地面接起来。
  // 之前只有一排、而且高度跟着路面走，上坡段整排石头都悬在空中。
  const sideCount = 16;
  for (let k = 0; k < sideCount * 2; k++) {
    const side = k % 2 === 0 ? -1 : 1;
    const row = k < sideCount ? 0 : 1;
    const slot = k % sideCount;
    const u = 0.02 + (slot / (sideCount - 1)) * 0.96;
    const r = Math.round(u * (rings - 1));
    const p = path.points[i0 + r]!;
    const tan = path.tangents[i0 + r]!;
    const rx = -tan.z;
    const rz = tan.x;
    const radius = 3.4 + ((k * 7) % 5) * 0.85 + row * 1.2;
    const off = side * (OUTER_HALF_WIDTH + 0.8 + row * 3.2 + ((k * 3) % 4) * 0.7);
    const mesh = new THREE.Mesh(rockGeo, moundMat);
    mesh.name = `TunnelRock${k}`;
    // 以地面为基准，底面沉进去一半，路面再高也不会悬空
    mesh.position.set(p.x + rx * off, SKIRT_Y + radius * 0.62 * 0.45, p.z + rz * off);
    mesh.scale.set(radius, radius * 0.62, radius * 1.1);
    // 只绕 y 轴转。之前绕 x/z 转会把长轴甩进隧道里，像一块巨石悬在半空。
    mesh.rotation.set(0, k * 1.7, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // 洞口两侧的岩石露头：压住洞口立面和洞壁的接缝，也让洞口有层次
  for (const end of [0, rings - 1] as const) {
    const i = i0 + end;
    const p = path.points[i]!;
    const tan = path.tangents[i]!;
    const rx = -tan.z;
    const rz = tan.x;
    const outSign = end === 0 ? -1 : 1;
    for (const side of [-1, 1] as const) {
      for (let b = 0; b < 2; b++) {
        const radius = 3.2 + b * 1.3;
        const off = side * (18.6 + b * 2.6);
        const ahead = 0.6 + b * 1.8;
        const mesh = new THREE.Mesh(rockGeo, moundMat);
        mesh.name = `TunnelJaw${end}-${side}-${b}`;
        mesh.position.set(
          p.x + rx * off + tan.x * outSign * ahead,
          p.y + radius * 0.12,
          p.z + rz * off + tan.z * outSign * ahead,
        );
        mesh.scale.set(radius, radius * 0.7, radius * 1.15);
        mesh.rotation.set(0, b * 2.1 + (side > 0 ? 1.1 : 0), 0);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
  }

  // 洞顶山脊：压扁的巨石，贴着外壳顶面埋进去，不能悬空
  const outerSurfaceY = (off: number): number => {
    const pts = INNER_RING.map((_, k) => ringPoint(k, true));
    if (off <= pts[0]![0]) return pts[0]![1];
    for (let k = 0; k < pts.length - 1; k++) {
      const [x0, y0] = pts[k]!;
      const [x1, y1] = pts[k + 1]!;
      if (off <= x1) return y0 + (y1 - y0) * ((off - x0) / (x1 - x0));
    }
    return pts[pts.length - 1]![1];
  };
  const topCount = 5;
  for (let k = 0; k < topCount; k++) {
    // 别放在洞口附近：石头会伸出洞门，看起来像飘在空中
    const u = 0.2 + (k / (topCount - 1)) * 0.6;
    const r = Math.round(u * (rings - 1));
    const p = path.points[i0 + r]!;
    const tan = path.tangents[i0 + r]!;
    const rx = -tan.z;
    const rz = tan.x;
    const sx = 8.5 + (k % 3) * 2.0;
    const sy = 3.0 + (k % 2) * 0.7;
    const off = (k - (topCount - 1) / 2) * 3.6;
    const mesh = new THREE.Mesh(rockGeo, moundMat);
    mesh.name = `TunnelRidge${k}`;
    mesh.position.set(
      p.x + rx * off,
      p.y + outerSurfaceY(off) + sy * 0.15,
      p.z + rz * off,
    );
    mesh.scale.set(sx, sy, sx * 1.2);
    mesh.rotation.set(0, k * 1.4, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---------------- 洞口指示牌 ----------------
  const signCanvas = document.createElement('canvas');
  signCanvas.width = 512;
  signCanvas.height = 128;
  const sctx = signCanvas.getContext('2d');
  if (sctx) {
    sctx.fillStyle = '#101820';
    sctx.fillRect(0, 0, 512, 128);
    sctx.strokeStyle = '#f2c21b';
    sctx.lineWidth = 8;
    sctx.strokeRect(5, 5, 502, 118);
    sctx.fillStyle = '#f2c21b';
    sctx.font = 'bold 56px "Microsoft YaHei", system-ui, sans-serif';
    sctx.textAlign = 'center';
    sctx.textBaseline = 'middle';
    sctx.fillText('隧道  TUNNEL', 256, 62);
    sctx.fillStyle = '#e8f6ff';
    for (const x of [54, 458]) {
      sctx.beginPath();
      sctx.moveTo(x, 38);
      sctx.lineTo(x + 22, 64);
      sctx.lineTo(x, 90);
      sctx.closePath();
      sctx.fill();
    }
  }
  const signTex = new THREE.CanvasTexture(signCanvas);
  signTex.colorSpace = THREE.SRGBColorSpace;
  signTex.anisotropy = 8;
  textures.push(signTex);
  const signMat = new THREE.MeshBasicMaterial({ map: signTex, side: THREE.DoubleSide });
  materials.push(signMat);
  const signGeo = new THREE.PlaneGeometry(10.5, 2.6);
  innerGeos.push(signGeo);

  const entry = path.points[i0]!;
  const entryTan = path.tangents[i0]!;
  const signGroup = new THREE.Group();
  signGroup.position.copy(entry);
  signGroup.rotation.y = Math.atan2(entryTan.x, entryTan.z);
  const sign = new THREE.Mesh(signGeo, signMat);
  // 贴在洞门岩壁上，不要飘在半空（之前挂在山顶上方 2 m，像一块悬空的广告牌）
  sign.position.set(0, INNER_HEIGHT + 2.6, -0.08);
  sign.rotation.y = Math.PI;
  signGroup.add(sign);
  group.add(signGroup);

  // ---------------- 查询 / 更新 ----------------
  let clock = 0;
  const baseIntensity = pointLights.map((l) => l.intensity);

  const update = (dt: number): void => {
    clock += dt;
    for (let i = 0; i < pointLights.length; i++) {
      pointLights[i]!.intensity = baseIntensity[i]! * (0.92 + 0.08 * Math.sin(clock * 2.1 + i * 1.7));
    }
    lightMat.color.setHSL(0.53, 0.85, 0.72 + 0.06 * Math.sin(clock * 1.6));
  };

  const distanceToCenterline = (x: number, z: number): number => {
    let best = Infinity;
    for (let i = 0; i < centerPoints.length; i++) {
      const p = centerPoints[i]!;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < best) best = d;
    }
    return best;
  };

  const contains = (x: number, z: number, margin = 0): boolean =>
    distanceToCenterline(x, z) < INNER_HALF_WIDTH + margin;

  const dispose = (): void => {
    bars.dispose();
    for (const g of innerGeos) g.dispose();
    for (const m of materials) m.dispose();
    for (const t of textures) t.dispose();
    innerGeos.length = 0;
    materials.length = 0;
    textures.length = 0;
    group.clear();
  };

  return { group, update, dispose, contains, distanceToCenterline };
}
