import * as THREE from 'three';
import { P } from './config';

export interface CameraTarget {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  boostTimer: number;
  yawRate: number;
  forward(out?: THREE.Vector3): THREE.Vector3;
}

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  private readonly pos = new THREE.Vector3();
  private readonly wantPos = new THREE.Vector3();
  private readonly wantLook = new THREE.Vector3();
  private readonly f = new THREE.Vector3();
  private ready = false;
  private shake = 0;
  private clock = 0;
  /** 竖屏时把镜头拉远一点，否则车会占掉半个屏幕 */
  private aspectScale = 1;

  /** 用来防止镜头钻进地面 */
  groundAt: ((x: number, z: number) => number) | null = null;

  /** 0..1 镜头震动强度（冲刺 / 撞墙） */
  setShake(amount: number): void {
    this.shake = Math.min(1.5, Math.max(0, amount));
  }

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(P.camFovBase, aspect, 0.1, 3000);
    this.resize(aspect);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    // 0.46（手机竖屏）→ 1.30 倍距离；横屏 / 桌面保持 1
    this.aspectScale = aspect < 1 ? 1 + (1 - aspect) * 0.55 : 1;
  }

  private compute(t: CameraTarget): void {
    const f = t.forward(this.f);
    const dist = P.camDist * this.aspectScale;
    const height = P.camHeight * this.aspectScale;
    this.wantPos.set(
      t.pos.x - f.x * dist,
      t.pos.y + height,
      t.pos.z - f.z * dist,
    );
    this.wantLook.set(
      t.pos.x + f.x * P.camLookAhead,
      t.pos.y + 1.2,
      t.pos.z + f.z * P.camLookAhead,
    );
  }

  snap(t: CameraTarget): void {
    this.compute(t);
    this.pos.copy(this.wantPos);
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.wantLook);
    this.ready = true;
  }

  update(dt: number, t: CameraTarget): void {
    if (!this.ready) {
      this.snap(t);
      return;
    }

    this.compute(t);

    const k = 1 - Math.exp(-P.camStiffness * dt);
    this.pos.lerp(this.wantPos, k);
    if (this.pos.y < 1.4) this.pos.y = 1.4;
    // 上坡时镜头别钻进路面
    if (this.groundAt) {
      const floor = this.groundAt(this.pos.x, this.pos.z) + 1.3;
      if (this.pos.y < floor) this.pos.y = floor;
    }

    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.wantLook);

    // 轻微滚转，让漂移更有重量感
    this.camera.rotateZ(-t.yawRate * P.camRoll);

    // 视场角：速度 + 加速
    const speedRatio = Math.min(1, t.vel.length() / P.maxSpeed);
    let fov = P.camFovBase + P.camFovSpeed * speedRatio;
    if (t.boostTimer > 0) fov += P.camFovBoost;

    const kf = 1 - Math.exp(-6 * dt);
    this.camera.fov += (fov - this.camera.fov) * kf;
    this.camera.updateProjectionMatrix();

    // ---------------- 震动 ----------------
    this.clock += dt;
    if (this.shake > 0.001) {
      const s = this.shake * P.camShake;
      const c = this.clock;
      const nx = Math.sin(c * 41.3) * 0.6 + Math.sin(c * 87.7 + 1.3) * 0.4;
      const ny = Math.sin(c * 37.1 + 2.1) * 0.6 + Math.sin(c * 79.9 + 0.4) * 0.4;
      this.camera.position.x += nx * s * 0.11;
      this.camera.position.y += ny * s * 0.09;
      this.camera.rotateZ(nx * s * 0.014);
    }
  }
}
