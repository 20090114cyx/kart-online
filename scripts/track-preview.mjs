// 多赛道布局预览 + 验证。
//
// 用法：
//   node scripts/track-preview.mjs             # 生成 track-preview-<id>.svg，并打印统计 JSON
//   $env:VALIDATE=1; node scripts/track-preview.mjs   # 额外打印逐项检查，失败时 exit 1
//
// 重要：本脚本不复制 trackLayout.ts 的几何代码。它用 esbuild 把真实的
// src/trackLayout.ts + src/trackDefs.ts 打包到 scripts/.cache/，再 import，
// 因此预览、统计和游戏里跑的永远是同一份布局。
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CACHE = join(HERE, '.cache');
mkdirSync(CACHE, { recursive: true });
const ENTRY = join(CACHE, 'track-preview-entry.ts');
const BUNDLE = join(CACHE, 'trackLayout.bundle.mjs');

writeFileSync(
  ENTRY,
  `export { createTrackLayout } from '../../src/trackLayout';\nexport { TRACK_DEFS } from '../../src/trackDefs';\n`,
);

execFileSync(
  'npx.cmd',
  [
    'esbuild',
    ENTRY,
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--target=node20',
    '--outfile=scripts/.cache/trackLayout.bundle.mjs',
    '--log-level=warning',
  ],
  { cwd: ROOT, stdio: 'inherit', shell: true },
);

const mod = await import(`${pathToFileURL(BUNDLE).href}?v=${Date.now()}`);
const { createTrackLayout, TRACK_DEFS } = mod;

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
const TAU = Math.PI * 2;
const DEG = 180 / Math.PI;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const mod1 = (a) => ((a % 1) + 1) % 1;
const dist2 = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);
const finite = (v) => Number.isFinite(v);

function percentile(sorted, q) {
  if (sorted.length === 0) return 0;
  const i = clamp(Math.floor(q * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[i];
}

function headings(points, closed) {
  const n = points.length;
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a;
    let b;
    if (closed) {
      a = points[(i - 1 + n) % n];
      b = points[(i + 1) % n];
    } else {
      a = points[Math.max(0, i - 1)];
      b = points[Math.min(n - 1, i + 1)];
    }
    h[i] = Math.atan2(b.x - a.x, b.z - a.z);
  }
  return h;
}

/** 中心差分曲率，k 为半窗口采样数。k=3 约等于 5 m 的平滑尺度。 */
function curvatureProfile(points, closed, k = 3) {
  const n = points.length;
  const h = headings(points, closed);
  const out = new Float64Array(n);
  const idx = (i) => (closed ? ((i % n) + n) % n : clamp(i, 0, n - 1));
  for (let i = 0; i < n; i++) {
    const a = idx(i - k);
    const b = idx(i + k);
    let ds = 0;
    if (closed) {
      let j = a;
      while (j !== b) {
        const j2 = (j + 1) % n;
        ds += dist2(points[j], points[j2]);
        j = j2;
      }
    } else {
      for (let j = a; j < b; j++) ds += dist2(points[j], points[j + 1]);
    }
    out[i] = ds > 1e-6 ? wrapPi(h[b] - h[a]) / ds : 0;
  }
  return out;
}

function curvatureStats(points, closed, k = 3) {
  const values = curvatureProfile(points, closed, k);
  const raw = curvatureProfile(points, closed, 1);
  const n = values.length;
  const abs = Array.from(values, Math.abs);
  const sorted = [...abs].sort((a, b) => a - b);
  let maxI = 0;
  for (let i = 1; i < n; i++) if (abs[i] > abs[maxI]) maxI = i;
  let rawMax = 0;
  for (let i = 0; i < n; i++) rawMax = Math.max(rawMax, Math.abs(raw[i]));
  const t = closed ? maxI / n : maxI / Math.max(1, n - 1);
  return {
    values,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p99: percentile(sorted, 0.99),
    max: abs[maxI],
    rawMax,
    maxI,
    maxT: t,
    maxPoint: { x: points[maxI].x, z: points[maxI].z },
    maxRadius: abs[maxI] > 1e-9 ? 1 / abs[maxI] : Infinity,
  };
}

/** 统计 60° 以上的方向变化（直角弯 / 发夹弯），按间隔合并。 */
function sharpTurns(points, closed, minTurnDeg = 60) {
  const n = points.length;
  const h = headings(points, closed);
  const turns = [];
  let acc = 0;
  let start = -1;
  for (let i = 0; i < n; i++) {
    const d = wrapPi(h[(i + 1) % n] - h[i]);
    if (Math.abs(d) < 0.002) continue;
    if (start < 0) {
      start = i;
      acc = 0;
    }
    acc += d;
    const next = wrapPi(h[(i + 2) % n] - h[(i + 1) % n]);
    if (Math.abs(next) < 0.002 || i + 1 === n - 1) {
      if (Math.abs(acc) * DEG >= minTurnDeg) {
        turns.push({ at: start / n, deg: acc * DEG });
      }
      start = -1;
      acc = 0;
    }
  }
  return turns;
}

function pointSegDist(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  const t = l2 > 1e-12 ? clamp(((p.x - a.x) * dx + (p.z - a.z) * dz) / l2, 0, 1) : 0;
  const x = a.x + dx * t;
  const z = a.z + dz * t;
  return { d: Math.hypot(p.x - x, p.z - z), t, x, z };
}

function nearestOnPolyline(p, points, closed) {
  const n = points.length;
  const segs = closed ? n : n - 1;
  let best = { d: Infinity, i: 0, t: 0, x: p.x, z: p.z };
  for (let i = 0; i < segs; i++) {
    const r = pointSegDist(p, points[i], points[(i + 1) % n]);
    if (r.d < best.d) best = { d: r.d, i, t: r.t, x: r.x, z: r.z };
  }
  return best;
}

function arcLength(points, closed, i0, i1) {
  const n = points.length;
  let s = 0;
  let i = i0;
  let guard = 0;
  while (i !== i1) {
    const j = (i + 1) % n;
    s += dist2(points[i], points[j]);
    i = j;
    if (++guard > n + 2) break;
  }
  return s;
}

function indicesBetween(n, i0, i1) {
  const out = [i0];
  let i = i0;
  let guard = 0;
  while (i !== i1) {
    i = (i + 1) % n;
    out.push(i);
    if (++guard > n + 2) break;
  }
  return out;
}

function orient(a, b, c) {
  return (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x);
}

function segmentsCross(a, b, c, d) {
  const eps = 1e-9;
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return (
    ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) &&
    ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))
  );
}

function selfIntersections(points, closed, skip = 2) {
  const n = points.length;
  const segs = closed ? n : n - 1;
  const hits = [];
  for (let i = 0; i < segs; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    for (let j = i + skip + 1; j < segs; j++) {
      if (closed && i === 0 && j === segs - 1) continue;
      const c = points[j];
      const d = points[(j + 1) % n];
      if (segmentsCross(a, b, c, d)) hits.push({ i, j });
    }
  }
  return hits;
}

function allFinite(points) {
  return points.every((p) => finite(p.x) && finite(p.z) && finite(p.y));
}

function pathD(points, closed, sx, sy) {
  let d = '';
  for (let i = 0; i < points.length; i++) {
    d += `${i === 0 ? 'M' : 'L'} ${sx(points[i].x)} ${sy(points[i].z)} `;
  }
  return d + (closed ? 'Z' : '');
}

// ---------------------------------------------------------------------------
// 单条赛道分析
// ---------------------------------------------------------------------------
function analyzeTrack(def) {
  const layout = createTrackLayout(def);
  const { main, branches, tunnel, boostPads, dragZones } = layout;
  const N = main.points.length;
  const mainCurv = curvatureStats(main.points, true, 3);
  const mainRawCurv = curvatureStats(main.points, true, 1);
  const mainSelf = selfIntersections(main.points, true, 2);
  const mainFinite = allFinite(main.points);
  const mainTurns = sharpTurns(main.points, true, 55);

  const mainBounds = main.points.reduce(
    (b, p) => ({
      minX: Math.min(b.minX, p.x),
      maxX: Math.max(b.maxX, p.x),
      minZ: Math.min(b.minZ, p.z),
      maxZ: Math.max(b.maxZ, p.z),
      minY: Math.min(b.minY, p.y),
      maxY: Math.max(b.maxY, p.y),
    }),
    { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity, minY: Infinity, maxY: -Infinity },
  );

  const branchStats = branches.map((branch) => {
    const M = branch.points.length;
    const curv = curvatureStats(branch.points, false, 3);
    const rawCurv = curvatureStats(branch.points, false, 1);
    const self = selfIntersections(branch.points, false, 2);
    const i0 = Math.round(branch.tStart * N) % N;
    const i1 = Math.round(branch.tEnd * N) % N;
    const mainSegLength = arcLength(main.points, true, i0, i1);
    const lengthDiffPct = ((branch.length - mainSegLength) / mainSegLength) * 100;
    const ends = [
      { name: 'start', bp: branch.points[0], mp: main.points[i0], bt: branch.tangents[0], mt: main.tangents[i0], t: branch.tStart },
      { name: 'end', bp: branch.points[M - 1], mp: main.points[i1], bt: branch.tangents[M - 1], mt: main.tangents[i1], t: branch.tEnd },
    ].map((e) => {
      const dot = clamp(e.bt.x * e.mt.x + e.bt.z * e.mt.z, -1, 1);
      return {
        name: e.name,
        t: e.t,
        distance: dist2(e.bp, e.mp),
        tangentAngleDeg: Math.acos(dot) * DEG,
        heightDiff: e.bp.y - e.mp.y,
      };
    });

    const skip = Math.floor((M - 1) * 0.2);
    let clearance = { d: Infinity, j: 0, mainI: 0 };
    for (let j = skip; j <= M - 1 - skip; j++) {
      const near = nearestOnPolyline(branch.points[j], main.points, true);
      if (near.d < clearance.d) clearance = { d: near.d, j, mainI: near.i };
    }

    return {
      id: branch.id,
      name: branch.name,
      length: branch.length,
      samples: M,
      spacing: branch.spacing,
      tStart: branch.tStart,
      tEnd: branch.tEnd,
      mainSegmentLength: mainSegLength,
      lengthDiffPct,
      lengthGain: branch.lengthGain,
      maxCurvature: branch.maxCurvature,
      risk: branch.risk,
      boostPadCount: branch.boostPadCount,
      curvature: {
        p50: curv.p50,
        p90: curv.p90,
        p99: curv.p99,
        max: curv.max,
        maxRadius: curv.maxRadius,
        rawMax: rawCurv.rawMax,
        maxAtU: curv.maxT,
        maxAt: { x: +curv.maxPoint.x.toFixed(2), z: +curv.maxPoint.z.toFixed(2) },
      },
      selfIntersections: self.length,
      finite: allFinite(branch.points) && branch.tangents.every((t) => finite(t.x) && finite(t.z)),
      ends,
      clearance: {
        min: clearance.d,
        atBranchU: clearance.j / Math.max(1, M - 1),
        atMainT: clearance.mainI / N,
        required: main.halfWidths[clearance.mainI] + branch.halfWidths[clearance.j] + 2,
      },
    };
  });

  // 支路之间最近距离
  const branchPairs = [];
  for (let a = 0; a < branches.length; a++) {
    for (let b = a + 1; b < branches.length; b++) {
      let min = { d: Infinity, a: 0, b: 0 };
      for (let i = 0; i < branches[a].points.length; i += 2) {
        const near = nearestOnPolyline(branches[a].points[i], branches[b].points, false);
        if (near.d < min.d) min = { d: near.d, a: i, b: near.i };
      }
      branchPairs.push({
        a: branches[a].id,
        b: branches[b].id,
        min: min.d,
        required: branches[a].halfWidths[min.a] + branches[b].halfWidths[min.b] + 2,
      });
    }
  }

  // 隧道
  let tunnelStats = null;
  if (tunnel) {
    const ti0 = Math.round(tunnel.tStart * N) % N;
    const ti1 = Math.round(tunnel.tEnd * N) % N;
    const indices = indicesBetween(N, ti0, ti1);
    const length = arcLength(main.points, true, ti0, ti1);
    let curvMax = 0;
    let curvAt = ti0;
    for (const i of indices) {
      const v = Math.abs(mainCurv.values[i]);
      if (v > curvMax) {
        curvMax = v;
        curvAt = i;
      }
    }
    let forkGapT = 1;
    for (const i of indices) {
      for (const b of branches) {
        const span = mod1(b.tEnd - b.tStart);
        const d = mod1(i / N - b.tStart);
        const gap = d <= span ? 0 : Math.min(d - span, 1 - d);
        if (gap < forkGapT) forkGapT = gap;
      }
    }
    tunnelStats = {
      tStart: tunnel.tStart,
      tEnd: tunnel.tEnd,
      length,
      curvatureMax: curvMax,
      curvatureMaxAtT: curvAt / N,
      forkGapT,
      forkGapM: forkGapT * main.length,
    };
  }

  // 加速带 / 减速带
  const padStats = boostPads.map((pad, idx) => {
    const path = pad.path === 'main' ? main : branches[pad.path];
    const near = nearestOnPolyline({ x: pad.x, z: pad.z }, path.points, path.closed);
    const pIdx = near.i;
    const tan = path.tangents[pIdx];
    const heading = Math.atan2(tan.x, tan.z);
    return {
      index: idx,
      path: pad.path,
      x: pad.x,
      z: pad.z,
      radius: pad.radius,
      lateral: near.d,
      halfWidth: path.halfWidths[pIdx],
      inside: near.d + pad.radius <= path.halfWidths[pIdx] + 0.05,
      headingDiffDeg: Math.abs(wrapPi(pad.heading - heading)) * DEG,
      heightDiff: pad.y - path.points[pIdx].y,
      t: path.closed ? pIdx / path.points.length : pIdx / (path.points.length - 1),
    };
  });

  const dragStats = dragZones.map((zone, idx) => {
    const path = zone.path === 'main' ? main : branches[zone.path];
    const near = nearestOnPolyline({ x: zone.x, z: zone.z }, path.points, path.closed);
    return {
      index: idx,
      path: zone.path,
      lateral: near.d,
      halfWidth: path.halfWidths[near.i],
      radius: zone.radius,
      inside: near.d + zone.radius <= path.halfWidths[near.i] + 0.05,
    };
  });

  // 桥面高度
  const bridgeStats = (def.bridgeZones ?? []).map((zone) => {
    const i0 = Math.round(zone.t0 * N);
    const i1 = Math.round(zone.t1 * N);
    let maxY = 0;
    let above = 0;
    let count = 0;
    for (let i = i0; i <= i1; i++) {
      const p = main.points[((i % N) + N) % N];
      maxY = Math.max(maxY, p.y);
      if (p.y >= 1.4) above++;
      count++;
    }
    return { ...zone, maxY, aboveRatio: above / Math.max(1, count) };
  });

  // 峡谷段
  const canyonStats = (def.canyonZones ?? []).map((zone) => ({
    ...zone,
    length: arcLength(main.points, true, Math.round(zone.t0 * N), Math.round(zone.t1 * N)),
  }));

  return {
    def,
    layout,
    main: {
      length: main.length,
      samples: N,
      spacing: main.spacing,
      curvature: {
        p50: mainCurv.p50,
        p90: mainCurv.p90,
        p99: mainCurv.p99,
        max: mainCurv.max,
        maxRadius: mainCurv.maxRadius,
        rawMax: mainRawCurv.rawMax,
        maxAtT: mainCurv.maxT,
        maxAt: mainCurv.maxPoint,
      },
      selfIntersections: mainSelf.length,
      finite: mainFinite && main.tangents.every((t) => finite(t.x) && finite(t.z)),
      sharpTurns: mainTurns,
      bounds: mainBounds,
    },
    branches: branchStats,
    branchPairs,
    tunnel: tunnelStats,
    boostPads: padStats,
    dragZones: dragStats,
    bridges: bridgeStats,
    canyons: canyonStats,
  };
}

// ---------------------------------------------------------------------------
// 验证
// ---------------------------------------------------------------------------
function validateTrack(a) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  const def = a.def;
  const m = a.main;

  const minLen = def.id === 'forest' ? 1700 : 3400;
  const maxLen = def.id === 'forest' ? 2100 : 4600;
  add('main length in range', m.length >= minLen && m.length <= maxLen, `${m.length.toFixed(1)} m (want ${minLen}-${maxLen})`);
  add('main finite', m.finite && Array.from(a.layout.main.points).every((p) => finite(p.y)), `points=${m.samples}, spacing=${m.spacing.toFixed(3)} m`);
  add('main no self-intersection', m.selfIntersections === 0, `${m.selfIntersections} crossing(s)`);
  add('main curvature sane', m.curvature.max >= 0.018 && m.curvature.max <= 0.075, `max=${m.curvature.max.toFixed(4)} (R=${m.curvature.maxRadius.toFixed(1)} m) @ t=${m.curvature.maxAtT.toFixed(3)}`);
  add('main no curvature spike', m.curvature.max <= m.curvature.p99 * 1.9 + 0.006, `max/p99=${(m.curvature.max / Math.max(1e-9, m.curvature.p99)).toFixed(2)}, rawMax=${m.curvature.rawMax.toFixed(4)}`);
  if (def.id === 'canyon') {
    add('canyon has >=2 sharp turns (>=70°)', m.sharpTurns.filter((t) => Math.abs(t.deg) >= 70).length >= 2, m.sharpTurns.map((t) => `${t.deg.toFixed(0)}°@${t.at.toFixed(3)}`).join(', ') || 'none');
  }

  add('branch count', a.branches.length === def.branches.length, `${a.branches.length}`);
  for (const b of a.branches) {
    add(`branch ${b.id} finite`, b.finite, `points=${b.samples}, spacing=${b.spacing.toFixed(3)} m`);
    add(`branch ${b.id} no self-intersection`, b.selfIntersections === 0, `${b.selfIntersections} crossing(s)`);
    add(`branch ${b.id} curvature < 0.06`, b.curvature.max < 0.06, `max=${b.curvature.max.toFixed(4)} (R=${b.curvature.maxRadius.toFixed(1)} m) @ u=${b.curvature.maxAtU.toFixed(3)}`);
    add(
      `branch ${b.id} connects cleanly`,
      b.ends.every((e) => e.distance < 1 && e.tangentAngleDeg < 3 && Math.abs(e.heightDiff) < 0.6),
      b.ends.map((e) => `${e.name}: d=${e.distance.toFixed(2)} m, angle=${e.tangentAngleDeg.toFixed(2)}°, dy=${e.heightDiff.toFixed(2)} m`).join(' | '),
    );
    add(`branch ${b.id} main clearance`, b.clearance.min >= b.clearance.required, `min=${b.clearance.min.toFixed(2)} m (need ${b.clearance.required.toFixed(1)}) @ u=${b.clearance.atBranchU.toFixed(2)}, main t=${b.clearance.atMainT.toFixed(3)}`);
    add(`branch ${b.id} length vs main`, b.lengthDiffPct < 22, `${b.lengthDiffPct.toFixed(1)}% (branch ${b.length.toFixed(1)} m, main seg ${b.mainSegmentLength.toFixed(1)} m)`);
  }
  for (const pair of a.branchPairs) {
    add(`branches ${pair.a}/${pair.b} clearance`, pair.min >= pair.required, `min=${pair.min.toFixed(1)} m (need ${pair.required.toFixed(1)})`);
  }

  if (a.tunnel) {
    add('tunnel length 70-180 m', a.tunnel.length >= 70 && a.tunnel.length <= 180, `${a.tunnel.length.toFixed(1)} m`);
    add('tunnel curvature < 0.03', a.tunnel.curvatureMax < 0.03, `max=${a.tunnel.curvatureMax.toFixed(4)} @ t=${a.tunnel.curvatureMaxAtT.toFixed(3)}`);
    add('tunnel clear of branches', a.tunnel.forkGapM > 40, `gap=${a.tunnel.forkGapM.toFixed(1)} m`);
  }

  add('boost pads on road', a.boostPads.every((b) => b.inside), a.boostPads.map((b) => `${b.path}#${b.index}: lat=${b.lateral.toFixed(2)}, hw=${b.halfWidth.toFixed(2)}, r=${b.radius}`).join(' | '));
  add('boost pad headings sane', a.boostPads.every((b) => b.headingDiffDeg <= 30), a.boostPads.map((b) => `${b.path}#${b.index}: ${b.headingDiffDeg.toFixed(1)}°`).join(' | '));
  add('drag zones on road', a.dragZones.every((z) => z.inside), a.dragZones.map((z) => `${z.path}#${z.index}: lat=${z.lateral.toFixed(2)}, hw=${z.halfWidth.toFixed(2)}, r=${z.radius}`).join(' | ') || 'none');
  add('bridge zones elevated', a.bridges.every((b) => b.aboveRatio > 0.35), a.bridges.map((b) => `${b.t0.toFixed(3)}-${b.t1.toFixed(3)}: maxY=${b.maxY.toFixed(1)}, above=${(b.aboveRatio * 100).toFixed(0)}%`).join(' | ') || 'none');

  const failed = checks.filter((c) => !c.ok);
  return { pass: failed.length === 0, failed: failed.length, total: checks.length, checks };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------
function renderSvg(a) {
  const { layout, def } = a;
  const { main, branches, tunnel, boostPads } = layout;
  const W = 1500;
  const H = 1000;
  const PAD = 40;
  const PANEL_X = 1060;
  const PANEL_W = W - PANEL_X - 24;
  const AREA_W = PANEL_X - PAD * 2;
  const AREA_H = H - PAD * 2;

  const allPts = [...main.points];
  for (const b of branches) allPts.push(...b.points);
  const minX = Math.min(...allPts.map((p) => p.x));
  const maxX = Math.max(...allPts.map((p) => p.x));
  const minZ = Math.min(...allPts.map((p) => p.z));
  const maxZ = Math.max(...allPts.map((p) => p.z));
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;
  const scale = Math.min(AREA_W / spanX, AREA_H / spanZ);
  const ox = PAD + (AREA_W - spanX * scale) / 2 - minX * scale;
  const oy = PAD + (AREA_H - spanZ * scale) / 2 - minZ * scale;
  const sx = (x) => +(x * scale + ox).toFixed(2);
  const sy = (z) => +(z * scale + oy).toFixed(2);

  const esc = (s) =>
    String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');

  const colorFor = (c) => {
    const t = clamp(Math.abs(c) / 0.065, 0, 1);
    const hue = 220 - 220 * t;
    return `hsl(${hue.toFixed(0)}, 88%, 56%)`;
  };

  const N = main.points.length;
  const curv = curvatureStats(main.points, true, 3).values;
  let mainColored = '';
  for (let i = 0; i < N; i++) {
    const p = main.points[i];
    const q = main.points[(i + 1) % N];
    mainColored += `<line x1="${sx(p.x)}" y1="${sy(p.z)}" x2="${sx(q.x)}" y2="${sy(q.z)}" stroke="${colorFor(curv[i])}" stroke-width="4" stroke-linecap="round"/>`;
  }

  const forkSvg = [];
  for (const b of branches) {
    const M = b.points.length;
    const f0 = b.points[0];
    const f1 = b.points[M - 1];
    forkSvg.push(`<circle cx="${sx(f0.x)}" cy="${sy(f0.z)}" r="7" fill="#ffd34d" stroke="#1b1b1b" stroke-width="2"/>`);
    forkSvg.push(`<circle cx="${sx(f1.x)}" cy="${sy(f1.z)}" r="7" fill="#ffd34d" stroke="#1b1b1b" stroke-width="2"/>`);
    forkSvg.push(`<text x="${sx(f0.x) + 10}" y="${sy(f0.z) - 10}" fill="#ffd34d" font-family="monospace" font-size="14">${esc(b.name)} IN t=${b.tStart.toFixed(3)}</text>`);
    forkSvg.push(`<text x="${sx(f1.x) + 10}" y="${sy(f1.z) + 20}" fill="#ffd34d" font-family="monospace" font-size="14">OUT t=${b.tEnd.toFixed(3)}</text>`);
  }

  let tunnelSvg = '';
  if (tunnel) {
    const ti0 = Math.floor(tunnel.tStart * N);
    const ti1 = Math.ceil(tunnel.tEnd * N);
    const pts = indicesBetween(N, ti0, ti1).map((i) => main.points[i]);
    tunnelSvg = `<path d="${pathD(pts, false, sx, sy)}" fill="none" stroke="#37d3ff" stroke-width="${(main.halfWidths[0] * 2 * scale).toFixed(1)}" stroke-opacity="0.18" stroke-linecap="round"/>`;
  }

  let boostSvg = '';
  for (const b of boostPads) {
    const r = b.radius * scale;
    const dirX = Math.sin(b.heading);
    const dirZ = Math.cos(b.heading);
    const cx = sx(b.x);
    const cy = sy(b.z);
    boostSvg += `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="#ff4fd8" fill-opacity="0.28" stroke="#ff8be7" stroke-width="2"/>`;
    boostSvg += `<line x1="${(cx - dirX * r * 0.7).toFixed(1)}" y1="${(cy - dirZ * r * 0.7).toFixed(1)}" x2="${(cx + dirX * r * 0.8).toFixed(1)}" y2="${(cy + dirZ * r * 0.8).toFixed(1)}" stroke="#ffd7f5" stroke-width="3" stroke-linecap="round"/>`;
  }

  const panelLines = [];
  const push = (text, color = '#cbd5e1', size = 13, weight = 'normal') => panelLines.push({ text, color, size, weight });
  push(def.name, '#f8fafc', 22, 'bold');
  push(def.subtitle, '#64748b', 12);
  push('');
  push('MAIN', '#93c5fd', 14, 'bold');
  push(`length ${a.main.length.toFixed(1)} m  samples ${a.main.samples}`);
  push(`spacing ${a.main.spacing.toFixed(3)} m  width ${(def.mainHalfWidth * 2).toFixed(1)} m`);
  push(`|k| p50 ${a.main.curvature.p50.toFixed(4)}  p90 ${a.main.curvature.p90.toFixed(4)}`);
  push(`|k| p99 ${a.main.curvature.p99.toFixed(4)}  max ${a.main.curvature.max.toFixed(4)}`);
  push(`Rmin ${a.main.curvature.maxRadius.toFixed(1)} m @ t=${a.main.curvature.maxAtT.toFixed(3)}`, '#fca5a5');
  push(`sharp turns ${a.main.sharpTurns.map((t) => `${t.deg.toFixed(0)}°`).join(' ') || 'none'}`);
  push(`self-intersections ${a.main.selfIntersections}`, a.main.selfIntersections ? '#f87171' : '#86efac');
  push('');
  push('BRANCHES', '#fdba74', 14, 'bold');
  for (const b of a.branches) {
    push(`${b.name}  ${b.length.toFixed(0)} m  ${b.lengthDiffPct >= 0 ? '+' : ''}${b.lengthDiffPct.toFixed(1)}%`, '#e2e8f0', 12);
    push(`  t ${b.tStart.toFixed(3)}..${b.tEnd.toFixed(3)}  Rmin ${b.curvature.maxRadius.toFixed(0)} m`, '#94a3b8', 11);
    push(`  clearance ${b.clearance.min.toFixed(1)} m (need ${b.clearance.required.toFixed(1)})`, b.clearance.min >= b.clearance.required ? '#86efac' : '#f87171', 11);
  }
  push('');
  if (a.tunnel) {
    push('TUNNEL', '#67e8f9', 14, 'bold');
    push(`t ${a.tunnel.tStart.toFixed(3)}..${a.tunnel.tEnd.toFixed(3)}  ${a.tunnel.length.toFixed(1)} m`, '#e2e8f0', 12);
    push(`|k| max ${a.tunnel.curvatureMax.toFixed(4)}  fork gap ${a.tunnel.forkGapM.toFixed(0)} m`, a.tunnel.curvatureMax < 0.03 ? '#86efac' : '#f87171', 12);
    push('');
  }
  push('SURFACE', '#f9a8d4', 14, 'bold');
  push(`boost pads ${a.boostPads.length}  drag zones ${a.dragZones.length}  kickers ${def.kickers.length}`, '#e2e8f0', 12);
  push(`bridges ${a.bridges.length}  canyons ${a.canyons.length}  hills ${def.hills.length}`, '#e2e8f0', 12);
  for (const b of a.bridges) push(`  bridge ${b.t0.toFixed(3)}-${b.t1.toFixed(3)} maxY ${b.maxY.toFixed(1)} m`, '#94a3b8', 11);
  push('');
  push('VALIDATION', a.validation.pass ? '#86efac' : '#f87171', 15, 'bold');
  push(`${a.validation.total - a.validation.failed}/${a.validation.total} checks pass`, a.validation.pass ? '#86efac' : '#f87171');
  for (const f of a.validation.checks.filter((c) => !c.ok).slice(0, 8)) {
    push(`FAIL ${f.name}`, '#f87171', 11);
  }

  let panel = '';
  let py = PAD + 18;
  for (const line of panelLines) {
    if (line.text === '') {
      py += 7;
      continue;
    }
    panel += `<text x="${PANEL_X + 8}" y="${py.toFixed(1)}" fill="${line.color}" font-family="monospace" font-size="${line.size}" font-weight="${line.weight}">${esc(line.text)}</text>`;
    py += line.size + 4;
  }

  const scaleBarM = 100;
  const scaleBarPx = scaleBarM * scale;
  const sbX = PAD + 10;
  const sbY = H - PAD - 10;
  const scaleBar = `
  <g>
  <line x1="${sbX}" y1="${sbY}" x2="${sbX + scaleBarPx}" y2="${sbY}" stroke="#cbd5e1" stroke-width="3"/>
  <line x1="${sbX}" y1="${sbY - 6}" x2="${sbX}" y2="${sbY + 6}" stroke="#cbd5e1" stroke-width="3"/>
  <line x1="${sbX + scaleBarPx}" y1="${sbY - 6}" x2="${sbX + scaleBarPx}" y2="${sbY + 6}" stroke="#cbd5e1" stroke-width="3"/>
  <text x="${sbX + scaleBarPx / 2}" y="${sbY - 10}" fill="#cbd5e1" font-family="monospace" font-size="14" text-anchor="middle">${scaleBarM} m</text>
  </g>`;

  const legendY = H - PAD - 66;
  const legend = `
  <g font-family="monospace" font-size="12" fill="#94a3b8">
  <line x1="${PANEL_X + 8}" y1="${legendY}" x2="${PANEL_X + 48}" y2="${legendY}" stroke="#3b82f6" stroke-width="4"/>
  <text x="${PANEL_X + 56}" y="${legendY + 4}">main (blue=straight, red=hairpin)</text>
  <line x1="${PANEL_X + 8}" y1="${legendY + 22}" x2="${PANEL_X + 48}" y2="${legendY + 22}" stroke="#ff9f1c" stroke-width="3" stroke-dasharray="9 6"/>
  <text x="${PANEL_X + 56}" y="${legendY + 26}">branches (dashed orange)</text>
  <line x1="${PANEL_X + 8}" y1="${legendY + 44}" x2="${PANEL_X + 48}" y2="${legendY + 44}" stroke="#37d3ff" stroke-width="8" stroke-opacity="0.5"/>
  <text x="${PANEL_X + 56}" y="${legendY + 48}">tunnel range</text>
  </g>`;

  let branchSvg = '';
  for (const b of branches) {
    branchSvg += `<path d="${pathD(b.points, false, sx, sy)}" fill="none" stroke="#2a2118" stroke-width="${(def.branches.find((x) => x.id === b.id)?.halfWidth ?? 10) * 2 * scale}" stroke-linejoin="round" stroke-linecap="round"/>`;
    branchSvg += `<path d="${pathD(b.points, false, sx, sy)}" fill="none" stroke="#ff9f1c" stroke-width="3.5" stroke-dasharray="9 6" stroke-linecap="round"/>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" style="display:block;background:#0b0e13">
<rect width="100%" height="100%" fill="#0b0e13"/>
<rect x="${PANEL_X - 10}" y="${PAD - 10}" width="${PANEL_W + 20}" height="${H - PAD * 2 + 20}" rx="10" fill="#111827" stroke="#1f2937"/>
<path d="${pathD(main.points, true, sx, sy)}" fill="none" stroke="#20262f" stroke-width="${(def.mainHalfWidth * 2 * scale).toFixed(1)}" stroke-linejoin="round" stroke-linecap="round"/>
${branchSvg}
${tunnelSvg}
${mainColored}
${forkSvg.join('\n')}
${boostSvg}
${scaleBar}
${legend}
${panel}
</svg>`;
}

// ---------------------------------------------------------------------------
// 运行
// ---------------------------------------------------------------------------
const analyses = TRACK_DEFS.map((def) => {
  const a = analyzeTrack(def);
  a.validation = validateTrack(a);
  return a;
});

const report = analyses.map((a) => ({
  id: a.def.id,
  name: a.def.name,
  difficulty: a.def.difficulty,
  laps: a.def.laps,
  main: {
    length: +a.main.length.toFixed(2),
    samples: a.main.samples,
    spacing: +a.main.spacing.toFixed(3),
    width: a.def.mainHalfWidth * 2,
    curvature: {
      p50: +a.main.curvature.p50.toFixed(4),
      p90: +a.main.curvature.p90.toFixed(4),
      p99: +a.main.curvature.p99.toFixed(4),
      max: +a.main.curvature.max.toFixed(4),
      maxRadius: +a.main.curvature.maxRadius.toFixed(1),
      rawMax: +a.main.curvature.rawMax.toFixed(4),
      maxAtT: +a.main.curvature.maxAtT.toFixed(4),
    },
    selfIntersections: a.main.selfIntersections,
    sharpTurns: a.main.sharpTurns.map((t) => ({ at: +t.at.toFixed(4), deg: +t.deg.toFixed(1) })),
    bounds: Object.fromEntries(Object.entries(a.main.bounds).map(([k, v]) => [k, +v.toFixed(1)])),
  },
  branches: a.branches.map((b) => ({
    id: b.id,
    name: b.name,
    length: +b.length.toFixed(2),
    tStart: +b.tStart.toFixed(4),
    tEnd: +b.tEnd.toFixed(4),
    lengthDiffPct: +b.lengthDiffPct.toFixed(2),
    maxCurvature: +b.curvature.max.toFixed(4),
    maxRadius: +b.curvature.maxRadius.toFixed(1),
    risk: b.risk,
    boostPadCount: b.boostPadCount,
    clearance: +b.clearance.min.toFixed(2),
    required: +b.clearance.required.toFixed(2),
    ends: b.ends.map((e) => ({
      name: e.name,
      distance: +e.distance.toFixed(3),
      tangentAngleDeg: +e.tangentAngleDeg.toFixed(3),
      heightDiff: +e.heightDiff.toFixed(3),
    })),
  })),
  branchPairs: a.branchPairs.map((p) => ({ a: p.a, b: p.b, min: +p.min.toFixed(1), required: +p.required.toFixed(1) })),
  tunnel: a.tunnel
    ? {
        length: +a.tunnel.length.toFixed(1),
        curvatureMax: +a.tunnel.curvatureMax.toFixed(4),
        forkGapM: +a.tunnel.forkGapM.toFixed(1),
      }
    : null,
  boostPads: a.boostPads.map((b) => ({ path: b.path, t: +b.t.toFixed(3), inside: b.inside, headingDiffDeg: +b.headingDiffDeg.toFixed(1) })),
  dragZones: a.dragZones.map((z) => ({ path: z.path, inside: z.inside })),
  bridges: a.bridges.map((b) => ({ t0: b.t0, t1: b.t1, maxY: +b.maxY.toFixed(1), aboveRatio: +b.aboveRatio.toFixed(2) })),
  validation: { pass: a.validation.pass, failed: a.validation.failed, total: a.validation.total },
}));

console.log(JSON.stringify(report, null, 2));

for (const a of analyses) {
  const file = join(ROOT, `track-preview-${a.def.id}.svg`);
  writeFileSync(file, renderSvg(a));
  console.log(`SVG: ${file}`);
}

if (process.env.VALIDATE === '1') {
  console.log('\n--- validation ---');
  for (const a of analyses) {
    console.log(`\n[${a.def.name}] ${a.validation.pass ? 'PASS' : 'FAIL'}`);
    for (const c of a.validation.checks) {
      console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  ::  ${c.detail}`);
    }
  }
}

if (process.env.VALIDATE === '1' && analyses.some((a) => !a.validation.pass)) {
  process.exitCode = 1;
}
