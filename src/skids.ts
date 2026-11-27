import * as THREE from 'three';

const WHEELS = 2;
const VERTS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const HALF_WIDTH = 0.17;
const MIN_SEGMENT = 0.22;
const TELEPORT_DISTANCE = 8;
const Y_OFFSET = 0.03;
const FADE_RATE = 0.055;
const ALPHA_SCALE = 0.6;

const VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
varying float vAlpha;
void main() {
  float aAlpha = vAlpha;
  if (aAlpha < 0.01) discard;
  gl_FragColor = vec4(vec3(0.02, 0.02, 0.025), aAlpha);
}
`;

/** 漂移胎痕：后轮位置生成逐渐淡出的黑色四边形条带 */
export class SkidMarks {
  readonly mesh: THREE.Mesh;

  private readonly capacity: number;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;

  private readonly position: Float32Array;
  private readonly alpha: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;

  private readonly lastX = new Float32Array(WHEELS);
  private readonly lastY = new Float32Array(WHEELS);
  private readonly lastZ = new Float32Array(WHEELS);
  private readonly hasLast = new Uint8Array(WHEELS);
  private readonly writeIndex = new Int32Array(WHEELS);

  constructor(scene: THREE.Scene, capacity = 900) {
    this.capacity = Math.max(1, Math.floor(capacity));

    const totalQuads = this.capacity * WHEELS;
    const totalVerts = totalQuads * VERTS_PER_QUAD;

    this.position = new Float32Array(totalVerts * 3);
    this.alpha = new Float32Array(totalVerts);

    this.geometry = new THREE.BufferGeometry();

    const posAttr = new THREE.BufferAttribute(this.position, 3);
    this.posAttr = posAttr;
    this.alphaAttr = new THREE.BufferAttribute(this.alpha, 1);
    this.geometry.setAttribute('position', posAttr);
    this.geometry.setAttribute('aAlpha', this.alphaAttr);

    const indices = new Uint32Array(totalQuads * INDICES_PER_QUAD);
    for (let q = 0; q < totalQuads; q++) {
      const v = q * VERTS_PER_QUAD;
      const i = q * INDICES_PER_QUAD;
      indices[i] = v;
      indices[i + 1] = v + 1;
      indices[i + 2] = v + 2;
      indices[i + 3] = v + 2;
      indices[i + 4] = v + 1;
      indices[i + 5] = v + 3;
    }
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, totalQuads * INDICES_PER_QUAD);

    this.material = new THREE.ShaderMaterial({
      uniforms: {},
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    scene.add(this.mesh);
  }

  /** 在指定轮子下方追加一段胎痕。y 传入地面高度即可，内部会自己抬高一点避免 z-fighting */
  emit(wheelIndex: number, x: number, y: number, z: number, intensity: number): void {
    if (wheelIndex < 0 || wheelIndex >= WHEELS) return;
    const w = wheelIndex | 0;

    if (this.hasLast[w] === 0) {
      this.lastX[w] = x;
      this.lastY[w] = y;
      this.lastZ[w] = z;
      this.hasLast[w] = 1;
      return;
    }

    const lx = this.lastX[w];
    const lz = this.lastZ[w];
    const dx = x - lx;
    const dz = z - lz;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist < MIN_SEGMENT) return;

    if (dist > TELEPORT_DISTANCE) {
      this.lastX[w] = x;
      this.lastY[w] = y;
      this.lastZ[w] = z;
      return;
    }

    const inv = 1 / dist;
    const dirX = dx * inv;
    const dirZ = dz * inv;
    const nx = -dirZ * HALF_WIDTH;
    const nz = dirX * HALF_WIDTH;

    // 两端各自用自己那一点的地面高度：坡道上整段用同一个 y 会浮在路面上方
    const pyA = this.lastY[w] + Y_OFFSET;
    const pyB = y + Y_OFFSET;
    const a = Math.max(0, Math.min(1, intensity)) * ALPHA_SCALE;

    const slot = w * this.capacity + this.writeIndex[w];
    this.writeIndex[w] = (this.writeIndex[w] + 1) % this.capacity;

    const base = slot * VERTS_PER_QUAD;
    const p = this.position;

    // 上次点 - 法向
    let i3 = base * 3;
    p[i3] = lx - nx;
    p[i3 + 1] = pyA;
    p[i3 + 2] = lz - nz;

    // 上次点 + 法向
    i3 += 3;
    p[i3] = lx + nx;
    p[i3 + 1] = pyA;
    p[i3 + 2] = lz + nz;

    // 当前点 - 法向
    i3 += 3;
    p[i3] = x - nx;
    p[i3 + 1] = pyB;
    p[i3 + 2] = z - nz;

    // 当前点 + 法向
    i3 += 3;
    p[i3] = x + nx;
    p[i3 + 1] = pyB;
    p[i3 + 2] = z + nz;

    const al = this.alpha;
    al[base] = a;
    al[base + 1] = a;
    al[base + 2] = a;
    al[base + 3] = a;

    this.lastX[w] = x;
    this.lastY[w] = y;
    this.lastZ[w] = z;

    // 位置属性已缓存，直接标记更新
    this.posAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  /** 每帧调用，让胎痕随时间淡出 */
  update(dt: number): void {
    if (dt <= 0) return;

    const decay = dt * FADE_RATE;
    const al = this.alpha;
    const n = al.length;
    let dirty = false;

    for (let i = 0; i < n; i++) {
      const v = al[i];
      if (v <= 0) continue;
      const next = v - decay;
      al[i] = next > 0 ? next : 0;
      dirty = true;
    }

    if (dirty) this.alphaAttr.needsUpdate = true;
  }

  clear(): void {
    this.alpha.fill(0);
    this.alphaAttr.needsUpdate = true;

    for (let w = 0; w < WHEELS; w++) {
      this.hasLast[w] = 0;
      this.writeIndex[w] = 0;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }
}
