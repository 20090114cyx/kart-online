import * as THREE from 'three';

function makeSprite(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.5)');
    g.addColorStop(0.32, 'rgba(255,255,255,0.2)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const VERT = /* glsl */ `
attribute float aLife;
attribute float aSize;
attribute vec3 aColor;
varying float vLife;
varying vec3 vColor;
void main() {
  vLife = aLife;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = max(0.001, -mv.z);
  gl_PointSize = min(200.0, aSize * (300.0 / d));
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying float vLife;
varying vec3 vColor;
void main() {
  vec4 t = texture2D(uMap, gl_PointCoord);
  float a = t.a * vLife;
  if (a < 0.012) discard;
  // 手动做线性 -> sRGB，避免依赖 three 的 shader chunk
  gl_FragColor = vec4(pow(max(vColor, vec3(0.0)), vec3(0.4545)), a);
}
`;

/** GPU 点精灵粒子池：漂移烟雾、加速火焰 */
export class Particles {
  readonly points: THREE.Points;

  private readonly capacity: number;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly texture: THREE.Texture;

  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly colors: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly baseSize: Float32Array;
  private readonly grow: Float32Array;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly lifeAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;

  private cursor = 0;

  constructor(scene: THREE.Scene, capacity = 500) {
    this.capacity = capacity;

    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.colors = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity).fill(1);
    this.size = new Float32Array(capacity);
    this.baseSize = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.position, 3);
    this.lifeAttr = new THREE.BufferAttribute(this.life, 1);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);

    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('aLife', this.lifeAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);

    this.texture = makeSprite();
    this.material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: this.texture } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    scene.add(this.points);
  }

  spawn(
    p: THREE.Vector3,
    v: THREE.Vector3,
    life: number,
    size: number,
    color: THREE.Color,
    grow = 2.2,
  ): void {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;

    const i3 = i * 3;
    this.position[i3] = p.x;
    this.position[i3 + 1] = p.y;
    this.position[i3 + 2] = p.z;

    this.velocity[i3] = v.x;
    this.velocity[i3 + 1] = v.y;
    this.velocity[i3 + 2] = v.z;

    this.life[i] = 1;
    this.maxLife[i] = Math.max(0.05, life);
    this.size[i] = size;
    this.baseSize[i] = size;
    this.grow[i] = grow;

    this.colors[i3] = color.r;
    this.colors[i3 + 1] = color.g;
    this.colors[i3 + 2] = color.b;
  }

  update(dt: number): void {
    const cap = this.capacity;
    const damp = Math.max(0, 1 - 1.8 * dt);

    for (let i = 0; i < cap; i++) {
      if (this.life[i] <= 0) {
        this.size[i] = 0;
        continue;
      }

      this.life[i] -= dt / this.maxLife[i];
      if (this.life[i] < 0) this.life[i] = 0;

      const i3 = i * 3;
      this.position[i3] += this.velocity[i3] * dt;
      this.position[i3 + 1] += this.velocity[i3 + 1] * dt;
      this.position[i3 + 2] += this.velocity[i3 + 2] * dt;

      this.velocity[i3] *= damp;
      this.velocity[i3 + 1] *= damp;
      this.velocity[i3 + 2] *= damp;

      this.size[i] = this.baseSize[i] * Math.max(0.05, 1 + (1 - this.life[i]) * this.grow[i]);
    }

    this.posAttr.needsUpdate = true;
    this.lifeAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    this.size.fill(0);
    this.cursor = 0;
    this.lifeAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
  }

  dispose(): void {
    this.points.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
