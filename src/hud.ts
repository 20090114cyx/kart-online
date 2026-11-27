export interface HudState {
  speedKmh: number;
  charge: number; // 0..1
  drifting: boolean;
  boostFlash: number; // 0..1，1 = 刚触发
  lapTime: number; // 秒
  bestTime: number; // 秒，<=0 表示无记录
  lap: number; // 已完成圈数
  totalLaps: number;
  rank: number; // 1 起
  totalRacers: number;
  finished: boolean;
  finishRank: number; // 0 = 未完赛
  finishTime: number; // 秒
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '--:--.--';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
}

/**
 * 纯 DOM 的 HUD，一套实例对应一个玩家面板（#hudP1 / #hudP2）。
 * 构造函数一次性抓取并缓存元素，之后每帧 update 只写 textContent / class / style。
 */
export class Hud {
  private readonly speedEl: HTMLElement | null;
  private readonly lapTimeEl: HTMLElement | null;
  private readonly bestTimeEl: HTMLElement | null;
  private readonly lapCountEl: HTMLElement | null;
  private readonly chargeFillEl: HTMLElement | null;
  private readonly driftTagEl: HTMLElement | null;
  private readonly boostFlashEl: HTMLElement | null;
  private readonly rankPosEl: HTMLElement | null;
  private readonly rankTotalEl: HTMLElement | null;
  private readonly doneEl: HTMLElement | null;
  private readonly doneRankEl: HTMLElement | null;
  private readonly doneTimeEl: HTMLElement | null;

  private lastLapText = '';

  constructor(root: HTMLElement) {
    this.speedEl = Hud.find(root, 'speed');
    this.lapTimeEl = Hud.find(root, 'lapTime');
    this.bestTimeEl = Hud.find(root, 'bestTime');
    this.lapCountEl = Hud.find(root, 'lapCount');
    this.chargeFillEl = Hud.find(root, 'chargeFill');
    this.driftTagEl = Hud.find(root, 'driftTag');
    this.boostFlashEl = Hud.find(root, 'boostFlash');
    this.rankPosEl = Hud.find(root, 'rankPos');
    this.rankTotalEl = Hud.find(root, 'rankTotal');
    this.doneEl = Hud.find(root, 'done');
    this.doneRankEl = Hud.find(root, 'doneRank');
    this.doneTimeEl = Hud.find(root, 'doneTime');
  }

  update(s: HudState): void {
    const speedEl = this.speedEl;
    if (speedEl) speedEl.textContent = String(Math.round(s.speedKmh));

    const lapTimeEl = this.lapTimeEl;
    if (lapTimeEl) lapTimeEl.textContent = s.lapTime.toFixed(2);

    const bestTimeEl = this.bestTimeEl;
    if (bestTimeEl) bestTimeEl.textContent = s.bestTime > 0 ? s.bestTime.toFixed(2) : '--.--';

    const lapCountEl = this.lapCountEl;
    if (lapCountEl) {
      const text = s.lap >= s.totalLaps ? '完赛' : `${s.lap + 1}/${s.totalLaps}`;
      if (text !== this.lastLapText) {
        lapCountEl.textContent = text;
        this.lastLapText = text;
      }
    }

    const rankPosEl = this.rankPosEl;
    if (rankPosEl) rankPosEl.textContent = String(s.rank);
    const rankTotalEl = this.rankTotalEl;
    if (rankTotalEl) rankTotalEl.textContent = String(s.totalRacers);

    const charge = clamp01(s.charge);
    const chargeFillEl = this.chargeFillEl;
    if (chargeFillEl) {
      chargeFillEl.style.transform = `scaleX(${charge})`;
      this.setClass(chargeFillEl, 'full', charge >= 0.995);
    }

    this.setClass(this.driftTagEl, 'on', s.drifting);

    const boostFlashEl = this.boostFlashEl;
    if (boostFlashEl) {
      if (s.boostFlash > 0.01) {
        this.setClass(boostFlashEl, 'on', true);
        boostFlashEl.style.opacity = String(s.boostFlash);
      } else {
        this.setClass(boostFlashEl, 'on', false);
        boostFlashEl.style.opacity = '0';
      }
    }

    const doneEl = this.doneEl;
    if (doneEl) {
      this.setClass(doneEl, 'show', s.finished);
      if (s.finished) {
        const doneRankEl = this.doneRankEl;
        if (doneRankEl) doneRankEl.textContent = `第 ${s.finishRank} 名`;
        const doneTimeEl = this.doneTimeEl;
        if (doneTimeEl) doneTimeEl.textContent = formatTime(s.finishTime);
      }
    }
  }

  private setClass(el: HTMLElement | null, name: string, on: boolean): void {
    if (!el) return;
    if (el.classList.contains(name) === on) return;
    el.classList.toggle(name, on);
  }

  private static find(root: HTMLElement, name: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(`[data-hud="${name}"]`);
  }
}
