import GUI from 'lil-gui';
import { P, resetParams } from './config';

export interface TuningActions {
  teleport: () => void;
}

/**
 * 实时手感调参面板。
 * 滑块直接改 P，物理每 tick 读取 P —— 拖完立刻生效，不用重启。
 */
export function createTuning(actions: TuningActions): GUI {
  const gui = new GUI({ title: '手感调参' });

  const engine = gui.addFolder('引擎 / 速度');
  engine.add(P, 'maxSpeed', 20, 80, 1).name('最高速度');
  engine.add(P, 'boostMaxSpeed', 30, 100, 1).name('加速时上限');
  engine.add(P, 'accel', 5, 60, 1).name('加速度');
  engine.add(P, 'brakeAccel', 10, 100, 1).name('刹车力');
  engine.add(P, 'coastDrag', 0, 15, 0.1).name('松油门阻力');
  engine.add(P, 'overspeedDrag', 0.2, 12, 0.1).name('超速回落');

  const steer = gui.addFolder('转向');
  steer.add(P, 'steerMaxYaw', 0.5, 5, 0.05).name('最大转向角速度');
  steer.add(P, 'steerResponse', 1, 40, 0.5).name('转向响应');
  steer.add(P, 'steerSpeedFalloff', 20, 300, 5).name('高速转向衰减');
  steer.add(P, 'steerMinSpeed', 1, 30, 0.5).name('低速转向下限');

  const grip = gui.addFolder('抓地 / 漂移');
  grip.add(P, 'gripNormal', 2, 40, 0.5).name('正常抓地');
  grip.add(P, 'gripDrift', 0.2, 12, 0.1).name('漂移抓地');
  grip.add(P, 'cornerDrag', 0, 15, 0.1).name('过弯掉速');
  grip.add(P, 'driftMinSpeed', 2, 30, 0.5).name('入漂最低速度');
  grip.add(P, 'driftMaxYaw', 1, 6, 0.05).name('漂移最大转向');
  grip.add(P, 'driftSpeedFalloff', 40, 400, 5).name('漂移高速衰减');
  grip.add(P, 'steerResponseDrift', 1, 40, 0.5).name('漂移转向响应');
  grip.add(P, 'driftEntryKick', 0, 4, 0.05).name('入漂甩尾冲量');
  grip.add(P, 'driftDrag', 0, 30, 0.1).name('漂移掉速');
  grip.add(P, 'driftThrottle', 0, 1, 0.01).name('漂移油门效率');

  const charge = gui.addFolder('集气');
  charge.add(P, 'chargeRate', 0.1, 3, 0.01).name('集气速度');
  charge.add(P, 'chargeOptimalSlipDeg', 10, 60, 0.5).name('最佳滑移角°');
  charge.add(P, 'chargeSlipFalloff', 0, 2, 0.01).name('超过最佳角衰减');
  charge.add(P, 'chargeMinSpeed', 2, 40, 0.5).name('集气最低速度');
  charge.add(P, 'chargeMinToBoost', 0.02, 1, 0.01).name('触发小喷门槛');

  const boost = gui.addFolder('小喷 / 连喷');
  boost.add(P, 'boostBaseTime', 0.1, 2, 0.01).name('小喷基础时长');
  boost.add(P, 'boostTimePerCharge', 0, 2, 0.01).name('每格气加时长');
  boost.add(P, 'boostImpulse', 0, 20, 0.1).name('小喷瞬间冲量');
  boost.add(P, 'boostAccel', 0, 60, 0.5).name('小喷持续加速');
  boost.add(P, 'chainWindow', 0, 1.5, 0.01).name('连喷衔接窗口');
  boost.add(P, 'chainCarry', 0, 1, 0.01).name('连喷气量结转');

  const terrain = gui.addFolder('高低差 / 腾空');
  terrain.add(P, 'gravity', 5, 60, 0.5).name('重力');
  terrain.add(P, 'slopeDrag', 0, 2, 0.01).name('坡度影响');
  terrain.add(P, 'airControl', 0, 1, 0.01).name('空中转向');
  terrain.add(P, 'landHard', 2, 25, 0.5).name('落地冲击');
  terrain.close();

  const ai = gui.addFolder('AI 对手');
  ai.add(P, 'aiPace', 0.55, 1.15, 0.01).name('AI 速度');
  ai.add(P, 'aiRubberBand', 0, 1, 0.05).name('AI 追赶强度');
  ai.close();

  const cam = gui.addFolder('镜头');
  cam.add(P, 'camDist', 3, 16, 0.1).name('距离');
  cam.add(P, 'camHeight', 0.5, 8, 0.1).name('高度');
  cam.add(P, 'camLookAhead', 0, 20, 0.5).name('前视距离');
  cam.add(P, 'camStiffness', 1, 30, 0.5).name('跟随刚度');
  cam.add(P, 'camFovBase', 40, 100, 1).name('基础 FOV');
  cam.add(P, 'camFovBoost', 0, 30, 0.5).name('加速 FOV 增量');
  cam.add(P, 'camFovSpeed', 0, 30, 0.5).name('速度 FOV 增量');
  cam.add(P, 'camRoll', 0, 0.15, 0.001).name('滚转');
  cam.add(P, 'camShake', 0, 3, 0.05).name('冲刺震动');

  cam.close();
  engine.close();
  steer.close();
  charge.close();
  boost.close();

  const actionsFolder = gui.addFolder('操作');
  actionsFolder.add(actions, 'teleport').name('重新开始 (R)');
  actionsFolder.add(
    {
      reset: () => {
        resetParams();
        gui.controllersRecursive().forEach((c) => c.updateDisplay());
      },
    },
    'reset',
  ).name('恢复默认手感');
  actionsFolder.add(
    {
      copy: () => {
        const json = JSON.stringify(P, null, 2);
        if (navigator.clipboard) navigator.clipboard.writeText(json).catch(() => {});
      },
    },
    'copy',
  ).name('复制当前参数');

  // 默认收起：展开的文件夹会挡住右侧入弯视线，想调再点标题
  gui.close();

  return gui;
}
