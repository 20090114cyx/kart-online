import * as THREE from 'three';

/**
 * 冲刺后处理管线。
 *
 * 做法：先把 3D 场景渲到一张半浮点 RenderTarget（带 4x MSAA），
 * 再用一个全屏四边形跑一遍着色器：
 *   - 径向模糊（越靠画面边缘越强，只在加速/高速时出现）
 *   - 放射状速度线（两层不同密度、向外流动）
 *   - 边缘色差（RGB 分离）
 *   - 暗角 / 暖色偏移 / 起喷白闪
 *   - 线性 → sRGB 编码
 *
 * 不依赖 three 的 EffectComposer / OutputPass，避免版本差异和额外 draw。
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2D tDiffuse;
uniform vec2 uResolution;
uniform vec2 uViewMin;
uniform vec2 uViewSize;
uniform float uTime;
uniform float uBoost;   // 0..1 冲刺强度
uniform float uFlash;   // 0..1 起喷白闪
uniform float uSpeed;   // 0..1 速度比
varying vec2 vUv;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

// 一层放射状速度线：按角度切扇区，每个扇区随机决定有没有线
float streaks(float ang, float radius, float density, float speed, float seed) {
  float sector = (ang / 6.2831853 + 0.5) * density;
  float id = floor(sector);
  float f = fract(sector) - 0.5;
  float h = hash11(id + seed);
  float on = step(h, 0.55);
  // 线越细越好，粗了就像漫画
  float w = 0.022 + h * 0.030;
  float line = smoothstep(w, 0.0, abs(f)) * on;
  // 沿半径向外流动的短划线，两端都收尖
  float flow = fract(-radius * 2.7 + uTime * speed + h * 5.0);
  line *= smoothstep(0.0, 0.14, flow) * smoothstep(0.58, 0.34, flow);
  return line;
}

void main() {
  vec2 uv = vUv;
  // 分屏时每个视口只占整张 target 的一半：
  // 先把全局 uv 换算成视口内的 0..1 坐标，径向效果才会以各自画面中心为圆心。
  vec2 local = (uv - uViewMin) / uViewSize;
  vec2 d = local - 0.5;
  vec2 pa = d;
  pa.x *= uResolution.x / uResolution.y;
  // d 是视口归一化坐标，采样时再换回 target 的全局 uv 偏移
  vec2 uvOff = d * uViewSize;

  float radius = length(pa);
  float ang = atan(pa.y, pa.x);
  float edge = smoothstep(0.04, 0.80, length(d));

  float boost = clamp(uBoost, 0.0, 1.0);

  // ---------------- 径向模糊 ----------------
  // 中心的像素几乎不动，边缘拉长 —— 也顺带充当高速时的动态模糊
  float blurAmt = (boost * 0.060 + uSpeed * 0.008) * edge;
  vec3 col = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 12; i++) {
    float t = float(i) / 11.0;
    float w = 1.0 - t * 0.72;
    col += texture2D(tDiffuse, uv - uvOff * blurAmt * t).rgb * w;
    total += w;
  }
  col /= total;

  // ---------------- 色差 ----------------
  float ca = boost * 0.0005 * smoothstep(0.15, 0.95, radius);
  if (ca > 0.00005) {
    float sr = texture2D(tDiffuse, uv - uvOff * ca).r;
    float sb = texture2D(tDiffuse, uv + uvOff * ca).b;
    col.r = mix(col.r, sr, 0.8);
    col.b = mix(col.b, sb, 0.8);
  }

  // ---------------- 速度线 ----------------
  if (boost > 0.01) {
    float s1 = streaks(ang, radius, 34.0, 2.0, 0.0);
    float s2 = streaks(ang, radius, 58.0, 3.2, 17.0);
    float lines = clamp(s1 * 0.85 + s2 * 0.5, 0.0, 1.0);
    // 只在画面外圈出现，中间留干净
    lines *= smoothstep(0.26, 0.72, radius);
    col += vec3(1.0, 0.97, 0.92) * lines * boost * 0.80;

    // 边缘的白色光晕，把视线往中间收
    float rim = smoothstep(0.55, 1.05, radius);
    col += vec3(0.95, 0.97, 1.0) * rim * rim * boost * 0.14;
  }

  // ---------------- 起喷白闪 ----------------
  col = mix(col, vec3(1.0, 0.99, 0.95), clamp(uFlash, 0.0, 1.0) * 0.16);

  // ---------------- 暗角 ----------------
  float vig = smoothstep(1.25, 0.25, radius);
  col *= mix(1.0, 0.86 + 0.14 * vig, 0.5);
  col *= mix(1.0, 0.40 + 0.60 * vig, boost * 0.85);

  // 冲刺时轻微偏暖，更有"热"感
  col = mix(col, col * vec3(1.07, 1.0, 0.93), boost * 0.8);

  // ---------------- linear -> sRGB ----------------
  // 渲染到 RenderTarget 时 three 强制走线性输出，所以这里手动编码
  col = max(col, vec3(0.0));
  col = mix(col * 12.92, 1.055 * pow(col, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), col));

  gl_FragColor = vec4(col, 1.0);
}
`;

export interface FxState {
  boost: number;
  flash: number;
  speed: number;
}

/** 分屏视口：x/y/w/h 都是 drawingBuffer 像素，原点在左下角（WebGL 约定） */
export interface SplitView {
  camera: THREE.Camera;
  fx: FxState;
  x: number;
  y: number;
  w: number;
  h: number;
}

export class PostFX {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private time = 0;

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.target = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.minFilter = THREE.LinearFilter;
    this.target.texture.magFilter = THREE.LinearFilter;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uResolution: { value: new THREE.Vector2(size.x, size.y) },
        uViewMin: { value: new THREE.Vector2(0, 0) },
        uViewSize: { value: new THREE.Vector2(1, 1) },
        uTime: { value: 0 },
        uBoost: { value: 0 },
        uFlash: { value: 0 },
        uSpeed: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  setSize(): void {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target.setSize(size.x, size.y);
    (this.material.uniforms.uResolution!.value as THREE.Vector2).set(size.x, size.y);
  }

  render(scene: THREE.Scene, camera: THREE.Camera, fx: FxState, dt: number): void {
    this.time += dt;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const dpr = this.renderer.getPixelRatio();
    const u = this.material.uniforms;
    u.uTime!.value = this.time;
    u.uBoost!.value = fx.boost;
    u.uFlash!.value = fx.flash;
    u.uSpeed!.value = fx.speed;
    (u.uResolution!.value as THREE.Vector2).set(size.x, size.y);
    (u.uViewMin!.value as THREE.Vector2).set(0, 0);
    (u.uViewSize!.value as THREE.Vector2).set(1, 1);

    // 分屏结束后 target 的 viewport 还停在右半屏，这里必须复位，
    // 否则从双人切回单人 / 选图时，场景只会画进右半张 target。
    const t = this.target;
    t.viewport.set(0, 0, size.x, size.y);
    t.scissor.set(0, 0, size.x, size.y);
    t.scissorTest = false;
    this.renderer.setRenderTarget(t);
    this.renderer.setViewport(0, 0, size.x, size.y);
    this.renderer.setScissor(0, 0, size.x, size.y);
    this.renderer.setScissorTest(false);
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.setViewport(0, 0, size.x / dpr, size.y / dpr);
    this.renderer.setScissor(0, 0, size.x / dpr, size.y / dpr);
    this.renderer.setScissorTest(false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /**
   * 分屏：每个视口独立渲染场景，再用同一个全屏 shader 逐视口出图。
   * 场景只渲一次/视口，shader 也只跑一次/视口，不额外复制 target。
   */
  renderSplit(scene: THREE.Scene, views: SplitView[], dt: number): void {
    if (views.length === 0) return;
    this.time += dt;

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const r = this.renderer;
    const t = this.target;
    // three 的 setViewport/setScissor 在「渲染到 RenderTarget」时按设备像素处理，
    // 渲染到画布时会乘 pixelRatio。两种目标单位不同，必须分开换算。
    const dpr = r.getPixelRatio();
    const cssW = size.x / dpr;
    const cssH = size.y / dpr;

    // 1) 每个视口把场景渲进同一张 target 的对应区域。
    // 注意：three 渲染阴影贴图后会用 setRenderTarget(target) 恢复状态，
    // 恢复的是 target.viewport / target.scissor / target.scissorTest。
    // 只调 r.setViewport 不够，阴影一渲完就会被重置成整张 target，
    // 结果第二个视口把第一个覆盖掉、左右两边都是同一台车。
    t.scissorTest = true;
    for (const v of views) {
      t.viewport.set(v.x, v.y, v.w, v.h);
      t.scissor.set(v.x, v.y, v.w, v.h);
      r.setRenderTarget(t);
      // target 已绑定：这里的数字就是设备像素，不能再乘/除 pixelRatio
      r.setViewport(v.x, v.y, v.w, v.h);
      r.setScissor(v.x, v.y, v.w, v.h);
      r.setScissorTest(true);
      r.render(scene, v.camera);
    }

    // 2) 逐视口跑后处理。quad 仍然覆盖整屏，靠 scissor 只画自己那一半。
    r.setRenderTarget(null);
    const u = this.material.uniforms;
    for (const v of views) {
      u.uTime!.value = this.time;
      u.uBoost!.value = v.fx.boost;
      u.uFlash!.value = v.fx.flash;
      u.uSpeed!.value = v.fx.speed;
      (u.uResolution!.value as THREE.Vector2).set(v.w, v.h);
      (u.uViewMin!.value as THREE.Vector2).set(v.x / size.x, v.y / size.y);
      (u.uViewSize!.value as THREE.Vector2).set(v.w / size.x, v.h / size.y);

      r.setViewport(0, 0, cssW, cssH);
      r.setScissor(v.x / dpr, v.y / dpr, v.w / dpr, v.h / dpr);
      r.render(this.quadScene, this.quadCamera);
    }

    r.setScissorTest(false);
    r.setViewport(0, 0, cssW, cssH);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
