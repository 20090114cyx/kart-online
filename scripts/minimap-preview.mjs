import { Minimap } from '/src/minimap.ts';
import { createTrackLayout } from '/src/trackLayout.ts';

const layout = createTrackLayout();

const canvases = ['map-desktop', 'map-mobile', 'map-large'];
const maps = [];

for (const id of canvases) {
  const canvas = document.getElementById(id);
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error(`[minimap-preview] missing canvas #${id}`);
  }
  maps.push(new Minimap(canvas, layout));
}

const dprEl = document.getElementById('dpr');
function updateDpr() {
  if (dprEl) dprEl.textContent = window.devicePixelRatio.toFixed(2);
}
updateDpr();
window.addEventListener('resize', updateDpr);

function sampleClosed(points, u) {
  const n = points.length;
  const wrapped = ((u % 1) + 1) % 1;
  return points[Math.floor(wrapped * n) % n];
}

function sampleOpen(points, u) {
  const n = points.length;
  const clamped = Math.min(1, Math.max(0, u));
  return points[Math.min(n - 1, Math.floor(clamped * (n - 1)))];
}

// 复用同一个数组，避免每帧给 Minimap 制造垃圾。
const players = [
  { x: 0, z: 0, color: '#ffd166', isPlayer: true },
  { x: 0, z: 0, color: '#5aa9ff', isPlayer: false },
  { x: 0, z: 0, color: '#4ee39a', isPlayer: false },
  { x: 0, z: 0, color: '#c08bff', isPlayer: false },
];

const t0 = performance.now();

function tick() {
  const t = (performance.now() - t0) / 1000;

  const player = sampleClosed(layout.main.points, t * 0.042);
  const ai1 = sampleClosed(layout.main.points, t * 0.039 + 0.34);
  const ai2 = sampleClosed(layout.main.points, t * 0.036 + 0.71);

  // 支路是开放曲线，用三角波来回走，避免从汇合口瞬移回分叉口。
  const raw = (t * 0.075) % 2;
  const branchU = raw < 1 ? raw : 2 - raw;
  const ai3 = sampleOpen(layout.branch.points, branchU);

  players[0].x = player.x;
  players[0].z = player.z;
  players[1].x = ai1.x;
  players[1].z = ai1.z;
  players[2].x = ai2.x;
  players[2].z = ai2.z;
  players[3].x = ai3.x;
  players[3].z = ai3.z;

  for (const map of maps) map.update(players);
}

tick();
setInterval(tick, 50);

// 方便在控制台里检查投影 / 布局。
window.__minimapPreview = { layout, maps, players };
