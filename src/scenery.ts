import * as THREE from 'three';
import type { Track } from './track';
import type { TrackTheme } from './trackDefs';

export interface Scenery {
  group: THREE.Group;
  sun: THREE.DirectionalLight;
  update(kartPos: THREE.Vector3): void;
  dispose(): void;
}

const SUN_OFFSET = new THREE.Vector3(90, 140, 70);

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function random(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cx: number;
  cz: number;
  radius: number;
}

function trackBounds(track: Track): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const scan = (points: ReadonlyArray<{ x: number; z: number }>): void => {
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
  };
  scan(track.layout.main.points);
  for (const b of track.layout.branches) scan(b.points);
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const radius = Math.max(maxX - minX, maxZ - minZ) * 0.5;
  return { minX, maxX, minZ, maxZ, cx, cz, radius };
}

/**
 * 用 HSL 生成基色的明暗 / 色相变体，避免程序化纹理的颜色死板。
 * lightness 是明度倍率（1 = 原色），hueShift 是色相偏移，satScale 是饱和度倍率。
 */
function tint(hex: number, lightness: number, hueShift = 0, satScale = 1): string {
  const color = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl, THREE.SRGBColorSpace);
  color.setHSL(
    hsl.h + hueShift,
    THREE.MathUtils.clamp(hsl.s * satScale, 0, 1),
    THREE.MathUtils.clamp(hsl.l * lightness, 0, 1),
    THREE.SRGBColorSpace,
  );
  return `#${color.getHexString(THREE.SRGBColorSpace)}`;
}

/** 同 tint，但直接产出带 alpha 的 rgba()，供 Canvas 渐变使用。 */
function tintAlpha(
  hex: number,
  lightness: number,
  hueShift: number,
  satScale: number,
  alpha: number,
): string {
  const css = tint(hex, lightness, hueShift, satScale);
  const r = parseInt(css.slice(1, 3), 16);
  const g = parseInt(css.slice(3, 5), 16);
  const b = parseInt(css.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 程序化地面贴图：底色 + 大块柔光色斑 + 土块碎石 + 细噪点。
 * 平铺后赛道外不再是一张纯色纸；固定种子保证每次加载完全一致。
 */
function groundTexture(theme: TrackTheme): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(theme.scenery === 'forest' ? 0x51f0e57 : 0x51f0e58);

  if (ctx) {
    ctx.fillStyle = tint(theme.groundColor, 1);
    ctx.fillRect(0, 0, size, size);

    // 无缝平铺：元素跨边界时在对侧补画，避免 repeat 后出现网格接缝。
    const wrap = (x: number, y: number, r: number, draw: (px: number, py: number) => void): void => {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox * size;
        if (px + r < 0 || px - r > size) continue;
        for (let oy = -1; oy <= 1; oy++) {
          const py = y + oy * size;
          if (py + r < 0 || py - r > size) continue;
          draw(px, py);
        }
      }
    };

    // 大块柔光色斑：模拟草皮 / 沙地的深浅起伏。
    for (let i = 0; i < 200; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const r = 40 + rand() * 140;
      const l = 0.82 + rand() * 0.42;
      const hue = (rand() - 0.5) * 0.02;
      wrap(x, y, r, (px, py) => {
        const gradient = ctx.createRadialGradient(px, py, 0, px, py, r);
        gradient.addColorStop(0, tintAlpha(theme.groundColor, l, hue, 1, 1));
        gradient.addColorStop(0.6, tintAlpha(theme.groundColor, l, hue, 1, 0.4));
        gradient.addColorStop(1, tintAlpha(theme.groundColor, l, hue, 1, 0));
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      });
    }
    ctx.globalAlpha = 1;

    // 中等颗粒：土块 / 碎石，椭圆 + 明暗抖动。
    for (let i = 0; i < 4000; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const rx = 1 + rand() * 6;
      const ry = rx * (0.55 + rand() * 0.7);
      const rot = rand() * Math.PI;
      const l = 0.72 + rand() * 0.6;
      const alpha = 0.1 + rand() * 0.18;
      const css = tintAlpha(theme.groundColor, l, (rand() - 0.5) * 0.03, 0.9, alpha);
      wrap(x, y, Math.max(rx, ry), (px, py) => {
        ctx.fillStyle = css;
        ctx.beginPath();
        ctx.ellipse(px, py, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 1px 细噪点：打散平铺后的规则感。
    for (let i = 0; i < 20000; i++) {
      const x = rand() * size;
      const y = rand() * size;
      const l = 0.7 + rand() * 0.7;
      const css = tintAlpha(theme.groundColor, l, 0, 1, 0.02 + rand() * 0.08);
      wrap(x, y, 1, (px, py) => {
        ctx.fillStyle = css;
        ctx.fillRect(px, py, 1, 1);
      });
    }

    if (theme.scenery === 'forest') {
      // 短草笔画：略偏黄绿，让草地有纤维感。
      for (let i = 0; i < 900; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const len = 2 + rand() * 3;
        const ang = rand() * Math.PI * 2;
        const css = tintAlpha(theme.groundColor, 1.05 + rand() * 0.25, -0.045, 1.15, 0.15);
        wrap(x, y, len, (px, py) => {
          ctx.strokeStyle = css;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py);
          ctx.lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
          ctx.stroke();
        });
      }
    } else {
      // 横向风蚀细纹：模拟沙地上被风吹出的流线。
      for (let i = 0; i < 500; i++) {
        const x = rand() * size;
        const y = rand() * size;
        const w = 20 + rand() * 70;
        const h = 1 + rand();
        const l = 0.85 + rand() * 0.35;
        const css = tintAlpha(theme.groundColor, l, 0, 0.85, 0.08);
        wrap(x, y, w, (px, py) => {
          ctx.fillStyle = css;
          ctx.fillRect(px - w * 0.5, py, w, h);
        });
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(96, 96);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 针叶树剪影：LatheGeometry 沿 y 分层外扩再收窄，形成 2~4 层叠檐。
 * Lathe 要求 x >= 0 且 y 单调递增，所以每层只取「窄 → 宽 → 窄」三个点。
 */
function firGeometry(tiers: number, radius: number, height: number, segments: number): THREE.LatheGeometry {
  const points: THREE.Vector2[] = [new THREE.Vector2(0.001, 0)];
  const tierHeight = height / tiers;
  for (let k = 0; k < tiers; k++) {
    // 越往上层叠半径越小，整体保持锥形轮廓。
    const taper = tiers > 1 ? 1 - 0.5 * (k / (tiers - 1)) : 1;
    const r = radius * taper;
    const y0 = k * tierHeight;
    points.push(new THREE.Vector2(r * 0.22, y0));
    points.push(new THREE.Vector2(r, y0 + tierHeight * 0.3));
    points.push(new THREE.Vector2(r * 0.2, y0 + tierHeight * 0.92));
  }
  points.push(new THREE.Vector2(0.001, height));
  return new THREE.LatheGeometry(points, segments);
}

/** 仙人掌柱体：在圆柱侧面按角度叠加余弦棱纹，做出纵向肉质感。 */
function cactusGeometry(): THREE.CylinderGeometry {
  const geometry = new THREE.CylinderGeometry(0.46, 0.66, 5.2, 9, 3);
  const pos = geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if (r < 1e-4) continue; // 顶 / 底圆心不参与棱纹
    const angle = Math.atan2(z, x);
    const k = 1 + 0.09 * Math.cos(angle * 9);
    pos.setX(i, Math.cos(angle) * r * k);
    pos.setZ(i, Math.sin(angle) * r * k);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export function createScenery(scene: THREE.Scene, track: Track): Scenery {
  const group = new THREE.Group();
  group.name = 'scenery';
  const theme: TrackTheme = track.theme;
  const bounds = trackBounds(track);
  const disposables: Array<{ dispose(): void }> = [];

  // ---------------------------------------------------------------------------
  // Sky dome
  // ---------------------------------------------------------------------------
  const skyGeometry = new THREE.SphereGeometry(2200, 96, 64);
  const sunDirection = SUN_OFFSET.clone().normalize();
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizonColor: { value: new THREE.Color(theme.skyHorizon) },
      zenithColor: { value: new THREE.Color(theme.skyZenith) },
      sunColor: { value: new THREE.Color(theme.sunColor) },
      sunDirection: { value: sunDirection },
      uTime: { value: 0 },
      // 沙漠是晴空，云要少很多；森林多云
      cloudAmount: { value: theme.scenery === 'desert' ? 0.42 : 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPosition;

      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPosition;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 horizonColor;
      uniform vec3 zenithColor;
      uniform vec3 sunColor;
      uniform vec3 sunDirection;
      uniform float uTime;
      uniform float cloudAmount;
      varying vec3 vWorldPosition;

      // 便宜的 value noise + fbm，用来画云。纯程序化，不需要贴图。
      float hash21(vec2 p) {
        p = fract(p * vec2(127.31, 311.7));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }
      float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
          mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
          u.y
        );
      }
      float fbm(vec2 p) {
        float v = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
          v += a * valueNoise(p);
          p = p * 2.03 + 11.3;
          a *= 0.5;
        }
        return v;
      }

      void main() {
        vec3 dir = normalize(vWorldPosition);
        float h = dir.y;
        float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.8);
        vec3 col = mix(horizonColor, zenithColor, t);

        // 太阳：一个硬核心 + 三层衰减光晕，代替原来空荡荡的天空
        float sd = max(dot(dir, normalize(sunDirection)), 0.0);
        float disc = smoothstep(0.99955, 0.99985, sd);
        float glow = pow(sd, 1400.0) * 0.9 + pow(sd, 40.0) * 0.22 + pow(sd, 6.0) * 0.10;
        col += sunColor * (disc * 0.85 + glow);

        // 云：把方向投到一层水平面上做 fbm，越靠近地平线越稀
        float above = smoothstep(0.02, 0.34, h);
        if (above > 0.001) {
          // 用 dir.xz / (h + 常量) 而不是 /h：纯平面投影在天顶会炸成放射状条纹
          vec2 p = dir.xz / (h + 0.42) * 0.85;
          p += vec2(uTime * 0.006, uTime * 0.0025);
          float n = fbm(p * 1.15);
          // cloudAmount 越小，阈值越高 → 云越少（沙漠几乎晴空）
          float lo = mix(0.72, 0.56, cloudAmount);
          float hi = mix(0.92, 0.82, cloudAmount);
          float cover = smoothstep(lo, hi, n);
          float lit = fbm(p * 2.2 + 5.7);
          vec3 cloudCol = mix(vec3(0.82, 0.86, 0.93), vec3(1.0, 0.99, 0.97), smoothstep(0.35, 0.85, lit));
          // 太阳附近的云被照亮一点
          cloudCol += sunColor * pow(sd, 8.0) * 0.25;
          col = mix(col, cloudCol, cover * above * 0.9 * cloudAmount);
        }

        // 地平线霾：让地面和天空接得柔和，别出现一条硬边
        col = mix(col, horizonColor, smoothstep(0.09, -0.03, h) * 0.85);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = 'sky';
  sky.frustumCulled = false;
  disposables.push(skyGeometry, skyMaterial);

  scene.add(sky);
  group.add(sky);

  // ---------------------------------------------------------------------------
  // Sun (directional light)
  // ---------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(theme.sunColor, theme.sunIntensity);
  sun.name = 'sun';
  sun.position.copy(SUN_OFFSET);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera = new THREE.OrthographicCamera(-90, 90, 90, -90, 1, 450);
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.02;

  scene.add(sun);
  scene.add(sun.target);
  disposables.push(sun);

  // ---------------------------------------------------------------------------
  // Hemisphere light
  // ---------------------------------------------------------------------------
  const hemisphere = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, theme.hemiIntensity);
  hemisphere.name = 'hemisphere';
  scene.add(hemisphere);
  disposables.push(hemisphere);

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------
  const groundMap = groundTexture(theme);
  const groundGeometry = new THREE.PlaneGeometry(4200, 4200);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = new THREE.MeshStandardMaterial({
    map: groundMap,
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = 'ground';
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  scene.add(ground);
  group.add(ground);
  disposables.push(groundGeometry, groundMaterial, groundMap);

  // ---------------------------------------------------------------------------
  // Roadside props (instanced)
  // ---------------------------------------------------------------------------
  const random = mulberry32(theme.scenery === 'desert' ? 20261128 : 20261126);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const upAxis = new THREE.Vector3(0, 1, 0);
  const candidate = new THREE.Vector3();

  const placeCount = theme.treeCount;
  const spots: Array<{ x: number; z: number; s: number; r: number }> = [];
  for (let i = 0; i < placeCount; i++) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const x = bounds.minX - 180 + random() * (bounds.maxX - bounds.minX + 360);
      const z = bounds.minZ - 180 + random() * (bounds.maxZ - bounds.minZ + 360);
      if (
        track.distanceToCenterline(x, z) > track.halfWidth + 13 &&
        track.distanceToTunnel(x, z) > 34
      ) {
        spots.push({
          x,
          z,
          s: 0.65 + random() * 0.9,
          r: random() * Math.PI * 2,
        });
        break;
      }
    }
  }

  if (theme.scenery === 'forest') {
    // 树干统一一根，树冠分 3 种剪影，避免整片森林一模一样。
    const trunkGeometry = new THREE.CylinderGeometry(0.26, 0.55, 3.4, 6);
    const trunkMaterial = new THREE.MeshStandardMaterial({
      // 用 instanceColor 上色时材质必须是白色，否则会和实例色二次相乘变暗。
      color: 0xffffff,
      roughness: 0.95,
      metalness: 0,
    });
    const canopyGeometries = [
      firGeometry(3, 2.7, 7.2, 9),
      firGeometry(4, 2.2, 8.8, 8),
      firGeometry(2, 3.4, 6.2, 10),
    ];
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });

    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, Math.max(1, spots.length));
    trunks.name = 'tree-trunks';
    trunks.castShadow = true;
    trunks.receiveShadow = true;

    // 按 i % 3 分成 3 组，每组一个 InstancedMesh（共 3 个树冠 mesh）。
    const canopies = canopyGeometries.map((geometry, variant) => {
      let count = 0;
      for (let i = 0; i < spots.length; i++) if (i % 3 === variant) count++;
      const mesh = new THREE.InstancedMesh(geometry, canopyMaterial, Math.max(1, count));
      mesh.name = `tree-canopies-${variant}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      return mesh;
    });
    const canopyCursor = [0, 0, 0];
    const color = new THREE.Color();

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      // 尺寸抖动：高度比宽度抖得更狠，树群才不会像复制粘贴。
      const w = 0.85 + random() * 0.3;
      const h = 0.85 + random() * 0.4;
      quaternion.setFromAxisAngle(upAxis, s.r);

      scale.set(s.s, s.s, s.s);
      position.set(s.x, 1.7 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      trunks.setMatrixAt(i, matrix);
      trunks.setColorAt(i, color.set(theme.trunkColor).offsetHSL(0, 0, (random() - 0.5) * 0.1));

      const variant = i % 3;
      const canopy = canopies[variant]!;
      const slot = canopyCursor[variant]!;
      canopyCursor[variant] = slot + 1;
      scale.set(s.s * w, s.s * h, s.s * w);
      // 树冠底部压到 2.4 * s，正好盖住树干顶端。
      position.set(s.x, 2.4 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      canopy.setMatrixAt(slot, matrix);
      canopy.setColorAt(
        slot,
        color.set(theme.canopyColor).offsetHSL((random() - 0.5) * 0.03, 0, (random() - 0.5) * 0.12),
      );
    }

    trunks.count = spots.length;
    trunks.instanceMatrix.needsUpdate = true;
    if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true;
    for (let v = 0; v < canopies.length; v++) {
      const canopy = canopies[v]!;
      canopy.count = canopyCursor[v]!;
      canopy.instanceMatrix.needsUpdate = true;
      if (canopy.instanceColor) canopy.instanceColor.needsUpdate = true;
    }

    scene.add(trunks, ...canopies);
    group.add(trunks, ...canopies);
    disposables.push(
      trunkGeometry,
      trunkMaterial,
      canopyMaterial,
      ...canopyGeometries,
      trunks,
      ...canopies,
    );
  } else {
    // 沙漠：仙人掌（棱纹柱身 + 圆顶 + 随机手臂）+ 巨石。
    const bodyGeometry = cactusGeometry();
    const topGeometry = new THREE.SphereGeometry(0.5, 8, 5);
    topGeometry.scale(1, 0.7, 1); // 压扁成圆顶
    const bodyMaterial = new THREE.MeshStandardMaterial({
      // instanceColor 上色，材质保持白色。
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });
    const topMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });

    const cacti = new THREE.InstancedMesh(bodyGeometry, bodyMaterial, Math.max(1, spots.length));
    const tops = new THREE.InstancedMesh(topGeometry, topMaterial, Math.max(1, spots.length));
    cacti.name = 'cacti';
    tops.name = 'cactus-tops';
    cacti.castShadow = true;
    tops.castShadow = true;
    cacti.receiveShadow = true;
    tops.receiveShadow = true;

    // 先收集手臂矩阵，再按精确数量建 InstancedMesh，避免留下空实例。
    const armMatrices: THREE.Matrix4[] = [];
    const armColors: THREE.Color[] = [];
    const color = new THREE.Color();
    const armEuler = new THREE.Euler();

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      quaternion.setFromAxisAngle(upAxis, s.r);
      scale.set(s.s, s.s, s.s);

      position.set(s.x, 2.6 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      cacti.setMatrixAt(i, matrix);
      cacti.setColorAt(i, color.set(theme.trunkColor).offsetHSL(0, 0, (random() - 0.5) * 0.16));

      position.set(s.x, 5.2 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      tops.setMatrixAt(i, matrix);
      tops.setColorAt(i, color.set(theme.canopyColor).offsetHSL(0, 0, (random() - 0.5) * 0.16));

      // 约 55% 的仙人掌长一根手臂：绕 z 倾斜 55°~70°，再绕 y 随机转向。
      if (random() < 0.55) {
        const yaw = random() * Math.PI * 2;
        const tilt = THREE.MathUtils.degToRad(55 + random() * 15);
        armEuler.set(0, yaw, tilt, 'YXZ');
        quaternion.setFromEuler(armEuler);
        const dx = -Math.sin(tilt) * Math.cos(yaw);
        const dy = Math.cos(tilt);
        const dz = Math.sin(tilt) * Math.sin(yaw);
        position.set(
          s.x + dx * 0.55 * s.s,
          (2.9 + dy * 0.55) * s.s,
          s.z + dz * 0.55 * s.s,
        );
        scale.set(s.s, s.s, s.s);
        const armMatrix = new THREE.Matrix4();
        armMatrix.compose(position, quaternion, scale);
        armMatrices.push(armMatrix);
        // 手臂和柱身同色系，但整体略亮一点。
        armColors.push(color.set(theme.trunkColor).offsetHSL(0, 0, 0.05 + (random() - 0.5) * 0.16));
      }
    }

    const armGeometry = new THREE.CylinderGeometry(0.15, 0.19, 1.5, 6);
    const armMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });
    const arms = new THREE.InstancedMesh(armGeometry, armMaterial, Math.max(1, armMatrices.length));
    arms.name = 'cactus-arms';
    arms.castShadow = true;
    arms.receiveShadow = true;
    for (let i = 0; i < armMatrices.length; i++) {
      arms.setMatrixAt(i, armMatrices[i]!);
      arms.setColorAt(i, armColors[i]!);
    }
    arms.count = armMatrices.length;
    arms.instanceMatrix.needsUpdate = true;
    if (arms.instanceColor) arms.instanceColor.needsUpdate = true;

    cacti.count = spots.length;
    tops.count = spots.length;
    cacti.instanceMatrix.needsUpdate = true;
    tops.instanceMatrix.needsUpdate = true;
    if (cacti.instanceColor) cacti.instanceColor.needsUpdate = true;
    if (tops.instanceColor) tops.instanceColor.needsUpdate = true;

    scene.add(cacti, tops, arms);
    group.add(cacti, tops, arms);
    disposables.push(
      bodyGeometry,
      topGeometry,
      bodyMaterial,
      topMaterial,
      armGeometry,
      armMaterial,
      cacti,
      tops,
      arms,
    );

    // 巨石群：随机散布，远离赛道
    const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
    const rockMaterial = new THREE.MeshStandardMaterial({
      color: theme.rockColor,
      roughness: 1,
      metalness: 0,
    });
    const rockCount = Math.max(20, Math.round(theme.treeCount * 0.45));
    const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockCount);
    rocks.name = 'desert-rocks';
    rocks.castShadow = true;
    rocks.receiveShadow = true;

    let placed = 0;
    for (let i = 0; i < rockCount; i++) {
      for (let attempt = 0; attempt < 120; attempt++) {
        const x = bounds.minX - 120 + random() * (bounds.maxX - bounds.minX + 240);
        const z = bounds.minZ - 120 + random() * (bounds.maxZ - bounds.minZ + 240);
        if (
          track.distanceToCenterline(x, z) < track.halfWidth + 16 ||
          track.distanceToTunnel(x, z) < 30
        ) {
          continue;
        }
        const s = 1.6 + random() * 5.5;
        quaternion.setFromAxisAngle(upAxis, random() * Math.PI * 2);
        scale.set(s, s * (0.55 + random() * 0.4), s * (0.8 + random() * 0.5));
        position.set(x, s * 0.35, z);
        matrix.compose(position, quaternion, scale);
        rocks.setMatrixAt(placed++, matrix);
        break;
      }
    }
    rocks.count = placed;
    rocks.instanceMatrix.needsUpdate = true;
    scene.add(rocks);
    group.add(rocks);
    disposables.push(rockGeometry, rockMaterial, rocks);

    // 远处台地：用被压扁的巨石做地平线轮廓
    const mesaGeometry = new THREE.CylinderGeometry(1, 1.15, 1, 7);
    const mesaMaterial = new THREE.MeshStandardMaterial({
      color: theme.rockColor,
      roughness: 1,
      metalness: 0,
    });
    const mesaCount = 10;
    const mesas = new THREE.InstancedMesh(mesaGeometry, mesaMaterial, mesaCount);
    mesas.name = 'mesas';
    mesas.castShadow = false;
    mesas.receiveShadow = true;
    for (let i = 0; i < mesaCount; i++) {
      const a = (i / mesaCount) * Math.PI * 2 + 0.35;
      const dist = bounds.radius + 260 + random() * 260;
      const s = 40 + random() * 55;
      quaternion.setFromAxisAngle(upAxis, random() * Math.PI * 2);
      scale.set(s, 14 + random() * 18, s * (0.7 + random() * 0.6));
      position.set(bounds.cx + Math.cos(a) * dist, 6, bounds.cz + Math.sin(a) * dist);
      matrix.compose(position, quaternion, scale);
      mesas.setMatrixAt(i, matrix);
    }
    mesas.instanceMatrix.needsUpdate = true;
    scene.add(mesas);
    group.add(mesas);
    disposables.push(mesaGeometry, mesaMaterial, mesas);
  }

  // ---------------------------------------------------------------------------
  // Distant ridges (horizon depth)
  // ---------------------------------------------------------------------------
  // 两圈远景山脊：让地平线有层次，而不是「地面直接切进雾里」。
  //
  // 距离必须按雾的参数算，不能按固定米数：翡翠森林 fogFar 只有 900，
  // 之前把山放在 620~1040 m，一半的山被雾 100% 吃掉，看上去是一排白色巨石。
  // 现在近圈放在雾程的 26%、远圈放在 58%，两圈都只吃到一半左右的雾，山体才有颜色。
  const fogSpan = Math.max(1, theme.fogFar - theme.fogNear);
  const ridgeLayers = [
    { count: 30, dist: theme.fogNear + fogSpan * 0.45, hScale: 1.0, lScale: 1.0 },
    { count: 26, dist: theme.fogNear + fogSpan * 0.75, hScale: 1.45, lScale: 1.0 },
  ];
  const ridgeGeometry = new THREE.CylinderGeometry(1, 1.25, 1, 6);
  const ridgeMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    flatShading: true,
  });
  const ridgeBase = new THREE.Color();
  const ridgeHsl = { h: 0, s: 0, l: 0 };
  if (theme.scenery === 'forest') {
    // 深绿灰：比树冠暗、饱和度低，再往雾色里混一点，远看才像被空气压灰的森林山脊
    ridgeBase.set(theme.canopyColor);
    ridgeBase.getHSL(ridgeHsl, THREE.SRGBColorSpace);
    ridgeBase.setHSL(ridgeHsl.h, ridgeHsl.s * 0.7, ridgeHsl.l * 0.72, THREE.SRGBColorSpace);
    ridgeBase.lerp(new THREE.Color(theme.fogColor), 0.3);
  } else {
    ridgeBase.set(theme.rockColor);
    ridgeBase.getHSL(ridgeHsl, THREE.SRGBColorSpace);
    ridgeBase.setHSL(ridgeHsl.h, ridgeHsl.s * 0.9, ridgeHsl.l * 1.1, THREE.SRGBColorSpace);
    ridgeBase.lerp(new THREE.Color(theme.fogColor), 0.2);
  }
  const ridgeColor = new THREE.Color();
  const ridgeGroup: THREE.InstancedMesh[] = [];

  for (let layer = 0; layer < ridgeLayers.length; layer++) {
    const spec = ridgeLayers[layer]!;
    // 近圈不能压到赛道，至少离包围盒 200 m
    const baseDist = Math.max(spec.dist, bounds.radius + 200 + layer * 90);
    const mesh = new THREE.InstancedMesh(ridgeGeometry, ridgeMaterial, spec.count);
    mesh.name = `distant-ridges-${layer}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;

    for (let i = 0; i < spec.count; i++) {
      const angle = (i / spec.count) * Math.PI * 2 + (random() - 0.5) * 0.18;
      const dist = baseDist + (random() - 0.5) * 70;
      // 近处矮一点、远处高一点，避免两圈一样高显得像围墙
      const width = (80 + random() * 70) * spec.hScale;
      const height =
        (theme.scenery === 'forest' ? 20 + random() * 24 : 28 + random() * 32) * spec.hScale;
      const flatten = 0.55 + random() * 0.35;
      const sx = (width * 0.5) / 1.25; // 几何底半径为 1.25
      quaternion.setFromAxisAngle(upAxis, random() * Math.PI * 2);
      scale.set(sx, height, sx * flatten);
      position.set(
        bounds.cx + Math.cos(angle) * dist,
        height * 0.5 - 6, // 底部埋进地面 6 m，避免露出悬空边
        bounds.cz + Math.sin(angle) * dist,
      );
      matrix.compose(position, quaternion, scale);
      mesh.setMatrixAt(i, matrix);
      ridgeColor.copy(ridgeBase).offsetHSL(0, 0, (random() - 0.5) * 0.08 * spec.lScale);
      mesh.setColorAt(i, ridgeColor);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    scene.add(mesh);
    group.add(mesh);
    ridgeGroup.push(mesh);
  }
  disposables.push(ridgeGeometry, ridgeMaterial, ...ridgeGroup);

  // ---------------------------------------------------------------------------
  // Atmosphere
  // ---------------------------------------------------------------------------
  scene.fog = new THREE.Fog(theme.fogColor, theme.fogNear, theme.fogFar);
  scene.background = null;

  scene.add(group);

  const update = (kartPos: THREE.Vector3): void => {
    sun.position.copy(kartPos).add(SUN_OFFSET);
    sun.target.position.copy(kartPos);
    sun.target.updateMatrixWorld();
    // 云缓慢飘移：用真实时间，不依赖外部 dt
    skyMaterial.uniforms.uTime!.value = performance.now() * 0.001;
  };

  const dispose = (): void => {
    scene.remove(group);
    scene.remove(sky);
    scene.remove(ground);
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(hemisphere);

    sun.shadow.map?.dispose();

    for (const resource of disposables) {
      resource.dispose();
    }
    disposables.length = 0;

    if (scene.fog instanceof THREE.Fog) {
      scene.fog = null;
    }
  };

  return { group, sun, update, dispose };
}
