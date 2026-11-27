/**
 * 赛道定义：几何 + 主题 + 玩法元素。
 *
 * 这里只放数据，不碰 three.js / DOM。`trackLayout.ts` 负责把定义
 * 采样成可驾驶路径，`track.ts` 负责渲染。
 */

export interface Kicker {
  /** 唇口位置：主路 t / 支路弧长比例 u，0..1 */
  t: number;
  height: number;
  /** 上坡长度（参数单位） */
  up: number;
  /** 落地坡长度 */
  down: number;
}

export interface WidthZone {
  t0: number;
  t1: number;
  halfWidth: number;
}

export interface BranchBoostPad {
  u: number;
  boostTime?: number;
  radius?: number;
}

export interface BranchDragZone {
  u: number;
  radius: number;
  /** 每秒掉速 m/s */
  strength: number;
}

export interface BranchDef {
  id: string;
  name: string;
  /** 在主路进度上的起点 / 终点 */
  tStart: number;
  tEnd: number;
  /** 内场控制点：[沿主路段的比例 0..1, 向内的横向偏移（米）] */
  controls: Array<[number, number]>;
  /** 分叉口处先沿主路切线延伸的长度（米） */
  lead?: number;
  halfWidth?: number;
  kickers?: Kicker[];
  boostPads?: BranchBoostPad[];
  dragZones?: BranchDragZone[];
  /** 给 AI 的难度系数，0 = 白送，1 = 很险 */
  risk?: number;
}

export interface MainBoostPad {
  t: number;
  boostTime?: number;
  radius?: number;
}

export interface MainDragZone {
  t: number;
  radius: number;
  strength: number;
}

export interface CanyonZone {
  t0: number;
  t1: number;
  height?: number;
}

export interface BridgeZone {
  t0: number;
  t1: number;
}

export interface TrackTheme {
  skyHorizon: number;
  skyZenith: number;
  fogColor: number;
  fogNear: number;
  fogFar: number;
  groundColor: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  /** 路面贴图基色 / 标线色 / 路肩色 */
  asphalt: string;
  asphaltLine: string;
  asphaltEdge: string;
  dirtLight: number;
  dirtDark: number;
  grass: number;
  railRed: number;
  railWhite: number;
  scenery: 'forest' | 'desert';
  trunkColor: number;
  canopyColor: number;
  rockColor: number;
  treeCount: number;
}

export interface TrackDef {
  id: string;
  name: string;
  subtitle: string;
  description: string;
  difficulty: 1 | 2 | 3;
  laps: number;
  /** 圆角多边形顶点：[x, z, 圆角半径]，会再乘 scale */
  scale: number;
  verts: Array<[number, number, number]>;
  mainHalfWidth: number;
  widthZones?: WidthZone[];
  hills: Array<[center: number, height: number, width: number]>;
  kickers: Kicker[];
  branches: BranchDef[];
  boostPads: MainBoostPad[];
  dragZones?: MainDragZone[];
  tunnel?: { tStart: number; tEnd: number };
  canyonZones?: CanyonZone[];
  bridgeZones?: BridgeZone[];
  theme: TrackTheme;
  features: string[];
}

const FOREST_THEME: TrackTheme = {
  skyHorizon: 0xcfe3f5,
  skyZenith: 0x2f6fb8,
  fogColor: 0xc8dcef,
  fogNear: 180,
  fogFar: 900,
  groundColor: 0x3c5236,
  sunColor: 0xfff1dd,
  sunIntensity: 2.4,
  hemiSky: 0xbcd9f2,
  hemiGround: 0x3a4a33,
  hemiIntensity: 0.65,
  asphalt: '#46494f',
  asphaltLine: '#e8e8e8',
  asphaltEdge: '#d8dde3',
  dirtLight: 0x6d6459,
  dirtDark: 0x565046,
  grass: 0x3c5236,
  railRed: 0xe23b3b,
  railWhite: 0xf2f2f2,
  scenery: 'forest',
  trunkColor: 0x6b4a2f,
  canopyColor: 0x2f6b34,
  rockColor: 0x8a8a78,
  treeCount: 320,
};

const DESERT_THEME: TrackTheme = {
  skyHorizon: 0xffd9a0,
  skyZenith: 0x2f6fa8,
  fogColor: 0xe8c9a0,
  fogNear: 260,
  fogFar: 1500,
  groundColor: 0xc9a36b,
  sunColor: 0xffe2b0,
  sunIntensity: 2.8,
  hemiSky: 0xffe6c0,
  hemiGround: 0x7a5a3a,
  hemiIntensity: 0.7,
  asphalt: '#4a4440',
  asphaltLine: '#f0e2c8',
  asphaltEdge: '#d8c4a0',
  dirtLight: 0xb08a5e,
  dirtDark: 0x8a6a46,
  grass: 0xc9a36b,
  railRed: 0xd9583b,
  railWhite: 0xf3e6cf,
  scenery: 'desert',
  trunkColor: 0x4f7a45,
  canopyColor: 0x6a9a55,
  rockColor: 0x9a7852,
  treeCount: 300,
};

/**
 * 第一条：翡翠森林。
 * 保留原来的 1.84 km 环线 + 一条内场捷径，作为新手赛道。
 */
export const FOREST_TRACK: TrackDef = {
  id: 'forest',
  name: '翡翠森林',
  subtitle: '新手环线 · 一条内场捷径',
  description: '林间长弯 + 92 m 隧道。内场支路更短，但连续急弯和跳台会惩罚失误。',
  difficulty: 1,
  laps: 3,
  scale: 1.4,
  verts: [
    [-52, 120, 0],
    [-52, 220, 46],
    [0, 268, 50],
    [85, 268, 50],
    [125, 246, 26],
    [165, 272, 26],
    [205, 248, 50],
    [262, 224, 46],
    [306, 160, 42],
    [220, 160, 20],
    [220, 118, 20],
    [306, 118, 42],
    [300, 10, 46],
    [250, -62, 52],
    [160, -96, 52],
    [60, -92, 46],
    [-12, -52, 46],
    [-52, 22, 46],
  ],
  mainHalfWidth: 11,
  hills: [
    [0.14, 4.5, 0.035],
    [0.36, 6.5, 0.04],
    [0.58, 3.0, 0.03],
    [0.9, 5.0, 0.035],
  ],
  kickers: [
    { t: 0.28, height: 1.2, up: 0.012, down: 0.05 },
    { t: 0.62, height: 1.8, up: 0.014, down: 0.06 },
  ],
  branches: [
    {
      id: 'forest-inner',
      name: '林间捷径',
      tStart: 0.6,
      tEnd: 0.9,
      halfWidth: 9.4,
      lead: 14,
      controls: [
        [0.1, 24],
        [0.2, 40],
        [0.34, 54],
        [0.46, 76],
        [0.54, 76],
        [0.66, 54],
        [0.8, 40],
        [0.9, 24],
      ],
      kickers: [{ t: 0.54, height: 1.5, up: 0.09, down: 0.15 }],
      boostPads: [{ u: 0.36, boostTime: 1.5, radius: 4.2 }],
      risk: 0.45,
    },
  ],
  boostPads: [{ t: 0.205, boostTime: 1.2, radius: 4.2 }],
  tunnel: { tStart: 0.138, tEnd: 0.188 },
  theme: FOREST_THEME,
  features: ['92 m 隧道', '内场捷径', '3 处跳台'],
};

/**
 * 第二条：赤沙峡谷。
 * 约 3.9 km 的大环线，三条内场支路，三个 90° 直角弯，隧道 / 高架桥 /
 * 峡谷岩壁 / 沙地减速带。
 */
export const CANYON_TRACK: TrackDef = {
  id: 'canyon',
  name: '赤沙峡谷',
  subtitle: '大型赛道 · 三条分叉 · 直角弯',
  description:
    '接近 4 km 的沙漠大环线。三条支路各有性格：纯捷径、加速带快线、峡谷险道。直角弯必须提前刹车或漂移。',
  difficulty: 3,
  laps: 2,
  scale: 1,
  verts: [
    [-377, 0, 0],
    [-377, 261, 80],
    [-290, 377, 75],
    [-116, 435, 80],
    [87, 435, 75],
    [218, 377, 34],
    [334, 421, 34],
    [479, 392, 75],
    [609, 305, 75],
    [682, 174, 36],
    [682, 29, 30],
    [812, 29, 30],
    [812, -91, 30],
    [932, -91, 30],
    [986, -218, 75],
    [943, -377, 75],
    [812, -479, 80],
    [624, -522, 80],
    [435, -522, 80],
    [261, -479, 70],
    [116, -421, 65],
    [-29, -363, 65],
    [-174, -319, 58],
    [-290, -232, 58],
    [-377, -116, 60],
  ],
  mainHalfWidth: 12,
  widthZones: [
    { t0: 0.405, t1: 0.44, halfWidth: 13.5 },
    { t0: 0.47, t1: 0.505, halfWidth: 13.5 },
  ],
  hills: [
    [0.06, 5.0, 0.03],
    [0.25, 8.0, 0.035],
    [0.48, 4.0, 0.03],
    [0.66, 7.0, 0.04],
    [0.86, 6.0, 0.035],
  ],
  kickers: [
    { t: 0.18, height: 1.6, up: 0.012, down: 0.05 },
    { t: 0.44, height: 2.0, up: 0.014, down: 0.06 },
    { t: 0.74, height: 1.8, up: 0.014, down: 0.06 },
  ],
  branches: [
    {
      id: 'canyon-north',
      name: '北境捷径',
      tStart: 0.1,
      tEnd: 0.22,
      halfWidth: 10,
      lead: 30,
      controls: [
        [0.2, 32],
        [0.36, 48],
        [0.52, 42],
        [0.7, 32],
        [0.88, 20],
      ],
      kickers: [{ t: 0.55, height: 1.6, up: 0.08, down: 0.14 }],
      boostPads: [{ u: 0.58, boostTime: 1.3, radius: 4.2 }],
      risk: 0.35,
    },
    {
      id: 'canyon-oasis',
      name: '绿洲快线',
      tStart: 0.28,
      tEnd: 0.38,
      halfWidth: 10,
      lead: 30,
      controls: [
        [0.2, 32],
        [0.36, 48],
        [0.52, 70],
        [0.7, 50],
        [0.86, 22],
      ],
      kickers: [{ t: 0.45, height: 2.0, up: 0.07, down: 0.13 }],
      boostPads: [
        { u: 0.3, boostTime: 1.4, radius: 4.2 },
        { u: 0.7, boostTime: 1.4, radius: 4.2 },
      ],
      dragZones: [{ u: 0.52, radius: 8, strength: 1.2 }],
      risk: 0.55,
    },
    {
      id: 'canyon-gorge',
      name: '峡谷险道',
      tStart: 0.66,
      tEnd: 0.8,
      halfWidth: 9.2,
      lead: 30,
      controls: [
        [0.2, 26],
        [0.36, 60],
        [0.52, 92],
        [0.7, 70],
        [0.86, 30],
      ],
      kickers: [{ t: 0.52, height: 1.8, up: 0.08, down: 0.14 }],
      boostPads: [
        { u: 0.42, boostTime: 1.4, radius: 4.2 },
        { u: 0.68, boostTime: 1.3, radius: 4.2 },
      ],
      risk: 0.8,
    },
  ],
  boostPads: [
    { t: 0.15, boostTime: 1.2, radius: 4.2 },
    { t: 0.47, boostTime: 1.2, radius: 4.2 },
    { t: 0.83, boostTime: 1.2, radius: 4.2 },
  ],
  dragZones: [
    { t: 0.34, radius: 11, strength: 1.0 },
    { t: 0.58, radius: 10.5, strength: 1.5 },
  ],
  tunnel: { tStart: 0.555, tEnd: 0.585 },
  canyonZones: [
    { t0: 0.62, t1: 0.72, height: 13 },
    { t0: 0.9, t1: 0.97, height: 10 },
  ],
  bridgeZones: [
    { t0: 0.225, t1: 0.285 },
    { t0: 0.455, t1: 0.515 },
  ],
  theme: DESERT_THEME,
  features: ['3 个直角弯', '隧道 + 高架桥', '峡谷岩壁 + 沙地'],
};

export const TRACK_DEFS: TrackDef[] = [FOREST_TRACK, CANYON_TRACK];
