import type { BoostPad, TrackLayout } from './trackLayout';

/**
 * HUD 小地图：纯 2D canvas，不依赖 three.js 运行时。
 *
 * 设计要点：
 * - 只在构造 / resize 时把赛道中心线投影成 Path2D，并预渲染到离屏 canvas；
 * - 每帧 update 只 blit 一次静态背景 + 画最多几十个圆点，不重建路径、不分配对象；
 * - canvas 的 CSS 尺寸由外部决定（HUD / 预览页），内部按 devicePixelRatio 调整 backing store；
 * - 世界坐标 x → 画布 x，世界坐标 z → 画布 y（俯视，起跑线在左侧）。
 */

export interface MinimapPlayer {
  x: number;
  z: number;
  color: string;
  isPlayer: boolean;
}

const TAU = Math.PI * 2;
const MAX_DPR = 3;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 兼容性优先：不用 ctx.roundRect，手写圆角矩形 Path2D。 */
function roundedRectPath(w: number, h: number, radius: number): Path2D {
  const path = new Path2D();
  const r = Math.max(0, Math.min(radius, w * 0.5, h * 0.5));
  path.moveTo(r, 0);
  path.lineTo(w - r, 0);
  path.arcTo(w, 0, w, r, r);
  path.lineTo(w, h - r);
  path.arcTo(w, h, w - r, h, r);
  path.lineTo(r, h);
  path.arcTo(0, h, 0, h - r, r);
  path.lineTo(0, r);
  path.arcTo(0, 0, r, 0, r);
  path.closePath();
  return path;
}

interface LayoutBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

function layoutBounds(layout: TrackLayout): LayoutBounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const scan = (points: ReadonlyArray<{ x: number; z: number }>): void => {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  };

  scan(layout.main.points);
  for (const branch of layout.branches) scan(branch.points);

  if (!Number.isFinite(minX) || !Number.isFinite(maxX) || !Number.isFinite(minZ) || !Number.isFinite(maxZ)) {
    return { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
  }
  return { minX, maxX, minZ, maxZ };
}

export class Minimap {
  private readonly canvas: HTMLCanvasElement;
  private readonly layout: TrackLayout;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticCtx: CanvasRenderingContext2D;
  private readonly handleWindowResize = (): void => {
    this.resize();
  };

  private resizeObserver: ResizeObserver | null = null;

  private cssW = 0;
  private cssH = 0;
  private pixelW = 0;
  private pixelH = 0;
  private dpr = 1;
  private ready = false;
  private disposed = false;

  /** 世界 → CSS 像素的投影参数，只在 resize 时更新 */
  private scale = 1;
  private offsetX = 0;
  private offsetZ = 0;

  private playerRadius = 3;
  private aiRadius = 2;
  private clipPath: Path2D | null = null;

  constructor(canvas: HTMLCanvasElement, layout: TrackLayout) {
    this.canvas = canvas;
    this.layout = layout;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('[Minimap] canvas 2D context unavailable');
    this.ctx = ctx;

    const offscreen = document.createElement('canvas');
    const offCtx = offscreen.getContext('2d');
    if (!offCtx) throw new Error('[Minimap] offscreen 2D context unavailable');
    this.staticCanvas = offscreen;
    this.staticCtx = offCtx;

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleWindowResize);
    }

    this.resize();
  }

  /** 重新读取 CSS 尺寸 / DPR，并重建静态层。外部可手动调用。 */
  resize(): void {
    if (this.disposed) return;

    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    if (cw < 1 || ch < 1) {
      this.ready = false;
      return;
    }

    const cssW = Math.max(1, Math.round(cw));
    const cssH = Math.max(1, Math.round(ch));
    const rawDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const dpr = Math.min(MAX_DPR, Math.max(1, rawDpr));

    if (this.ready && cssW === this.cssW && cssH === this.cssH && dpr === this.dpr) return;

    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.pixelW = Math.max(1, Math.round(cssW * dpr));
    this.pixelH = Math.max(1, Math.round(cssH * dpr));

    this.canvas.width = this.pixelW;
    this.canvas.height = this.pixelH;

    // 没有 CSS 尺寸时，canvas 会按 backing store 撑开，ResizeObserver 会自激。
    // 如果设置后布局尺寸变了，就把当前 CSS 尺寸锁住（有 CSS 尺寸时通常不会变）。
    if (
      Math.abs(this.canvas.clientWidth - cssW) > 1 ||
      Math.abs(this.canvas.clientHeight - cssH) > 1
    ) {
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }

    this.buildStatic();
  }

  /** 每帧调用：只重绘静态背景 + 玩家点。players 数组不会被保存或修改。 */
  update(players: MinimapPlayer[]): void {
    if (this.disposed || !this.ready) return;

    // 拖到不同 DPR 的屏幕 / 浏览器缩放时，window.resize 不一定触发，这里补一次检查。
    if (typeof window !== 'undefined') {
      const rawDpr = window.devicePixelRatio || 1;
      const dpr = Math.min(MAX_DPR, Math.max(1, rawDpr));
      if (dpr !== this.dpr) {
        this.resize();
        if (!this.ready) return;
      }
    }

    const ctx = this.ctx;

    // 静态层按设备像素 1:1 blit，避免每帧重算路径。
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.pixelW, this.pixelH);
    ctx.drawImage(this.staticCanvas, 0, 0);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const clip = this.clipPath;
    if (clip) {
      ctx.save();
      ctx.clip(clip);
    }

    // AI 先画、玩家后画，保证玩家永远在最上层。
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (!p.isPlayer) this.drawDot(ctx, p);
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.isPlayer) this.drawDot(ctx, p);
    }

    if (clip) ctx.restore();
  }

  /** 断开监听并释放离屏 canvas。之后 update / resize 都是空操作。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleWindowResize);
    }

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.staticCanvas.width = 0;
    this.staticCanvas.height = 0;
    this.clipPath = null;
    this.ready = false;
  }

  private buildStatic(): void {
    const w = this.cssW;
    const h = this.cssH;
    const dpr = this.dpr;
    const ctx = this.staticCtx;

    this.staticCanvas.width = this.pixelW;
    this.staticCanvas.height = this.pixelH;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const minDim = Math.min(w, h);
    const radius = clamp(minDim * 0.075, 4, 16);
    const clip = roundedRectPath(w, h, radius);
    this.clipPath = clip;

    ctx.save();
    ctx.clip(clip);

    // 半透明深色底 + 轻微上亮下暗，压在游戏画面上也能看清。
    ctx.fillStyle = 'rgba(10, 14, 20, 0.55)';
    ctx.fillRect(0, 0, w, h);
    const sheen = ctx.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.055)');
    sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0)');
    sheen.addColorStop(1, 'rgba(0, 0, 0, 0.14)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, w, h);

    // ---- 投影：主路 + 所有支路一起算边界，保持比例、居中、留边 ----
    const bounds = layoutBounds(this.layout);
    const margin = clamp(minDim * 0.075, 6, 18);
    const availW = Math.max(1, w - margin * 2);
    const availH = Math.max(1, h - margin * 2);
    const spanX = Math.max(1e-3, bounds.maxX - bounds.minX);
    const spanZ = Math.max(1e-3, bounds.maxZ - bounds.minZ);
    const scale = Math.min(availW / spanX, availH / spanZ);

    this.scale = scale;
    this.offsetX = margin + (availW - spanX * scale) * 0.5 - bounds.minX * scale;
    this.offsetZ = margin + (availH - spanZ * scale) * 0.5 - bounds.minZ * scale;

    const mainW = clamp(minDim * 0.05, 4, 8);
    this.playerRadius = clamp(minDim * 0.027, 2.8, 4.6);
    this.aiRadius = Math.max(1.8, this.playerRadius * 0.62);

    const mainPath = this.projectPath(this.layout.main.points, true);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
    ctx.lineWidth = mainW + 2.4;
    ctx.stroke(mainPath);
    ctx.strokeStyle = '#cfd8e3';
    ctx.lineWidth = mainW;
    ctx.stroke(mainPath);

    // 支路在缩略图上往往和主路贴得很近，画成粗线会变成一坨蓝色斑块。
    // 改成主路之上的细青色虚线：远看是「这里有岔路」，近看能看清走向。
    for (const branch of this.layout.branches) {
      const branchPath = this.projectPath(branch.points, false);
      ctx.strokeStyle = 'rgba(0, 20, 30, 0.5)';
      ctx.lineWidth = Math.max(2.4, mainW * 0.46);
      ctx.setLineDash([Math.max(4, mainW * 0.8), Math.max(2.5, mainW * 0.5)]);
      ctx.stroke(branchPath);
      ctx.strokeStyle = 'rgba(96, 220, 255, 0.98)';
      ctx.lineWidth = Math.max(1.4, mainW * 0.3);
      ctx.stroke(branchPath);
      ctx.setLineDash([]);
    }

    // 隧道：很淡的黄色底光 + 亮黄色虚线。
    if (this.layout.tunnel) {
      const tunnelPath = this.projectRange(
        this.layout.main.points,
        this.layout.tunnel.tStart,
        this.layout.tunnel.tEnd,
      );
      const dash = Math.max(2, mainW * 0.55);
      ctx.strokeStyle = 'rgba(255, 209, 102, 0.16)';
      ctx.lineWidth = mainW + 3;
      ctx.stroke(tunnelPath);
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = Math.max(1.5, mainW * 0.3);
      ctx.setLineDash([dash, dash * 0.9]);
      ctx.stroke(tunnelPath);
      ctx.setLineDash([]);
    }

    this.drawStartLine(ctx, mainW);
    for (let i = 0; i < this.layout.boostPads.length; i++) {
      this.drawBoostPad(ctx, this.layout.boostPads[i]!, mainW);
    }

    ctx.restore();

    // 内描边，让圆角边界更清晰。
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 1;
    ctx.stroke(clip);

    this.ready = true;
  }

  private projectPath(
    points: ReadonlyArray<{ x: number; z: number }>,
    closed: boolean,
  ): Path2D {
    const path = new Path2D();
    const n = points.length;
    if (n === 0) return path;

    const first = points[0]!;
    path.moveTo(first.x * this.scale + this.offsetX, first.z * this.scale + this.offsetZ);
    for (let i = 1; i < n; i++) {
      const p = points[i]!;
      path.lineTo(p.x * this.scale + this.offsetX, p.z * this.scale + this.offsetZ);
    }
    if (closed) path.closePath();
    return path;
  }

  /** 取闭合主路上 tStart..tEnd 的一段，用于隧道高亮。 */
  private projectRange(
    points: ReadonlyArray<{ x: number; z: number }>,
    tStart: number,
    tEnd: number,
  ): Path2D {
    const path = new Path2D();
    const n = points.length;
    if (n === 0) return path;

    const wrap = (t: number): number => ((t % 1) + 1) % 1;
    const i0 = Math.floor(wrap(tStart) * n);
    const i1 = Math.ceil(wrap(tEnd) * n);
    let span = i1 - i0;
    if (span <= 0) span += n;

    for (let k = 0; k <= span; k++) {
      const p = points[(i0 + k) % n]!;
      const x = p.x * this.scale + this.offsetX;
      const y = p.z * this.scale + this.offsetZ;
      if (k === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    return path;
  }

  /** 起跑线：沿赛道方向两行、横向四列的小格，跨过整个路面。 */
  private drawStartLine(ctx: CanvasRenderingContext2D, mainW: number): void {
    const main = this.layout.main;
    const start = this.layout.start;
    const tangent = main.tangents[0];
    const angle = tangent ? Math.atan2(tangent.z, tangent.x) : Math.PI * 0.5;
    const halfWidth = main.halfWidths[0] ?? 11;

    const x = start.x * this.scale + this.offsetX;
    const y = start.z * this.scale + this.offsetZ;
    const roadW = Math.max(mainW * 1.15, halfWidth * 2 * this.scale);
    const cols = 4;
    const rows = 2;
    const cell = roadW / cols;
    const depth = Math.max(1.2, mainW * 0.32);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.fillStyle = (r + c) % 2 === 0 ? '#f2f6fb' : 'rgba(10, 14, 20, 0.9)';
        ctx.fillRect(
          -depth + r * depth,
          -roadW * 0.5 + c * cell,
          depth + 0.2,
          cell + 0.2,
        );
      }
    }
    ctx.restore();
  }

  /** 加速带：青色小箭头 + 中心亮点，朝向由 layout 的 heading 决定。 */
  private drawBoostPad(ctx: CanvasRenderingContext2D, pad: BoostPad, mainW: number): void {
    const x = pad.x * this.scale + this.offsetX;
    const y = pad.z * this.scale + this.offsetZ;
    const len = Math.max(3.2, mainW * 0.85);
    const half = len * 0.42;

    // 世界 heading = atan2(dx, dz)；屏幕上前方是 (sin h, cos h)。
    const angle = Math.atan2(Math.cos(pad.heading), Math.sin(pad.heading));

    ctx.beginPath();
    ctx.arc(x, y, len * 0.9, 0, TAU);
    ctx.fillStyle = 'rgba(70, 225, 255, 0.16)';
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(len * 0.55, 0);
    ctx.lineTo(-len * 0.45, half);
    ctx.lineTo(-len * 0.15, 0);
    ctx.lineTo(-len * 0.45, -half);
    ctx.closePath();
    ctx.fillStyle = '#5fe7ff';
    ctx.fill();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.9, len * 0.16), 0, TAU);
    ctx.fillStyle = '#e9feff';
    ctx.fill();
  }

  private drawDot(ctx: CanvasRenderingContext2D, p: MinimapPlayer): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;

    const x = p.x * this.scale + this.offsetX;
    const y = p.z * this.scale + this.offsetZ;
    if (x < -10 || y < -10 || x > this.cssW + 10 || y > this.cssH + 10) return;

    if (p.isPlayer) {
      const r = this.playerRadius;

      // 柔光用同色半透明大圆，避免 shadowBlur 的开销。
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.9, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = Math.max(1.1, r * 0.42);
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    } else {
      const r = this.aiRadius;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = Math.max(0.8, r * 0.4);
      ctx.strokeStyle = 'rgba(6, 10, 16, 0.9)';
      ctx.stroke();
    }
  }
}
