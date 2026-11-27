/**
 * 纯程序化合成的音频（零素材）：
 *  - 引擎：锯齿波 + 方波 → 低通，音高随速度/加速变化
 *  - 漂移胎噪：白噪声 → 带通，音量随滑移角
 *  - 风噪：白噪声 → 高通，随速度平方
 *  - 小喷：噪声扫频 + 正弦上扬，一次性触发
 *
 * 浏览器要求首次用户手势后才能出声，所以用 attach() 延迟初始化。
 */

export interface AudioState {
  speed: number; // m/s
  maxSpeed: number;
  drifting: boolean;
  slip: number; // 弧度
  boostTimer: number;
  throttle: number;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;

  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;

  private screechFilter: BiquadFilterNode | null = null;
  private screechGain: GainNode | null = null;
  private windGain: GainNode | null = null;

  private lastBoost = 0;
  private muted = false;

  attach(): void {
    const start = (): void => {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
  }

  private init(): void {
    if (this.ctx) return;

    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = 0.55;
    master.connect(ctx.destination);
    this.master = master;

    // ---- 噪声缓冲（胎噪 / 风噪 / 小喷共用） ----
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;

    // ---- 引擎 ----
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 70;

    const osc2 = ctx.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 106;
    osc2.detune.value = 6;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 1.1;

    const engineGain = ctx.createGain();
    engineGain.gain.value = 0.05;

    osc.connect(filter);
    osc2.connect(filter);
    filter.connect(engineGain);
    engineGain.connect(master);
    osc.start();
    osc2.start();

    this.engineOsc = osc;
    this.engineOsc2 = osc2;
    this.engineFilter = filter;
    this.engineGain = engineGain;

    // ---- 漂移胎噪 ----
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1500;
    bp.Q.value = 7;

    const sg = ctx.createGain();
    sg.gain.value = 0;

    src.connect(bp);
    bp.connect(sg);
    sg.connect(master);
    src.start();

    this.screechFilter = bp;
    this.screechGain = sg;

    // ---- 风噪 ----
    const src2 = ctx.createBufferSource();
    src2.buffer = buf;
    src2.loop = true;

    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 800;

    const wg = ctx.createGain();
    wg.gain.value = 0;

    src2.connect(hp);
    hp.connect(wg);
    wg.connect(master);
    src2.start();

    this.windGain = wg;
  }

  private boostSound(): void {
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.noiseBuffer;
    if (!ctx || !master || !buf) return;

    const t = ctx.currentTime;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.3;
    bp.frequency.setValueAtTime(480, t);
    bp.frequency.exponentialRampToValueAtTime(3600, t + 0.34);

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.2, t + 0.035);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.46);

    src.connect(bp);
    bp.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.5);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(190, t);
    o.frequency.exponentialRampToValueAtTime(880, t + 0.24);

    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.075, t + 0.02);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);

    o.connect(og);
    og.connect(master);
    o.start(t);
    o.stop(t + 0.34);
  }

  /** 落地闷响：低频下坠 + 短促的沙土噪声，强度 0..1 */
  land(impact: number): void {
    const ctx = this.ctx;
    const master = this.master;
    const buf = this.noiseBuffer;
    if (!ctx || !master || !buf) return;

    const amp = Math.min(1, Math.max(0, impact));
    if (amp < 0.04) return;
    const t = ctx.currentTime;

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.2);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.16 * amp, t + 0.012);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
    o.connect(og);
    og.connect(master);
    o.start(t);
    o.stop(t + 0.34);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(240, t + 0.26);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.085 * amp, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    src.start(t);
    src.stop(t + 0.36);
  }

  update(_dt: number, s: AudioState): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineOsc || !this.engineGain) return;

    const t = ctx.currentTime;
    const ratio = Math.min(1, Math.max(0, s.speed / s.maxSpeed));
    const boosting = s.boostTimer > 0;

    const baseF = 62 + ratio * 128 + (boosting ? 26 : 0);
    this.engineOsc.frequency.setTargetAtTime(baseF, t, 0.06);
    if (this.engineOsc2) this.engineOsc2.frequency.setTargetAtTime(baseF * 1.51, t, 0.06);
    if (this.engineFilter) {
      this.engineFilter.frequency.setTargetAtTime(620 + ratio * 2100 + (boosting ? 900 : 0), t, 0.08);
    }

    const engineVol = 0.045 + ratio * 0.07 + (s.throttle > 0 ? 0.018 : 0);
    this.engineGain.gain.setTargetAtTime(engineVol, t, 0.08);

    if (this.screechGain && this.screechFilter) {
      const screech = s.drifting ? Math.min(1, Math.abs(Math.sin(s.slip)) * 1.7) : 0;
      this.screechGain.gain.setTargetAtTime(screech * 0.095, t, 0.05);
      this.screechFilter.frequency.setTargetAtTime(1150 + ratio * 1000, t, 0.1);
    }

    if (this.windGain) {
      this.windGain.gain.setTargetAtTime(ratio * ratio * 0.05, t, 0.15);
    }

    if (s.boostTimer > 0.05 && this.lastBoost <= 0.05) this.boostSound();
    this.lastBoost = s.boostTimer;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.55, this.ctx.currentTime, 0.03);
    }
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  dispose(): void {
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
  }
}
