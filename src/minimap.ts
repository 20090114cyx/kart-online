import type { BoostPad, DragZone, TrackLayout } from './trackLayout';

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
  /**
   * 车头朝向（世界系：forward = (sin h, 0, cos h)，与 Kart.heading 一致）。
   * 可选：老调用方没传时，用上一帧到这一帧的位移方向兜底。
   */
  heading?: number;
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

  /** 没传 heading 时的兜底：记住上一帧位置，用位移方向当朝向（对象复用，避免每帧分配）。 */
  private readonly headingCache = new WeakMap<
    MinimapPlayer,
    { x: number; z: number; heading: number }
  >();

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

  /** 每帧调用：只重绘静态背景 + 玩家箭头 / AI 圆点。players 数组不会被保存或修改。 */
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
      if (!p.isPlayer) this.drawAiDot(ctx, p);
    }
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (p.isPlayer) this.drawPlayerArrow(ctx, p);
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
    // 玩家改成带朝向的箭头，半径比原来的圆点略大，缩略图上更醒目。
    this.playerRadius = clamp(minDim * 0.042, 4.6, 6);
    this.aiRadius = Math.max(1.8, this.playerRadius * 0.55);

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

    // 减速带 / 跳台是玩法元素，压在主路、支路之上；玩家箭头在 update() 里
    // 每帧单独绘制，永远盖在这些静态标记之上。
    // layout.dragZones 已经合并了主路 def.dragZones 与各支路 dragZones。
    for (let i = 0; i < this.layout.dragZones.length; i++) {
      this.drawDragZone(ctx, this.layout.dragZones[i]!, mainW);
    }
    this.drawKickers(ctx, mainW);

    // 起跑线和加速带最后画，保证缩略图上最醒目的两个地标不被盖住。
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
    const depth = Math.max(1.6, mainW * 0.42);

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // 深色底衬 + 两侧白边：起跑线从灰色路面上跳出来，一眼能找到起点。
    ctx.fillStyle = 'rgba(8, 12, 18, 0.72)';
    ctx.fillRect(-depth - 0.8, -roadW * 0.5 - 0.8, depth * rows + 1.6, roadW + 1.6);

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

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = Math.max(0.8, mainW * 0.13);
    ctx.beginPath();
    ctx.moveTo(-depth, -roadW * 0.5);
    ctx.lineTo(depth * rows, -roadW * 0.5);
    ctx.moveTo(-depth, roadW * 0.5);
    ctx.lineTo(depth * rows, roadW * 0.5);
    ctx.stroke();

    ctx.restore();
  }

  /** 减速带：暗棕色小圆 + 斜线阴影，提示「这里会掉速」。只在静态层画一次。 */
  private drawDragZone(
    ctx: CanvasRenderingContext2D,
    zone: DragZone,
    mainW: number,
  ): void {
    const x = zone.x * this.scale + this.offsetX;
    const y = zone.z * this.scale + this.offsetZ;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const r = clamp(
      zone.radius * this.scale * 1.7,
      Math.max(2.4, mainW * 0.4),
      Math.max(4.4, mainW * 1.05),
    );

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = 'rgba(92, 58, 32, 0.62)';
    ctx.fill();

    // 圆形裁剪内画斜线阴影：静态层只构建一次，可以放心用 clip。
    ctx.clip();
    ctx.strokeStyle = 'rgba(38, 22, 10, 0.55)';
    ctx.lineWidth = Math.max(0.7, r * 0.26);
    const step = Math.max(1.6, r * 0.62);
    ctx.beginPath();
    for (let d = -r * 2; d <= r * 2; d += step) {
      ctx.moveTo(x + d - r, y - r);
      ctx.lineTo(x + d + r, y + r);
    }
    ctx.stroke();
    ctx.restore();

    // 暖棕外圈，和加速带的青色、跳台的黄色区分开。
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = 'rgba(226, 178, 118, 0.78)';
    ctx.lineWidth = Math.max(0.8, r * 0.2);
    ctx.stroke();
  }

  /** 跳台：主路 def.kickers + 各支路 kickers，统一画成黄色 V 形箭头（尖端朝行驶方向）。 */
  private drawKickers(ctx: CanvasRenderingContext2D, mainW: number): void {
    const def = this.layout.def;
    const main = this.layout.main;
    const n = main.points.length;

    // 主路跳台：按 t 换算到最近采样点，朝向取该点的切线。
    if (n > 0) {
      for (let i = 0; i < def.kickers.length; i++) {
        const k = def.kickers[i]!;
        const idx = Math.round(k.t * n) % n;
        const p = main.points[idx]!;
        const t = main.tangents[idx]!;
        this.drawKickerMark(ctx, p.x, p.z, Math.atan2(t.x, t.z), mainW);
      }
    }

    // 支路跳台：layout.branches 与 def.branches 一一对应（同一循环里生成），
    // 按 u 换算到支路采样点。
    const branchCount = Math.min(def.branches.length, this.layout.branches.length);
    for (let bi = 0; bi < branchCount; bi++) {
      const kickers = def.branches[bi]!.kickers;
      if (!kickers || kickers.length === 0) continue;
      const branch = this.layout.branches[bi]!;
      const count = branch.points.length;
      if (count === 0) continue;
      for (let i = 0; i < kickers.length; i++) {
        const idx = clamp(Math.round(kickers[i]!.t * (count - 1)), 0, count - 1);
        const p = branch.points[idx]!;
        const t = branch.tangents[idx]!;
        this.drawKickerMark(ctx, p.x, p.z, Math.atan2(t.x, t.z), mainW);
      }
    }
  }

  /** 单个跳台标记：深色描边打底 + 黄色 V 形，尖端朝 worldHeading。 */
  private drawKickerMark(
    ctx: CanvasRenderingContext2D,
    wx: number,
    wz: number,
    heading: number,
    mainW: number,
  ): void {
    const x = wx * this.scale + this.offsetX;
    const y = wz * this.scale + this.offsetZ;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const len = clamp(mainW * 0.95, 3.2, 7);
    // 世界 heading → 屏幕角：屏幕上 forward = (sin h, cos h)。
    const angle = Math.atan2(Math.cos(heading), Math.sin(heading));

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const chevron = (): void => {
      ctx.beginPath();
      ctx.moveTo(-len * 0.45, -len * 0.62);
      ctx.lineTo(len * 0.45, 0);
      ctx.lineTo(-len * 0.45, len * 0.62);
      ctx.stroke();
    };

    // 深色底衬：黄色在浅灰路面 / 沙地上也能看清。
    ctx.strokeStyle = 'rgba(20, 16, 6, 0.62)';
    ctx.lineWidth = Math.max(2, len * 0.52);
    chevron();

    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = Math.max(1.2, len * 0.26);
    chevron();
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

  /** 解析朝向：优先用调用方给的 heading，否则用上一帧到这一帧的位移方向兜底。 */
  private resolveHeading(p: MinimapPlayer): number {
    let heading = 0;
    if (typeof p.heading === 'number' && Number.isFinite(p.heading)) {
      heading = p.heading;
    }

    const prev = this.headingCache.get(p);
    if (!prev) {
      this.headingCache.set(p, { x: p.x, z: p.z, heading });
      return heading;
    }

    if (!(typeof p.heading === 'number' && Number.isFinite(p.heading))) {
      const dx = p.x - prev.x;
      const dz = p.z - prev.z;
      // 位移太小（停着不动）时保持上一帧朝向，避免箭头乱抖。
      if (dx * dx + dz * dz > 1e-4) {
        // 世界系朝向约定与 Kart.heading 一致：forward = (sin h, 0, cos h)。
        heading = Math.atan2(dx, dz);
      } else {
        heading = prev.heading;
      }
    }

    prev.x = p.x;
    prev.z = p.z;
    prev.heading = heading;
    return heading;
  }

  /** 玩家：三角形箭头，尖端朝车头，白色描边 + 主题色填充。 */
  private drawPlayerArrow(ctx: CanvasRenderingContext2D, p: MinimapPlayer): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;

    const x = p.x * this.scale + this.offsetX;
    const y = p.z * this.scale + this.offsetZ;
    if (x < -12 || y < -12 || x > this.cssW + 12 || y > this.cssH + 12) return;

    const r = this.playerRadius;
    const heading = this.resolveHeading(p);
    // 世界 heading → 画布旋转角：屏幕 x 对应世界 x、屏幕 y 对应世界 z，
    // 所以车头方向在屏幕上是 (sin h, cos h)，画布角 = atan2(cos h, sin h)。
    const angle = Math.atan2(Math.cos(heading), Math.sin(heading));

    // 柔光用同色半透明大圆，避免 shadowBlur 的开销。
    ctx.globalAlpha = 0.28;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(x, y, r * 1.8, 0, TAU);
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(r * 1.75, 0);
    ctx.lineTo(-r * 1.0, r * 0.88);
    ctx.lineTo(-r * 0.52, 0);
    ctx.lineTo(-r * 1.0, -r * 0.88);
    ctx.closePath();
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1.1, r * 0.36);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();
  }

  /** AI：圆点 + 一小段朝向短线，颜色沿用各自配色。 */
  private drawAiDot(ctx: CanvasRenderingContext2D, p: MinimapPlayer): void {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return;

    const x = p.x * this.scale + this.offsetX;
    const y = p.z * this.scale + this.offsetZ;
    if (x < -10 || y < -10 || x > this.cssW + 10 || y > this.cssH + 10) return;

    const r = this.aiRadius;
    const heading = this.resolveHeading(p);
    const angle = Math.atan2(Math.cos(heading), Math.sin(heading));

    // 朝向短线先画，圆点压住它的尾端，看起来像「圆点 + 一根车头指针」。
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(r * 0.4, 0);
    ctx.lineTo(r * 2.2, 0);
    ctx.strokeStyle = p.color;
    ctx.lineWidth = Math.max(1, r * 0.62);
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = p.color;
    ctx.fill();
    ctx.lineWidth = Math.max(0.8, r * 0.4);
    ctx.strokeStyle = 'rgba(6, 10, 16, 0.9)';
    ctx.stroke();
  }
}
