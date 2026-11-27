import * as THREE from 'three';

export interface KartPalette {
  /** 车身主色 */
  body: number;
  /** 侧箱 / 尾翼 / 车手服 */
  accent: number;
  /** 头盔 */
  helmet: number;
}

export interface KartVisual {
  group: THREE.Group;
  update(dt: number, speed: number, steer: number, drifting: boolean, boost?: number): void;
  dispose(): void;
}

interface Wheel {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  front: boolean;
}

const WHEEL_R = 0.34;

export function createKartVisual(palette: Partial<KartPalette> = {}): KartVisual {
  const root = new THREE.Group();

  // 车身倾斜容器（只绕自身 Z 轴滚转，不影响朝向）
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const bodyMat = new THREE.MeshStandardMaterial({
    color: palette.body ?? 0xe63946,
    roughness: 0.42,
    metalness: 0.18,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: palette.accent ?? 0xf5f6f8,
    roughness: 0.5,
    metalness: 0.05,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x24272c, roughness: 0.72, metalness: 0.25 });
  const tireMat = new THREE.MeshStandardMaterial({ color: 0x141619, roughness: 0.95, metalness: 0.0 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xd7dbe1, roughness: 0.28, metalness: 0.85 });
  const helmetMat = new THREE.MeshStandardMaterial({
    color: palette.helmet ?? 0x37d3ff,
    roughness: 0.25,
    metalness: 0.15,
  });

  const add = (mesh: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    bodyGroup.add(mesh);
    return mesh;
  };

  // 底盘
  add(new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 2.5), bodyMat), 0, 0.5, 0);

  // 前鼻锥（略窄、略低）
  const nose = add(new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.3, 0.9), bodyMat), 0, 0.46, 1.35);
  nose.rotation.x = -0.06;

  // 前保险杠
  add(new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.22, 0.28), accentMat), 0, 0.42, 1.72);

  // 侧箱
  add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 1.5), accentMat), -0.85, 0.5, -0.1);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.34, 1.5), accentMat), 0.85, 0.5, -0.1);

  // 驾驶舱
  add(new THREE.Mesh(new THREE.BoxGeometry(0.92, 0.36, 1.0), darkMat), 0, 0.83, -0.05);

  // 座椅靠背
  const seat = add(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.5, 0.16), darkMat), 0, 0.95, -0.62);
  seat.rotation.x = 0.22;

  // 车手：躯干 + 头
  add(new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.28, 6, 12), accentMat), 0, 1.06, -0.18);
  const head = add(new THREE.Mesh(new THREE.SphereGeometry(0.2, 18, 14), helmetMat), 0, 1.34, -0.12);
  head.scale.set(1, 0.95, 1.08);

  // 尾翼
  add(new THREE.Mesh(new THREE.BoxGeometry(1.62, 0.08, 0.36), accentMat), 0, 1.04, -1.24);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.3), darkMat), -0.66, 0.87, -1.22);
  add(new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.34, 0.3), darkMat), 0.66, 0.87, -1.22);

  // 排气
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 10), darkMat), -0.34, 0.62, -1.3)
    .rotation.x = Math.PI / 2;
  add(new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.28, 10), darkMat), 0.34, 0.62, -1.3)
    .rotation.x = Math.PI / 2;

  // ---------------- 冲刺尾焰 ----------------
  // 锥体：底面贴在排气管上，尖朝车后（-Z）
  const flameGeo = new THREE.ConeGeometry(0.2, 1.3, 12, 1, true);
  flameGeo.translate(0, 0.65, 0);
  flameGeo.rotateX(-Math.PI / 2);

  // 沿锥体高度方向的渐隐贴图，让它像喷流而不是一个三角片
  const flameCanvas = document.createElement('canvas');
  flameCanvas.width = 16;
  flameCanvas.height = 128;
  const fctx = flameCanvas.getContext('2d');
  if (fctx) {
    const g = fctx.createLinearGradient(0, 0, 0, 128);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.45)');
    g.addColorStop(0.85, 'rgba(255,255,255,0.95)');
    g.addColorStop(1, 'rgba(255,255,255,1)');
    fctx.fillStyle = g;
    fctx.fillRect(0, 0, 16, 128);
  }
  const flameTex = new THREE.CanvasTexture(flameCanvas);
  flameTex.colorSpace = THREE.SRGBColorSpace;

  const flameOuterMat = new THREE.MeshBasicMaterial({
    color: 0xff6a18,
    map: flameTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flameInnerMat = new THREE.MeshBasicMaterial({
    color: 0xffc061,
    map: flameTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const flames: Array<{ outer: THREE.Mesh; inner: THREE.Mesh }> = [];
  for (const x of [-0.34, 0.34]) {
    const outer = new THREE.Mesh(flameGeo, flameOuterMat);
    outer.position.set(x, 0.62, -1.42);
    outer.renderOrder = 3;
    outer.visible = false;
    bodyGroup.add(outer);

    const inner = new THREE.Mesh(flameGeo, flameInnerMat);
    inner.position.z = 0.02;
    inner.scale.set(0.52, 0.52, 0.55);
    inner.renderOrder = 4;
    outer.add(inner);

    flames.push({ outer, inner });
  }

  const flameLight = new THREE.PointLight(0xff8a3d, 0, 9, 2);
  flameLight.position.set(0, 0.7, -1.6);
  bodyGroup.add(flameLight);

  // ---------------- 轮子 ----------------
  const wheelGeo = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.3, 18);
  wheelGeo.rotateZ(Math.PI / 2);
  const rimGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.32, 10);
  rimGeo.rotateZ(Math.PI / 2);

  const wheels: Wheel[] = [];
  const layout: Array<[number, number, boolean]> = [
    [-0.82, 0.86, true],
    [0.82, 0.86, true],
    [-0.84, -0.9, false],
    [0.84, -0.9, false],
  ];

  for (const [x, z, front] of layout) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_R, z);

    const mesh = new THREE.Mesh(wheelGeo, tireMat);
    mesh.castShadow = true;
    const rim = new THREE.Mesh(rimGeo, rimMat);
    mesh.add(rim);

    pivot.add(mesh);
    bodyGroup.add(pivot);
    wheels.push({ pivot, mesh, front });
  }

  let roll = 0;
  let lean = 0;
  let clock = 0;
  let flameLevel = 0;

  const api: KartVisual = {
    group: root,
    update(dt: number, speed: number, steer: number, drifting: boolean, boost = 0): void {
      roll += (speed / WHEEL_R) * dt;
      const steerAngle = steer * 0.42;
      for (const w of wheels) {
        w.mesh.rotation.x = roll;
        if (w.front) w.pivot.rotation.y = steerAngle;
      }

      const targetLean = drifting ? -steer * 0.07 : -steer * 0.02;
      lean += (targetLean - lean) * (1 - Math.exp(-10 * dt));
      bodyGroup.rotation.z = lean;
      bodyGroup.position.y = drifting ? -0.015 : 0;

      // ---------------- 尾焰 ----------------
      clock += dt;
      flameLevel += (boost - flameLevel) * (1 - Math.exp(-(boost > flameLevel ? 24 : 8) * dt));
      const lv = flameLevel;
      const flicker = 0.82 + 0.18 * Math.sin(clock * 53) * Math.sin(clock * 29 + 1.1);
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i]!;
        const on = lv > 0.02;
        f.outer.visible = on;
        if (!on) continue;
        const phase = i * 1.7;
        const wob = Math.sin(clock * 41 + phase) * 0.09;
        const len = (0.55 + lv * 1.05) * flicker;
        f.outer.scale.set(0.95 + lv * 0.55 + wob, 0.95 + lv * 0.55 - wob, len);
        f.outer.rotation.z = Math.sin(clock * 37 + phase) * 0.05;
        f.inner.scale.set(0.42, 0.42, 0.4 + lv * 0.3);
      }
      flameOuterMat.opacity = lv * 0.55 * flicker;
      flameInnerMat.opacity = lv * 0.6 * flicker;
      flameLight.intensity = lv * 18 * flicker;
    },
    dispose(): void {
      wheelGeo.dispose();
      rimGeo.dispose();
      flameGeo.dispose();
      bodyMat.dispose();
      accentMat.dispose();
      darkMat.dispose();
      tireMat.dispose();
      rimMat.dispose();
      helmetMat.dispose();
      flameOuterMat.dispose();
      flameInnerMat.dispose();
      flameTex.dispose();
    },
  };

  return api;
}
