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

export function createScenery(scene: THREE.Scene, track: Track): Scenery {
  const group = new THREE.Group();
  group.name = 'scenery';
  const theme: TrackTheme = track.theme;
  const bounds = trackBounds(track);
  const disposables: Array<{ dispose(): void }> = [];

  // ---------------------------------------------------------------------------
  // Sky dome
  // ---------------------------------------------------------------------------
  const skyGeometry = new THREE.SphereGeometry(2200, 32, 16);
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      horizonColor: { value: new THREE.Color(theme.skyHorizon) },
      zenithColor: { value: new THREE.Color(theme.skyZenith) },
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
      varying vec3 vWorldPosition;

      void main() {
        float h = normalize(vWorldPosition).y;
        float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.8);
        gl_FragColor = vec4(mix(horizonColor, zenithColor, t), 1.0);
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
  const groundGeometry = new THREE.PlaneGeometry(4200, 4200);
  groundGeometry.rotateX(-Math.PI / 2);
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: theme.groundColor,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = 'ground';
  ground.position.y = -0.03;
  ground.receiveShadow = true;
  scene.add(ground);
  group.add(ground);
  disposables.push(groundGeometry, groundMaterial);

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
    const trunkGeometry = new THREE.CylinderGeometry(0.35, 0.5, 3.2, 6);
    const trunkMaterial = new THREE.MeshStandardMaterial({
      color: theme.trunkColor,
      roughness: 0.95,
      metalness: 0,
    });
    const canopyGeometry = new THREE.ConeGeometry(2.6, 7.0, 7);
    const canopyMaterial = new THREE.MeshStandardMaterial({
      color: theme.canopyColor,
      roughness: 0.9,
      metalness: 0,
    });

    const trunks = new THREE.InstancedMesh(trunkGeometry, trunkMaterial, Math.max(1, spots.length));
    const canopies = new THREE.InstancedMesh(canopyGeometry, canopyMaterial, Math.max(1, spots.length));
    trunks.name = 'tree-trunks';
    canopies.name = 'tree-canopies';
    trunks.castShadow = canopies.castShadow = true;
    trunks.receiveShadow = canopies.receiveShadow = true;

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      quaternion.setFromAxisAngle(upAxis, s.r);
      scale.set(s.s, s.s, s.s);
      position.set(s.x, 1.6 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      trunks.setMatrixAt(i, matrix);
      position.set(s.x, 5.2 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      canopies.setMatrixAt(i, matrix);
    }
    trunks.count = spots.length;
    canopies.count = spots.length;
    trunks.instanceMatrix.needsUpdate = true;
    canopies.instanceMatrix.needsUpdate = true;

    scene.add(trunks, canopies);
    group.add(trunks, canopies);
    disposables.push(
      trunkGeometry,
      trunkMaterial,
      canopyGeometry,
      canopyMaterial,
      trunks,
      canopies,
    );
  } else {
    // 沙漠：仙人掌 + 巨石。仙人掌用圆柱身体 + 圆顶，足够远看识别。
    const cactusGeometry = new THREE.CylinderGeometry(0.5, 0.68, 5.4, 7);
    const cactusTopGeometry = new THREE.SphereGeometry(0.52, 7, 5);
    const cactusMaterial = new THREE.MeshStandardMaterial({
      color: theme.trunkColor,
      roughness: 0.9,
      metalness: 0,
    });
    const cactusTopMaterial = new THREE.MeshStandardMaterial({
      color: theme.canopyColor,
      roughness: 0.9,
      metalness: 0,
    });

    const cacti = new THREE.InstancedMesh(cactusGeometry, cactusMaterial, Math.max(1, spots.length));
    const tops = new THREE.InstancedMesh(cactusTopGeometry, cactusTopMaterial, Math.max(1, spots.length));
    cacti.name = 'cacti';
    tops.name = 'cactus-tops';
    cacti.castShadow = tops.castShadow = true;
    cacti.receiveShadow = tops.receiveShadow = true;

    for (let i = 0; i < spots.length; i++) {
      const s = spots[i]!;
      quaternion.setFromAxisAngle(upAxis, s.r);
      scale.set(s.s, s.s, s.s);
      position.set(s.x, 2.7 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      cacti.setMatrixAt(i, matrix);
      position.set(s.x, 5.4 * s.s, s.z);
      matrix.compose(position, quaternion, scale);
      tops.setMatrixAt(i, matrix);
    }
    cacti.count = spots.length;
    tops.count = spots.length;
    cacti.instanceMatrix.needsUpdate = true;
    tops.instanceMatrix.needsUpdate = true;

    scene.add(cacti, tops);
    group.add(cacti, tops);
    disposables.push(
      cactusGeometry,
      cactusTopGeometry,
      cactusMaterial,
      cactusTopMaterial,
      cacti,
      tops,
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
  // Atmosphere
  // ---------------------------------------------------------------------------
  scene.fog = new THREE.Fog(theme.fogColor, theme.fogNear, theme.fogFar);
  scene.background = null;

  scene.add(group);

  const update = (kartPos: THREE.Vector3): void => {
    sun.position.copy(kartPos).add(SUN_OFFSET);
    sun.target.position.copy(kartPos);
    sun.target.updateMatrixWorld();
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
