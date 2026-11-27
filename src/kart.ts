import * as THREE from 'three';
import { P } from './config';

export interface KartInput {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
}

/**
 * 街机卡丁车模型。
 * 核心思路：
 *  1. 先把「速度向量」分解成车头方向 (vF) 和侧向 (vL)
 *  2. 侧向速度按抓地系数衰减 —— 抓地强 = 立刻回正，抓地弱 = 侧滑（漂移）
 *  3. 车头朝向的旋转速度可以大于速度方向的旋转速度，差值就是「滑移角」
 *  4. 滑移角在最佳区间内累积气量；松开漂移把气量换成短暂加速
 */
export class Kart {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();

  heading = 0; // 车头朝向，forward = (sin h, 0, cos h)
  yawRate = 0;

  charge = 0; // 0..1
  drifting = false;
  driftDir = 1;

  boostTimer = 0;
  chainTimer = 0;
  boostFlash = 0; // 0..1 仅用于视觉

  slipAngle = 0; // 弧度
  speedKmh = 0;
  wallHit = 0;

  // ---------- 垂直方向 ----------
  velY = 0;
  grounded = true;
  airTime = 0;
  landImpact = 0; // 0..1 落地冲击，仅用于视觉
  groundSlope = 0; // 车头方向的地面坡度 dh/ds（贴地时有效）
  groundSampler: ((x: number, z: number) => number) | null = null;

  private readonly tmpF = new THREE.Vector3();
  private readonly tmpR = new THREE.Vector3();

  forward(out: THREE.Vector3 = this.tmpF): THREE.Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  right(out: THREE.Vector3 = this.tmpR): THREE.Vector3 {
    return out.set(-Math.cos(this.heading), 0, Math.sin(this.heading));
  }

  reset(pos: THREE.Vector3, heading: number): void {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.heading = heading;
    this.yawRate = 0;
    this.charge = 0;
    this.drifting = false;
    this.driftDir = 1;
    this.boostTimer = 0;
    this.chainTimer = 0;
    this.boostFlash = 0;
    this.slipAngle = 0;
    this.speedKmh = 0;
    this.wallHit = 0;
    this.velY = 0;
    this.grounded = true;
    this.airTime = 0;
    this.landImpact = 0;
  }

  private startBoost(charge: number): void {
    const c = Math.min(1, Math.max(0, charge));
    const dur = P.boostBaseTime + P.boostTimePerCharge * c;
    this.boostTimer = Math.max(this.boostTimer, dur);
    this.boostFlash = 1;

    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const imp = P.boostImpulse * (0.4 + 0.6 * c);
    this.vel.x += fx * imp;
    this.vel.z += fz * imp;
  }

  /**
   * 外部加速（加速带 / 道具）。和漂移集气的小喷共用 boostTimer，
   * 但给一个固定时长 + 可选前向冲量。
   */
  applyBoost(duration: number, impulse = 0): void {
    this.boostTimer = Math.max(this.boostTimer, duration);
    this.boostFlash = 1;
    if (impulse > 0) {
      this.vel.x += Math.sin(this.heading) * impulse;
      this.vel.z += Math.cos(this.heading) * impulse;
    }
  }

  step(dt: number, input: KartInput): void {
    const speed = this.vel.length();

    this.boostTimer = Math.max(0, this.boostTimer - dt);
    this.chainTimer = Math.max(0, this.chainTimer - dt);
    this.boostFlash = Math.max(0, this.boostFlash - dt * 5.5);
    this.wallHit = Math.max(0, this.wallHit - dt * 3);
    this.landImpact = Math.max(0, this.landImpact - dt * 2.5);

    // ---------------- 漂移状态机 ----------------
    const canDrift =
      this.grounded && speed > P.driftMinSpeed && Math.abs(input.steer) > 0.25;

    if (this.drifting) {
      if (!input.drift || speed < P.driftMinSpeed * 0.55) {
        this.drifting = false;
        if (this.charge >= P.chargeMinToBoost) {
          this.startBoost(this.charge);
          this.chainTimer = P.chainWindow;
          this.charge = Math.min(P.chargeMax, this.charge * P.chainCarry);
        } else {
          this.charge *= 0.6;
        }
      }
    } else if (input.drift && canDrift) {
      this.drifting = true;
      this.driftDir = Math.sign(input.steer) || 1;
      this.yawRate += this.driftDir * P.driftEntryKick;
      if (this.chainTimer <= 0) this.charge = 0;
    }

    // ---------------- 转向 ----------------
    const speedFactor = Math.min(1, speed / P.steerMinSpeed);
    let maxYaw: number;
    if (this.drifting) {
      // 漂移是独立的高转速通道：转速高、衰减慢，所以能拐抓地拐不过的急弯。
      // 玩家按住越久转得越多，按多了就会转过头 —— 时长由玩家自己控。
      maxYaw = (P.driftMaxYaw * speedFactor) / (1 + speed / P.driftSpeedFalloff);
    } else {
      maxYaw = (P.steerMaxYaw * speedFactor) / (1 + speed / P.steerSpeedFalloff);
    }
    // 腾空时只能小幅调整姿态
    if (!this.grounded) maxYaw *= P.airControl;

    const targetYaw = input.steer * maxYaw;
    const resp = this.drifting ? P.steerResponseDrift : P.steerResponse;
    this.yawRate += (targetYaw - this.yawRate) * (1 - Math.exp(-resp * dt));

    const yawLimit = maxYaw * 1.35 + 0.6;
    if (this.yawRate > yawLimit) this.yawRate = yawLimit;
    else if (this.yawRate < -yawLimit) this.yawRate = -yawLimit;

    this.heading += this.yawRate * dt;

    // ---------------- 车体坐标分解（朝向已更新） ----------------
    const f = this.forward();
    const r = this.right();
    let vF = this.vel.dot(f);
    let vL = this.vel.dot(r);

    const grip = !this.grounded
      ? 0
      : this.drifting
        ? P.gripDrift
        : P.gripNormal;

    if (vF > 0.5) {
      // 抓地 = 把「速度方向」朝车头方向收敛：只改方向，不改速率。
      // 收敛越慢，滑移角越大，看起来越像在漂移。
      let spd = Math.hypot(vF, vL);
      let beta = Math.atan2(vL, vF);
      beta *= Math.exp(-grip * dt);
      this.slipAngle = Math.abs(beta);

      // 侧滑掉速：滑移角越大，掉速越狠
      const drag = !this.grounded ? 0 : this.drifting ? P.driftDrag : P.cornerDrag;
      spd = Math.max(0, spd - drag * Math.abs(Math.sin(beta)) * dt);

      vF = Math.cos(beta) * spd;
      vL = Math.sin(beta) * spd;
    } else {
      // 倒车 / 静止时不做方向收敛，只做普通侧向衰减
      vL *= Math.exp(-grip * dt);
      this.slipAngle = Math.atan2(Math.abs(vL), Math.abs(vF) + 0.001);
    }

    // ---------------- 动力 ----------------
    const maxSpd = this.boostTimer > 0 ? P.boostMaxSpeed : P.maxSpeed;

    if (input.throttle > 0) {
      const ratio = Math.min(1, Math.max(0, vF / maxSpd));
      const throttleMult = !this.grounded ? 0 : this.drifting ? P.driftThrottle : 1;
      vF += P.accel * input.throttle * throttleMult * (1 - ratio * ratio) * dt;
    }

    if (input.brake > 0 && this.grounded) {
      if (vF > 0.6) vF -= P.brakeAccel * input.brake * dt;
      else vF = Math.max(-P.reverseMaxSpeed, vF - P.accel * 0.5 * input.brake * dt);
    }

    // ---------------- 坡度 ----------------
    // 上坡掉速、下坡加速
    if (this.grounded) {
      vF -= P.gravity * this.groundSlope * P.slopeDrag * dt;
    }

    if (this.boostTimer > 0) vF += P.boostAccel * (this.grounded ? 1 : 0.5) * dt;

    if (input.throttle <= 0 && input.brake <= 0 && this.grounded) {
      const d = P.coastDrag * dt;
      vF -= Math.sign(vF) * Math.min(Math.abs(vF), d);
    }

    if (vF > maxSpd) vF -= (vF - maxSpd) * P.overspeedDrag * dt;

    this.vel.copy(f).multiplyScalar(vF).addScaledVector(r, vL);

    // ---------------- 集气 ----------------
    // 腾空时不集气（否则按住漂移飞过跳台就能白嫖一管气）
    if (this.drifting && this.grounded && speed > P.chargeMinSpeed) {
      const slipDeg = (this.slipAngle * 180) / Math.PI;
      const ratio = slipDeg / P.chargeOptimalSlipDeg;
      const eff =
        ratio <= 1
          ? Math.sin(ratio * Math.PI * 0.5)
          : Math.max(0.12, 1 - (ratio - 1) * P.chargeSlipFalloff);
      this.charge = Math.min(P.chargeMax, this.charge + P.chargeRate * eff * dt);
    }

    // ---------------- 积分 ----------------
    this.pos.addScaledVector(this.vel, dt);
    this.updateVertical(dt);
    this.speedKmh = this.vel.length() * 3.6;
  }

  /** 车头方向上的地面坡度（dh/ds，正 = 上坡） */
  private slopeUnder(): number {
    if (!this.groundSampler) return 0;
    const fx = Math.sin(this.heading);
    const fz = Math.cos(this.heading);
    const d = 1.5;
    const ahead = this.groundSampler(this.pos.x + fx * d, this.pos.z + fz * d);
    const behind = this.groundSampler(this.pos.x - fx * d, this.pos.z - fz * d);
    return (ahead - behind) / (d * 2);
  }

  /**
   * 垂直方向：统一用抛体积分。
   *
   * 每一步先把车当抛体走一步，再看它有没有穿到地面以下：
   *  - 穿下去了 → 贴地，垂直速度改成地面沿行进方向的爬升速度
   *  - 没穿下去 → 腾空，继续自由落体
   *
   * 这样上坡时地面顶着车（贴地），越过唇口时地面下坠得比自由落体还快，
   * 车自然带着上坡时积累的垂直速度飞出去 —— 不需要单独判断"起跳"。
   */
  private updateVertical(dt: number): void {
    const sample = this.groundSampler;
    if (!sample) {
      this.pos.y = 0;
      this.velY = 0;
      this.grounded = true;
      return;
    }

    const yPrev = this.pos.y;
    const wasGrounded = this.grounded;

    this.velY -= P.gravity * dt;
    this.pos.y += this.velY * dt;

    const ground = sample(this.pos.x, this.pos.z);

    // 容差 = 一步之内自由落体自己下坠的量，避免高速下坡被误判成腾空。
    // 不要为了消掉坡面上 1~2 帧的微小抖动而放大这个容差：车正是靠「这一帧
    // 自己升得比地面快」离地的，容差一大就会把起跳速度吃掉，跳台直接变矮。
    const tolerance = 0.5 * P.gravity * dt * dt + 0.002;

    if (this.pos.y - ground <= tolerance) {
      // ---------------- 贴地 ----------------
      if (!wasGrounded) {
        const impact = -this.velY;
        if (impact > P.landHard) {
          this.landImpact = Math.min(1, impact / 22);
          this.vel.multiplyScalar(0.97);
        }
        // 落地后接着沿坡度走，不要瞬间把垂直速度清零（下坡会一顿一顿的）
        this.velY = this.slopeUnder() * Math.hypot(this.vel.x, this.vel.z);
      } else {
        // 跟随地面的垂直速度；位置被外部改过（传送/复位）时直接吸附，不要靠这个速度把自己弹飞
        // 路面接缝 / 最近路切换会造成单帧高度台阶。台阶不能当坡度，
        // 否则 rise/dt 会变成几十 m/s 的垂直速度，把车直接弹上天。
        // 阈值要高于跳台唇口的正常爬升速度（23% 坡 × 58 m/s ≈ 13.3 m/s），
        // 否则会把跳台也一起削平。
        const rise = ground - yPrev;
        const follow = rise / dt;
        this.velY = Math.abs(follow) > 18 ? 0 : Math.max(-40, Math.min(40, follow));
      }
      this.pos.y = ground;
      this.grounded = true;
      this.airTime = 0;
      this.groundSlope = this.slopeUnder();
    } else {
      // ---------------- 腾空 ----------------
      this.grounded = false;
      this.airTime += dt;
    }
  }
}
