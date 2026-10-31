'use strict';
/**
 * 启动器交接测试（不需要真游戏）：
 * 用记事本复制出 launcher.exe / game.exe，
 * 模拟「启动器退出 → 游戏本体接管」，验证计时不中断。
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tmp-test', 'handover');
const DATA = path.join(OUT, 'data');

// 用 node.exe 当替身：它可移植、能常驻，适合模拟「启动器 / 游戏本体」
function findNode() {
  if (process.env.TS_NODE_EXE) return process.env.TS_NODE_EXE;
  try {
    const out = require('child_process').execFileSync('where', ['node'], { encoding: 'utf8' });
    return out.split(/\r?\n/)[0].trim();
  } catch (e) {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killPid(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

function run(exe, args) {
  const c = spawn(exe, args || [], { detached: true, stdio: 'ignore' });
  c.unref();
  return c;
}

async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return { ok: true, value: v, ms: Date.now() - t0 };
    await sleep(300);
  }
  return { ok: false };
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const result = { ok: false, tests: [] };
  const report = (name, pass, detail) => {
    result.tests.push({ name, pass, detail });
    console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' — ' + JSON.stringify(detail) : ''));
  };

  try {
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });

    const NODE = findNode();
    if (!NODE) throw new Error('找不到 node.exe，无法做交接测试');
    for (const name of ['launcher.exe', 'game.exe']) {
      const dest = path.join(OUT, name);
      try {
        fs.linkSync(NODE, dest); // 硬链接：不额外占空间
      } catch (e) {
        fs.copyFileSync(NODE, dest);
      }
    }

    const { AppRegistry } = require(path.join(ROOT, 'src', 'main', 'services', 'apps.js'));
    const { SessionStore } = require(path.join(ROOT, 'src', 'main', 'services', 'sessions.js'));
    const launcherMod = require(path.join(ROOT, 'src', 'main', 'services', 'launcher.js'));
    const { Tracker } = require(path.join(ROOT, 'src', 'main', 'services', 'tracker.js'));

    const registry = new AppRegistry({ file: path.join(DATA, 'apps.json'), iconDir: path.join(DATA, 'icons') });
    registry.load();
    const added = await registry.add(path.join(OUT, 'launcher.exe'), { name: '测试启动器' });
    if (!added.ok) throw new Error('添加失败: ' + added.reason);

    // 模拟「添加时扫到了同目录的本体」，并让替身常驻
    const appRec = registry.get(added.app.id);
    appRec.altNames = ['game'];
    appRec.args = ['-e', 'setInterval(()=>{}, 1000)'];
    registry.save();

    const sessions = new SessionStore(path.join(DATA, 'sessions.ndjson'));
    sessions.load();

    const settings = {
      autoWatch: false,
      pollActiveMs: 800,
      pollWatchMs: 1500,
      graceTicks: 2,
      startTimeoutMs: 12000,
      launcherQuickExitMs: 60000,
      handoverWindowMs: 15000,
      heartbeatMs: 5000,
      maxSessionMs: 86400000,
    };

    const tracker = new Tracker({
      sessions,
      apps: registry,
      launcher: launcherMod,
      getSettings: () => settings,
      persistActive: () => {},
      readActive: () => [],
    });
    tracker.on('handover', (d) => console.log('→ 进入交接状态:', d.appId));
    tracker.on('handover-done', (d) => console.log('→ 本体接管:', d.process));

    const started = await tracker.start(appRec.id, 'launcher');
    report('1. 启动器已启动', !!started.ok, started);

    const running = await waitFor(() => tracker.snapshot().find((s) => s.state === 'RUNNING'), 12000);
    report('2. 启动器被识别为运行中', running.ok, running.ok ? { afterMs: running.ms } : null);
    const sessionStart = running.ok ? running.value.startedMs : 0;

    await sleep(2500);

    // 启动器退出（真实场景：点完「开始游戏」，启动器自己关掉）
    const pid = started.pid;
    await killPid(pid);
    console.log('→ 已结束启动器进程');
    await sleep(350);
    const game = run(path.join(OUT, 'game.exe'), ['-e', 'setInterval(()=>{}, 1000)']);
    console.log('→ 已启动游戏本体 pid=' + game.pid);

    const handover = await waitFor(() => {
      const s = tracker.snapshot().find((x) => x.state === 'RUNNING');
      return s && s.startedMs === sessionStart ? s : null;
    }, 15000);
    report('3. 本体接管后仍在同一次会话里（没有断成两段）', handover.ok, handover.ok ? { afterMs: handover.ms } : null);

    await sleep(2500);
    await killPid(game.pid);
    const ended = await waitFor(() => !tracker.snapshot().find((s) => s.state === 'RUNNING'), 12000);
    report('4. 本体退出后自动停表', ended.ok, ended.ok ? { afterMs: ended.ms } : null);

    const rows = sessions.forApp(appRec.id);
    report('5. 全程只产生 1 条会话', rows.length === 1, rows.map((r) => ({ sec: r.sec, closedBy: r.closedBy })));
    const sec = rows.length ? rows[0].sec : 0;
    report('6. 总时长包含启动器+本体两个阶段（>4 秒）', sec > 4, { sec });

    tracker.stopTimer();
    result.ok = result.tests.every((t) => t.pass);
    await killPid(game.pid);
  } catch (e) {
    result.error = String((e && e.stack) || e);
    console.log('异常:', result.error);
  }

  fs.writeFileSync(path.join(ROOT, 'tmp-test', 'handover-result.json'), JSON.stringify(result, null, 2));
  console.log('\n总体:', result.ok ? '全部通过' : '有失败项');
  setTimeout(() => app.quit(), 300);
});
