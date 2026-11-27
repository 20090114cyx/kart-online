/** 键盘 / 手柄 / 触屏统一输入层 */

interface GamepadFrame {
  steer: number;
  throttle: number;
  brake: number;
  drift: boolean;
}

type PedalDir = 'up' | 'down';
type SteerDir = 'left' | 'right';

export class Input {
  throttle = 0;
  brake = 0;
  steer = 0;
  drift = false;

  // 本地双人：P2 独立一套状态，单人的四个字段继续给 P1 用
  throttle2 = 0;
  brake2 = 0;
  steer2 = 0;
  drift2 = false;

  readonly isTouch: boolean;

  private readonly keys = new Set<string>();
  private steerTarget = 0;
  private steerTarget2 = 0;
  private twoPlayer = false;

  // 触屏：左边油门/刹车，右边转向 + 漂移
  private touchUp = false;
  private touchDown = false;
  private touchLeft = false;
  private touchRight = false;
  private touchDrift = false;

  private pedalPointer = -1;
  private steerPointer = -1;
  private driftPointer = -1;

  private pedalEl: HTMLElement | null = null;
  private steerEl: HTMLElement | null = null;
  private pedalButtons: Partial<Record<PedalDir, HTMLElement>> = {};
  private steerButtons: Partial<Record<SteerDir, HTMLElement>> = {};

  // 漂移键：按住 = 一直漂；轻点 = 锁定漂移，再点一下松漂（方便一根拇指边漂边转）
  private driftLatched = false;
  private driftPressAt = 0;
  private driftEl: HTMLElement | null = null;

  constructor() {
    // ?touch=1 可以强制打开触屏控件，方便在桌面浏览器里预览手机布局
    const forceTouch = new URLSearchParams(window.location.search).has('touch');
    this.isTouch = forceTouch || window.matchMedia('(pointer: coarse)').matches;
    if (this.isTouch) document.body.classList.add('touch');

    window.addEventListener('keydown', this.onKeyDown, { passive: false });
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('pagehide', this.onBlur);
    // 手机上切后台 / 来电常常不触发 blur，只发 visibilitychange
    document.addEventListener('visibilitychange', this.onVisibility);

    this.setupTouch();
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (
      e.code === 'Space' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.releaseTouch();
    this.throttle2 = 0;
    this.brake2 = 0;
    this.steer2 = 0;
    this.drift2 = false;
    this.steerTarget2 = 0;
  };

  private onVisibility = (): void => {
    if (document.hidden) this.onBlur();
  };

  /** 切换单人 / 本地双人。双人时方向键给 P2，WASD 给 P1。 */
  setTwoPlayer(on: boolean): void {
    this.twoPlayer = on;
    if (!on) {
      this.throttle2 = 0;
      this.brake2 = 0;
      this.steer2 = 0;
      this.drift2 = false;
      this.steerTarget2 = 0;
    }
  }

  /** 清空所有触屏状态（失焦、切后台、重开比赛时用） */
  releaseTouch(): void {
    this.releasePointer(this.pedalEl, this.pedalPointer);
    this.releasePointer(this.steerEl, this.steerPointer);
    this.releasePointer(this.driftEl, this.driftPointer);
    this.pedalPointer = -1;
    this.steerPointer = -1;
    this.driftPointer = -1;
    this.touchUp = false;
    this.touchDown = false;
    this.touchLeft = false;
    this.touchRight = false;
    this.touchDrift = false;
    this.driftLatched = false;
    this.syncPedals();
    this.syncSteer();
    this.syncDrift();
  }

  private releasePointer(el: HTMLElement | null, id: number): void {
    if (!el || id < 0) return;
    try {
      el.releasePointerCapture(id);
    } catch {
      // 指针已经抬起 / 浏览器不支持，忽略
    }
  }

  private setupTouch(): void {
    if (!this.isTouch) return;

    this.setupPedals();
    this.setupSteer();
    this.setupDrift();
  }

  /** 左侧：上半 = 油门，下半 = 刹车；拇指上下滑就能切换 */
  private setupPedals(): void {
    const el = document.getElementById('touchPedals');
    if (!el) return;
    this.pedalEl = el;

    el.querySelectorAll<HTMLElement>('[data-touch]').forEach((btn) => {
      const dir = btn.dataset.touch as PedalDir | undefined;
      if (dir) this.pedalButtons[dir] = btn;
    });

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      // 已经有一根手指在踩踏板时忽略新的手指，避免抬起第二根手指把油门清掉
      if (this.pedalPointer !== -1) return;
      this.pedalPointer = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 合成事件 / 部分浏览器不支持捕获，忽略即可
      }
      this.applyPedals(e, el);
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.pedalPointer) return;
      this.applyPedals(e, el);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== this.pedalPointer) return;
      this.pedalPointer = -1;
      this.touchUp = false;
      this.touchDown = false;
      this.syncPedals();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  private applyPedals(e: PointerEvent, el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const ny = (e.clientY - rect.top) / rect.height - 0.5;
    // 上半 = 油门，下半 = 刹车，分界就在正中间
    this.touchDown = ny > 0;
    this.touchUp = !this.touchDown;
    this.syncPedals();
  }

  private syncPedals(): void {
    this.pedalButtons.up?.classList.toggle('on', this.touchUp);
    this.pedalButtons.down?.classList.toggle('on', this.touchDown);
  }

  /** 右侧：左右转向键，横向滑动切换 */
  private setupSteer(): void {
    const el = document.getElementById('touchSteerPad');
    if (!el) return;
    this.steerEl = el;

    el.querySelectorAll<HTMLElement>('[data-touch]').forEach((btn) => {
      const dir = btn.dataset.touch as SteerDir | undefined;
      if (dir) this.steerButtons[dir] = btn;
    });

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      if (this.steerPointer !== -1) return;
      this.steerPointer = e.pointerId;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 忽略不支持指针捕获的环境
      }
      this.applySteer(e, el);
    });
    el.addEventListener('pointermove', (e: PointerEvent) => {
      if (e.pointerId !== this.steerPointer) return;
      this.applySteer(e, el);
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== this.steerPointer) return;
      this.steerPointer = -1;
      this.touchLeft = false;
      this.touchRight = false;
      this.syncSteer();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
  }

  private applySteer(e: PointerEvent, el: HTMLElement): void {
    const rect = el.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width - 0.5;
    this.touchLeft = nx < -0.04;
    this.touchRight = nx > 0.04;
    this.syncSteer();
  }

  private syncSteer(): void {
    this.steerButtons.left?.classList.toggle('on', this.touchLeft);
    this.steerButtons.right?.classList.toggle('on', this.touchRight);
  }

  private setupDrift(): void {
    const el = document.getElementById('touchDrift');
    if (!el) return;
    this.driftEl = el;

    el.addEventListener('pointerdown', (e: PointerEvent) => {
      e.preventDefault();
      // 同一时间只跟一根手指，第二根手指不打断第一根
      if (this.driftPointer !== -1 && this.driftPointer !== e.pointerId) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 忽略不支持指针捕获的环境
      }
      // 漂移已经开着（不管是锁定还是按住），再按一下就是松漂
      if (this.touchDrift) {
        this.touchDrift = false;
        this.driftLatched = false;
        this.driftPointer = -1;
        this.syncDrift();
        return;
      }
      this.driftPointer = e.pointerId;
      this.touchDrift = true;
      this.driftLatched = false;
      this.driftPressAt = performance.now();
      this.syncDrift();
    });

    const up = (e: PointerEvent): void => {
      if (e.pointerId !== this.driftPointer) return;
      this.driftPointer = -1;
      if (!this.touchDrift) return;
      // 轻点（< 220ms）→ 锁定漂移；按住后松开 → 正常松漂
      if (performance.now() - this.driftPressAt < 220) {
        this.driftLatched = true;
      } else {
        this.touchDrift = false;
        this.driftLatched = false;
      }
      this.syncDrift();
    };
    // 被打断（来电、系统手势、切后台）时直接松开，不触发「轻点锁定」
    const abort = (e: PointerEvent): void => {
      if (e.pointerId !== this.driftPointer) return;
      this.driftPointer = -1;
      this.touchDrift = false;
      this.driftLatched = false;
      this.syncDrift();
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', abort);
    el.addEventListener('lostpointercapture', abort);
  }

  private syncDrift(): void {
    const el = this.driftEl;
    if (!el) return;
    el.classList.toggle('on', this.touchDrift);
    el.textContent = this.touchDrift ? '松漂' : '漂移';
  }

  /** 读取所有已连接手柄，按连接顺序返回；空闲手柄返回 null。 */
  private readGamepads(): Array<GamepadFrame | null> {
    if (typeof navigator.getGamepads !== 'function') return [];

    const pads = navigator.getGamepads();
    const frames: Array<GamepadFrame | null> = [];
    for (let i = 0; i < pads.length; i++) {
      const gp = pads[i];
      if (!gp || !gp.connected) continue;

      const ax = gp.axes.length > 0 ? gp.axes[0] ?? 0 : 0;
      const steer = Math.abs(ax) > 0.12 ? -ax : 0;
      const throttle = gp.buttons.length > 7 ? gp.buttons[7]?.value ?? 0 : 0;
      const brake = gp.buttons.length > 6 ? gp.buttons[6]?.value ?? 0 : 0;
      const drift =
        (gp.buttons.length > 0 && (gp.buttons[0]?.pressed ?? false)) ||
        (gp.buttons.length > 5 && (gp.buttons[5]?.pressed ?? false));

      if (steer === 0 && throttle < 0.05 && brake < 0.05 && !drift) {
        frames.push(null);
      } else {
        frames.push({ steer, throttle, brake, drift });
      }
    }
    return frames;
  }

  update(dt: number): void {
    let target = 0;
    let analog = false;
    let throttle = 0;
    let brake = 0;
    let drift = false;

    let target2 = 0;
    let analog2 = false;
    let throttle2 = 0;
    let brake2 = 0;
    let drift2 = false;

    const k = this.keys;

    // ---------------- P1 键盘 ----------------
    if (k.has('KeyW')) throttle = 1;
    if (k.has('KeyS')) brake = 1;
    if (k.has('KeyA')) target += 1;
    if (k.has('KeyD')) target -= 1;
    if (k.has('ShiftLeft') || k.has('Space')) drift = true;

    // 单人时方向键仍然可以控制 P1；双人时方向键归 P2
    if (!this.twoPlayer) {
      if (k.has('ArrowUp')) throttle = 1;
      if (k.has('ArrowDown')) brake = 1;
      if (k.has('ArrowLeft')) target += 1;
      if (k.has('ArrowRight')) target -= 1;
      if (k.has('ShiftRight')) drift = true;
    }

    // ---------------- P2 键盘 ----------------
    if (this.twoPlayer) {
      if (k.has('ArrowUp')) throttle2 = 1;
      if (k.has('ArrowDown')) brake2 = 1;
      if (k.has('ArrowLeft')) target2 += 1;
      if (k.has('ArrowRight')) target2 -= 1;
      if (k.has('ShiftRight') || k.has('Numpad0')) drift2 = true;
    }

    // ---------------- 手柄：第一个给 P1，第二个给 P2 ----------------
    const pads = this.readGamepads();
    const gp = pads[0] ?? null;
    const gp2 = pads[1] ?? null;

    if (gp) {
      analog = true;
      target = gp.steer;
      if (gp.throttle > throttle) throttle = gp.throttle;
      if (gp.brake > brake) brake = gp.brake;
      if (gp.drift) drift = true;
    }

    if (this.twoPlayer && gp2) {
      analog2 = true;
      target2 = gp2.steer;
      if (gp2.throttle > throttle2) throttle2 = gp2.throttle;
      if (gp2.brake > brake2) brake2 = gp2.brake;
      if (gp2.drift) drift2 = true;
    }

    // ---------------- 触屏：只控制 P1 ----------------
    if (this.isTouch) {
      const touchActive =
        this.touchUp ||
        this.touchDown ||
        this.touchLeft ||
        this.touchRight ||
        this.touchDrift;
      // 接了蓝牙手柄时，没碰屏幕就不要用「触屏默认值」把摇杆覆盖掉
      if (!gp || touchActive) {
        analog = true;
        target = (this.touchLeft ? 1 : 0) - (this.touchRight ? 1 : 0);
        if (this.touchUp) throttle = 1;
        if (this.touchDown) brake = 1;
        if (this.touchDrift) drift = true;
      }
    }

    if (target > 1) target = 1;
    else if (target < -1) target = -1;
    if (target2 > 1) target2 = 1;
    else if (target2 < -1) target2 = -1;

    this.steerTarget = target;
    const rate = analog ? 45 : 22;
    this.steer += (this.steerTarget - this.steer) * (1 - Math.exp(-rate * dt));

    this.throttle = throttle;
    this.brake = brake;
    this.drift = drift;

    if (this.twoPlayer) {
      this.steerTarget2 = target2;
      const rate2 = analog2 ? 45 : 22;
      this.steer2 += (this.steerTarget2 - this.steer2) * (1 - Math.exp(-rate2 * dt));
      this.throttle2 = throttle2;
      this.brake2 = brake2;
      this.drift2 = drift2;
    } else {
      this.throttle2 = 0;
      this.brake2 = 0;
      this.steer2 = 0;
      this.drift2 = false;
    }
  }
}
