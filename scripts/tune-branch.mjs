// 临时调参脚本：只用来搜索支路控制点参数，不参与游戏构建。
// 用真实 trackLayout 的主路数据，复制一份 Catmull-Rom 采样做快速评估。
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const BUNDLE = resolve('scripts/.cache/trackLayout.bundle.mjs');
const mod = await import(`${pathToFileURL(BUNDLE).href}?v=${Date.now()}`);
const layout = mod.createTrackLayout();
const main = layout.main;
const N = main.points.length;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
const dist2 = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

function frameAt(idx) {
  const i = ((idx % N) + N) % N;
  const p = main.points[i];
  const next = main.points[(i + 1) % N];
  const tx = next.x - p.x;
  const tz = next.z - p.z;
  const len = Math.hypot(tx, tz) || 1;
  return { p, tx: tx / len, tz: tz / len, nx: -tz / len, nz: tx / len };
}

function catmullRomOpen(points, perMeter) {
  const out = [];
  const dist = (a, b) => Math.max(1e-4, Math.pow(Math.hypot(b.x - a.x, b.z - a.z), 0.5));
  for (let i = 0; i < points.length - 1; i++) {
    const p1 = points[i];
    const p2 = points[i + 1];
    const p0 = i === 0 ? { x: 2 * p1.x - p2.x, z: 2 * p1.z - p2.z } : points[i - 1];
    const p3 = i === points.length - 2 ? { x: 2 * p2.x - p1.x, z: 2 * p2.z - p1.z } : points[i + 2];
    const t0 = 0;
    const t1 = t0 + dist(p0, p1);
    const t2 = t1 + dist(p1, p2);
    const t3 = t2 + dist(p2, p3);
    const count = Math.max(2, Math.round(perMeter * Math.hypot(p2.x - p1.x, p2.z - p1.z)));
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
  out.push({ ...points[points.length - 1] });
  return out;
}

function headings(points) {
  const n = points.length;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    h[i] = Math.atan2(b.x - a.x, b.z - a.z);
  }
  return h;
}

function curvature(points, k = 3) {
  const n = points.length;
  const h = headings(points);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = clamp(i - k, 0, n - 1);
    const b = clamp(i + k, 0, n - 1);
    let ds = 0;
    for (let j = a; j < b; j++) ds += dist2(points[j], points[j + 1]);
    out[i] = ds > 1e-6 ? wrapPi(h[b] - h[a]) / ds : 0;
  }
  return out;
}

function pointSegDist(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1) : 0;
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  return Math.hypot(p.x - x, p.z - z);
}

function clearanceToMain(p) {
  let best = Infinity;
  for (let i = 0; i < N; i++) {
    const d = pointSegDist(p, main.points[i], main.points[(i + 1) % N]);
    if (d < best) best = d;
  }
  return best;
}

function evaluate(offsets, lead) {
  const i0 = Math.round(0.6 * N);
  const i1 = Math.round(0.9 * N);
  const span = (i1 - i0 + N) % N;
  const start = frameAt(i0);
  const end = frameAt(i1);
  const inner = (u, off) => {
    const f = frameAt(i0 + Math.round(span * u));
    return { x: f.p.x - f.nx * off, z: f.p.z - f.nz * off };
  };
  const ctrl = [
    { x: start.p.x, z: start.p.z },
    { x: start.p.x + start.tx * lead, z: start.p.z + start.tz * lead },
    ...offsets.map(([u, o]) => inner(u, o)),
    { x: end.p.x - end.tx * lead, z: end.p.z - end.tz * lead },
    { x: end.p.x, z: end.p.z },
  ];
  const pts = catmullRomOpen(ctrl, 1.1);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2(pts[i - 1], pts[i]);
  const curv = curvature(pts, 3);
  let maxC = 0;
  let maxI = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(curv[i]) > maxC) { maxC = Math.abs(curv[i]); maxI = i; }
  }
  const M = pts.length;
  let minMid = { d: Infinity, u: 0 };
  let minAll = { d: Infinity, u: 0 };
  for (let j = 0; j < M; j++) {
    const u = j / (M - 1);
    const d = clearanceToMain(pts[j]);
    if (d < minAll.d) minAll = { d, u };
    if (u > 0.2 && u < 0.8 && d < minMid.d) minMid = { d, u };
  }
  return {
    len: +len.toFixed(1),
    maxC: +maxC.toFixed(4),
    maxCu: +(maxI / (M - 1)).toFixed(3),
    minMid: +minMid.d.toFixed(1),
    minMidU: +minMid.u.toFixed(2),
    minAll: +minAll.d.toFixed(1),
    minAllU: +minAll.u.toFixed(2),
  };
}

const mainSeg = 554.7;

function evaluateWorld({ lead, amp, waves = 1, samples = [0.12, 0.25, 0.4, 0.55, 0.7, 0.85] }) {
  const i0 = Math.round(0.6 * N);
  const i1 = Math.round(0.9 * N);
  const start = frameAt(i0);
  const end = frameAt(i1);
  const F = { x: start.p.x, z: start.p.z };
  const M = { x: end.p.x, z: end.p.z };
  const dx = M.x - F.x;
  const dz = M.z - F.z;
  const len = Math.hypot(dx, dz);
  const ux = dx / len;
  const uz = dz / len;
  const nx = uz;
  const nz = -ux;
  const ctrl = [
    F,
    { x: F.x + start.tx * lead, z: F.z + start.tz * lead },
  ];
  for (const s of samples) {
    const bulge = amp * Math.sin(Math.PI * s) * (waves === 2 ? Math.cos(Math.PI * 2 * s) : 1);
    ctrl.push({ x: F.x + dx * s + nx * bulge, z: F.z + dz * s + nz * bulge });
  }
  ctrl.push({ x: M.x - end.tx * lead, z: M.z - end.tz * lead });
  ctrl.push(M);

  const pts = catmullRomOpen(ctrl, 1.1);
  let plen = 0;
  for (let i = 1; i < pts.length; i++) plen += dist2(pts[i - 1], pts[i]);
  const curv = curvature(pts, 3);
  let maxC = 0;
  let maxI = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(curv[i]) > maxC) { maxC = Math.abs(curv[i]); maxI = i; }
  }
  const P = pts.length;
  let minMid = { d: Infinity, u: 0 };
  for (let j = 0; j < P; j++) {
    const u = j / (P - 1);
    if (u <= 0.2 || u >= 0.8) continue;
    const d = clearanceToMain(pts[j]);
    if (d < minMid.d) minMid = { d, u };
  }
  return {
    len: +plen.toFixed(1),
    maxC: +maxC.toFixed(4),
    maxCu: +(maxI / (P - 1)).toFixed(3),
    minMid: +minMid.d.toFixed(1),
    minMidU: +minMid.u.toFixed(2),
  };
}

for (const amp of [50, 60, 70, 80, 90]) {
  for (const lead of [20, 30]) {
    const r = evaluateWorld({ lead, amp });
    console.log(`sine amp=${amp} lead=${lead}`.padEnd(24), JSON.stringify(r), 'lenDiff', ((r.len - mainSeg) / mainSeg * 100).toFixed(1) + '%');
  }
}
