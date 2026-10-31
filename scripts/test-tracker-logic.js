'use strict';
/**
 * 计时状态机逻辑测试（不需要启动真实程序，用假进程表 + 假时间驱动）
 *   1. 进程表解析：进程号要带上名字
 *   2. 去抖：进程活够门槛才算数，一闪而过不留记录
 *   3. 正常结束：进程消失后连续几次没看到才结账
 *   4. 中断扣除：两次检查间隔过大时，那段时间不计入时长
 *   5. 防 PID 复用：进程号相同但名字变了，不能认为还活着
 *   6. 同目录交接：启动器退出后，同目录的本体进程顶上来
 *
 * 用法：node scripts/test-tracker-logic.js
 * （真机跑记事本的集成测试在 scripts/test-tracker.js，需要 electron 运行环境）
 */

/* ------------------------- 假时间 ------------------------- */

let NOW = 1000000;
const realNow = Date.now;
Date.now = () => NOW;

/* ------------------------- 假进程表 ------------------------- */

let procs = []; // [{ name, pid }]

function buildSnap() {
  const byName = new Map();
  const byPid = new Map();
  for (const p of procs) {
    const key = String(p.name).replace(/\.exe$/i, '').trim().toLowerCase();
    byPid.set(p.pid, key);
    let set = byName.get(key);
    if (!set) {
      set = new Set();
      byName.set(key, set);
    }
    set.add(p.pid);
  }
  return { byName, byPid, count: byPid.size, at: NOW, error: null, costMs: 1 };
}

// 只替换 scan，保留真实的 normalizeName / pidMatches（这两个正是要测的）
const scanMod = require('../src/main/services/process-scan');
scanMod.scan = async () => buildSnap();

// 进程详情要调 PowerShell，测试里换成假的（同目录探测返回空，交接靠 altNames）
const pdPath = require.resolve('../src/main/services/process-detail');
require.cache[pdPath] = {
  id: pdPath,
  filename: pdPath,
  loaded: true,
  exports: {
    namesInDir: async () => [],
    pathsFor: async () => new Map(),
    pidInDir: async () => null,
    allProcesses: async () => [],
    clearCache: () => {},
  },
};

const { Tracker, STATE } = require('../src/main/services/tracker');

/* ------------------------- 小工具 ------------------------- */

let pass = 0;
let fail = 0;

function check(cond, label, extra) {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + label);
  } else {
    fail++;
    console.log('  \u2717 ' + label + (extra !== undefined ? '   → ' + JSON.stringify(extra) : ''));
  }
}

function makeTracker(overrides) {
  const app = {
    id: 'a1',
    name: '测试游戏',
    imageName: 'game',
    altNames: ['launcher'],
    workDir: 'D:\\Games\\Test',
  };
  const settings = Object.assign(
    {
      autoWatch: true,
      pollActiveMs: 3000,
      pollWatchMs: 10000,
      graceTicks: 3,
      startTimeoutMs: 30000,
      launcherQuickExitMs: 60000,
      handoverWindowMs: 15000,
      heartbeatMs: 5000,
      maxSessionMs: 86400000,
      debounceMs: 5000,
      stallMs: 20000,
      stallBreakMs: 300000,
    },
    overrides || {}
  );
  const rows = [];
  const tracker = new Tracker({
    sessions: {
      append: (row) => {
        const full = Object.assign({ id: 's' + (rows.length + 1) }, row);
        rows.push(full);
        return full;
      },
    },
    apps: {
      list: () => [app],
      get: (id) => (id === 'a1' ? app : null),
    },
    launcher: { launch: async () => ({ ok: false, reason: '测试里不启动' }), killTree: async () => {} },
    getSettings: () => settings,
    persistActive: () => {},
    readActive: () => [],
  });
  return { tracker, rows, app, settings };
}

async function step(tracker, ms) {
  NOW += ms || 0;
  await tracker.tick();
  tracker.stopTimer(); // 别让真实定时器插进来
}

function stateOf(tracker) {
  const r = tracker.runtimes.get('a1');
  return r ? r.state : 'MISSING';
}

function rt(tracker) {
  return tracker.runtimes.get('a1');
}

/* ------------------------- 1. 进程表解析 ------------------------- */

function testParse() {
  console.log('\n=== 1. 进程表解析：进程号要带上名字 ===');
  const { parseTasklistBuffer, pidMatches } = require('../src/main/services/process-scan');
  const csv = '"game.exe","1234","Console","1","8,656 K"\r\n"other.exe","5678","Console","1","1,234 K"\r\n';
  const snap = parseTasklistBuffer(Buffer.from(csv, 'utf8'));

  check(snap.count === 2, '解析出 2 个进程', snap.count);
  check(snap.byPid.get(1234) === 'game', '进程号 1234 记得住名字 game', snap.byPid.get(1234));
  check(snap.byPid.get(5678) === 'other', '进程号 5678 记得住名字 other', snap.byPid.get(5678));
  check(pidMatches(snap, 1234, 'game') === true, '号 + 名都对 → 活着');
  check(pidMatches(snap, 1234, 'other') === false, '号对但名不对 → 不算');
  check(pidMatches(snap, 9999, 'game') === false, '号不存在 → 不算');
  check(snap.byName.get('game').has(1234), '按名字查进程号仍然可用');
}

/* ------------------------- 2. 去抖 ------------------------- */

async function testDebounce() {
  console.log('\n=== 2. 去抖：进程要活够 5 秒才算数 ===');
  procs = [];
  NOW = 1000000;
  const { tracker, rows } = makeTracker();

  await step(tracker, 0);
  check(stateOf(tracker) === 'MISSING' || stateOf(tracker) === 'IDLE', '一开始没有任何会话');

  procs = [{ name: 'game.exe', pid: 1234 }];
  await step(tracker, 0);
  check(stateOf(tracker) === STATE.CANDIDATE, '刚看到进程只进候选，不立刻计时', stateOf(tracker));
  check(tracker.snapshot().length === 0, '候选状态不显示到界面上（避免闪一下）');

  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.CANDIDATE, '过了 3 秒还在观察（门槛 5 秒）', stateOf(tracker));
  check(rows.length === 0, '观察期不产生任何记录');

  await step(tracker, 2500);
  check(stateOf(tracker) === STATE.RUNNING, '累计 5.5 秒后正式开始计时', stateOf(tracker));

  const r = rt(tracker);
  check(r.startedMs === 1000000, '开始时间取「第一次看到进程」的时刻，不丢观察期', r.startedMs);
  check(tracker.snapshot().length === 1, '界面上能看到这个会话了');
  check(tracker.snapshot()[0].elapsedSec === 6, '界面显示已计时 6 秒（含观察期）', tracker.snapshot()[0]);
}

/* ------------------------- 3. 一闪而过 ------------------------- */

async function testFlicker() {
  console.log('\n=== 3. 一闪而过：不留垃圾记录 ===');
  procs = [];
  NOW = 2000000;
  const { tracker, rows } = makeTracker();
  await step(tracker, 0); // 建立基线：此刻什么都没有在跑

  procs = [{ name: 'game.exe', pid: 2001 }];
  await step(tracker, 0);
  check(stateOf(tracker) === STATE.CANDIDATE, '进程出现，进入观察');

  await step(tracker, 2000);
  procs = [];
  await step(tracker, 0);

  check(stateOf(tracker) === STATE.IDLE, '观察期内就消失了，直接放弃', stateOf(tracker));
  check(rows.length === 0, '没有留下任何记录', rows.length);
}

/* ------------------------- 4. 正常结束 ------------------------- */

async function testNormalEnd() {
  console.log('\n=== 4. 正常结束：连续 3 次没看到才结账 ===');
  procs = [];
  NOW = 3000000;
  const { tracker, rows } = makeTracker();
  await step(tracker, 0); // 建立基线

  procs = [{ name: 'game.exe', pid: 3001 }];
  await step(tracker, 0);
  await step(tracker, 6000);
  check(stateOf(tracker) === STATE.RUNNING, '正常进入计时');

  await step(tracker, 60000);
  check(stateOf(tracker) === STATE.RUNNING, '游戏还在跑，继续计时');

  procs = [];
  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.RUNNING, '刚消失一次，先不结账（防抖动）', stateOf(tracker));
  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.RUNNING, '第二次没看到，再等一轮', stateOf(tracker));
  await step(tracker, 3000);

  check(stateOf(tracker) === STATE.IDLE, '第三次确认消失，结账', stateOf(tracker));
  check(rows.length === 1, '只留下一条记录', rows.length);

  if (rows[0]) {
    const sec = Math.round((rows[0].endMs - rows[0].startMs) / 1000);
    check(sec >= 66 && sec <= 70, '时长约 67 秒（结束时间取最后看到 + 半个周期）', sec);
    check(rows[0].closedBy === 'normal', '结束原因标记为正常');
  }
}

/* ------------------------- 5. 中断扣除 ------------------------- */

async function testStall() {
  console.log('\n=== 5. 中断扣除：检查卡住的那段时间不算钱 ===');
  procs = [];
  NOW = 4000000;
  const { tracker, rows } = makeTracker();
  await step(tracker, 0); // 建立基线

  procs = [{ name: 'game.exe', pid: 4001 }];
  await step(tracker, 0);
  await step(tracker, 6000);
  check(stateOf(tracker) === STATE.RUNNING, '开始计时');

  const before = tracker.snapshot()[0].elapsedSec;
  await step(tracker, 25000); // 超过 20 秒的卡顿
  const after = tracker.snapshot()[0].elapsedSec;
  const r = rt(tracker);

  check(r.gapMs === 25000, '25 秒的卡顿全部记入「扣除」而不是时长', r.gapMs);
  check(after - before <= 1, '有效时长没有因为卡顿凭空多出 25 秒', { before, after });
  check(rows.length === 0, '会话没有被打断成两条', rows.length);
}

/* ------------------------- 6. 防 PID 复用 ------------------------- */

async function testPidReuse() {
  console.log('\n=== 6. 防 PID 复用：进程号相同但换了人，不能算还活着 ===');
  procs = [];
  NOW = 5000000;
  const { tracker } = makeTracker();
  await step(tracker, 0); // 建立基线

  procs = [{ name: 'game.exe', pid: 5001 }];
  await step(tracker, 0);
  await step(tracker, 6000);
  check(stateOf(tracker) === STATE.RUNNING, '开始计时');

  // 跑够 70 秒：这样它就不符合「启动器一闪而过」的特征了
  await step(tracker, 70000);
  check(stateOf(tracker) === STATE.RUNNING, '已经稳定运行 76 秒');

  // 模拟：进程号 5001 被系统回收，分给了另一个程序
  procs = [{ name: 'other.exe', pid: 5001 }];
  const snap = buildSnap();
  const { pidMatches } = require('../src/main/services/process-scan');
  check(pidMatches(snap, 5001, 'game') === false, '同一个进程号，名字对不上 → 判定不是它');
  check(pidMatches(snap, 5001, 'other') === true, '名字对得上才算同一个人');

  await step(tracker, 3000);
  await step(tracker, 3000);
  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.IDLE, '名字变了，按「已退出」处理并结账', stateOf(tracker));
}

/* ------------------------- 7. 同目录交接 ------------------------- */

async function testHandover() {
  console.log('\n=== 7. 同目录交接：启动器退出，本体顶上来 ===');
  procs = [];
  NOW = 6000000;
  const { tracker, rows } = makeTracker();
  await step(tracker, 0); // 建立基线

  procs = [{ name: 'game.exe', pid: 6001 }];
  await step(tracker, 0);
  await step(tracker, 6000);
  check(stateOf(tracker) === STATE.RUNNING, '启动器进程开始计时');

  await step(tracker, 50000); // 跑了约 56 秒（小于 60 秒的「像启动器」阈值）
  check(stateOf(tracker) === STATE.RUNNING, '还在计时');

  // 启动器退出，同目录的本体进程起来
  procs = [{ name: 'launcher.exe', pid: 6002 }];
  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.HANDOVER, '主进程提前退出 → 进入交接等待', stateOf(tracker));
  check(rows.length === 0, '交接期间不结账，不会产生两条记录', rows.length);

  await step(tracker, 3000);
  check(stateOf(tracker) === STATE.RUNNING, '同目录的候选进程出现，交接成功', stateOf(tracker));
  check(rt(tracker).primary === 'launcher', '改盯真正的游戏本体进程', rt(tracker).primary);

  await step(tracker, 30000);
  procs = [];
  await step(tracker, 3000);
  await step(tracker, 3000);
  await step(tracker, 3000);

  check(rows.length === 1, '整个「启动器→本体」只算一次使用', rows.length);
  if (rows[0]) {
    const sec = Math.round((rows[0].endMs - rows[0].startMs) / 1000);
    check(sec > 80, '时长把交接前后连起来算了，没有断成两段', sec);
  }
}

/* ------------------------- 跑起来 ------------------------- */

(async () => {
  testParse();
  await testDebounce();
  await testFlicker();
  await testNormalEnd();
  await testStall();
  await testPidReuse();
  await testHandover();

  Date.now = realNow;

  console.log('\n' + '-'.repeat(46));
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) {
    console.log('有项目没通过，先别打包。');
    process.exit(1);
  }
  console.log('\u2713 计时状态机全部通过');
  process.exit(0);
})();
