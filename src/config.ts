/**
 * 所有可调手感参数集中在这里。
 * P 是运行时可变的，lil-gui 直接绑定它，物理每 tick 读取 —— 改完立即生效。
 */

const defaults = {
  // ---------- 引擎 ----------
  maxSpeed: 44, // m/s  (~158 km/h)
  boostMaxSpeed: 58, // 加速期间的速度上限
  accel: 24, // m/s²
  brakeAccel: 48,
  reverseMaxSpeed: 12,
  coastDrag: 3, // 松油门滑行阻力
  overspeedDrag: 3, // 超速回落速度（越大回得越快）

  // ---------- 转向 ----------
  steerMaxYaw: 2.2, // 正常行驶的最大转向角速度
  steerResponse: 13, // 转向响应速度（越大越跟手）
  steerResponseDrift: 17,
  steerSpeedFalloff: 45, // 正常行驶时高速转向衰减
  steerMinSpeed: 5, // 低于该速度转向能力线性下降

  // ---------- 抓地 ----------
  gripNormal: 15, // 正常抓地：速度方向收敛率（越大越黏）
  gripDrift: 3.95, // 漂移抓地：配合高转速，把滑移角压在 38° 左右
  cornerDrag: 2, // 正常过弯的轻微掉速

  // ---------- 漂移 ----------
  driftMinSpeed: 9,
  driftMaxYaw: 3.6, // 漂移时的最大转向角速度（独立通道，远高于抓地）
  driftSpeedFalloff: 140, // 漂移时的高速衰减（越大越不容易掉转向）
  driftEntryKick: 1.7, // 入漂瞬间甩尾冲量（手感关键）
  driftDrag: 13, // 漂移侧滑掉速（m/s²）
  driftThrottle: 0.6, // 漂移时油门效率（发动机会闷）

  // ---------- 集气 ----------
  chargeRate: 0.75, // 每秒集气量
  chargeOptimalSlipDeg: 34, // 最佳滑移角
  chargeSlipFalloff: 0.7, // 超过最佳角后效率衰减
  chargeMinSpeed: 13,
  chargeMinToBoost: 0.22, // 触发小喷的最低气量
  chargeMax: 1,

  // ---------- 小喷 ----------
  boostBaseTime: 0.5,
  boostTimePerCharge: 0.6,
  boostImpulse: 5, // 触发瞬间的前向冲量
  boostAccel: 18,

  // ---------- 连喷 ----------
  chainWindow: 0.45, // 松漂后的衔接窗口（秒）
  chainCarry: 0.5, // 窗口内再漂时气量结转比例

  // ---------- 高低差 ----------
  gravity: 20, // 重力（街机化，比真实大）
  slopeDrag: 0.85, // 坡度对速度的影响
  airControl: 0.4, // 腾空时的转向能力
  landHard: 9, // 落地冲击判定（m/s）

  // ---------- AI 对手 ----------
  aiPace: 0.94, // AI 速度上限（相对玩家极速）
  aiRubberBand: 0.8, // 0 = 关闭追赶，越大 AI 越会贴住玩家

  // ---------- 镜头 ----------
  camDist: 7.4,
  camHeight: 3.0,
  camLookAhead: 6,
  camStiffness: 9,
  camFovBase: 68,
  camFovBoost: 16,
  camFovSpeed: 6,
  camRoll: 0.035,
  camShake: 1, // 冲刺 / 撞墙时的镜头震动强度
};

export type Params = { [K in keyof typeof defaults]: number };

export const DEFAULTS: Params = { ...defaults };
export const P: Params = { ...defaults };

export function resetParams(): void {
  Object.assign(P, DEFAULTS);
}
