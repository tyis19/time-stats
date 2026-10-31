'use strict';
/**
 * 计时核心集成测试（真机跑记事本）
 * 用法：vendor\electron\electron.exe scripts\test-app
 * 结果写入 tmp-test\tracker-result.json
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tmp-test');
const DATA = path.join(OUT, 'tracker-data');
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';

function killNotepad() {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/IM', 'notepad.exe', '/F'], { windowsHide: true }, () => resolve());
  });
}

function spawnNotepad() {
  const c = spawn(NOTEPAD, [], { detached: true, stdio: 'ignore' });
  c.unref();
  return c;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(fn, timeoutMs, stepMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = await fn();
    if (v) return { ok: true, value: v, ms: Date.now() - t0 };
    await sleep(stepMs || 300);
  }
  return { ok: false, ms: Date.now() - t0 };
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const result = { ok: false, tests: [] };
  const report = (name, pass, detail) => {
    result.tests.push({ name, pass, detail });
    console.log((pass ? '[通过] ' : '[失败] ') + name + (detail ? ' — ' + JSON.stringify(detail) : ''));
  };

  try {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });

    const { AppRegistry } = require(path.join(ROOT, 'src', 'main', 'services', 'apps.js'));
    const { SessionStore } = require(path.join(ROOT, 'src', 'main', 'services', 'sessions.js'));
    const launcher = require(path.join(ROOT, 'src', 'main', 'services', 'launcher.js'));
    const { Tracker } = require(path.join(ROOT, 'src', 'main', 'services', 'tracker.js'));

    const registry = new AppRegistry({ file: path.join(DATA, 'apps.json'), iconDir: path.join(DATA, 'icons') });
    registry.load();
    const added = await registry.add(NOTEPAD, { name: '记事本' });
    if (!added.ok) throw new Error('添加记事本失败: ' + added.reason);
    const appId = added.app.id;

    const sessions = new SessionStore(path.join(DATA, 'sessions.ndjson'));
    sessions.load();

    const settings = {
      autoWatch: false,
      pollActiveMs: 1000,
      pollWatchMs: 1500,
      graceTicks: 2,
      startTimeoutMs: 12000,
      launcherQuickExitMs: 60000,
      handoverWindowMs: 60000,
      heartbeatMs: 5000,
      maxSessionMs: 86400000,
    };

    const tracker = new Tracker({
      sessions,
      apps: registry,
      launcher,
      getSettings: () => settings,
      persistActive: () => {},
      readActive: () => [],
    });
    tracker.on('tracker-error', (e) => console.log('tracker-error:', e.message));
    tracker.on('handover', (d) => console.log('handover:', d.appId));

    await killNotepad();
    await sleep(600);

    /* ---------- 测试 1：从工具启动 → 自动开始 → 关闭后自动停表 ---------- */
    const started = await tracker.start(appId, 'launcher');
    report('1.1 启动记事本', !!started.ok, started);

    const sawRunning = await waitFor(() => tracker.snapshot().find((s) => s.appId === appId && s.state === 'RUNNING'), 12000);
    report('1.2 自动识别为「正在使用」', sawRunning.ok, sawRunning.ok ? { afterMs: sawRunning.ms } : null);
    const runningAt = Date.now();

    await sleep(4000);
    const snapBeforeKill = tracker.snapshot().find((s) => s.appId === appId);
    report('1.3 计时秒数在增长', !!snapBeforeKill && snapBeforeKill.elapsedSec >= 3, snapBeforeKill);

    await killNotepad();
    const killedAt = Date.now();
    const sawEnded = await waitFor(() => tracker.snapshot().find((s) => s.appId === appId) === undefined, 15000);
    report('1.4 关闭后自动停表', sawEnded.ok, { afterMs: Date.now() - killedAt });

    const rows = sessions.forApp(appId);
    const row = rows[rows.length - 1];
    const expected = (killedAt - runningAt) / 1000;
    report('1.5 生成了一条会话记录', rows.length === 1, row ? { sec: row.sec, closedBy: row.closedBy, start: row.start, end: row.end } : null);
    report(
      '1.6 时长误差 < 4 秒',
      !!row && Math.abs(row.sec - expected) < 4,
      row ? { 记录秒数: row.sec, 实测秒数: Math.round(expected) } : null
    );
    report('1.7 结束原因正确', !!row && row.closedBy === 'normal', row ? row.closedBy : null);

    /* ---------- 测试 2：自动监视（从别处启动也能抓到） ---------- */
    settings.autoWatch = true;
    await tracker.resetBaseline();
    report('2.1 基线：当前没有记事本在跑', !tracker.snapshot().some((s) => s.appId === appId));

    spawnNotepad();
    const autoStart = await waitFor(() => tracker.snapshot().find((s) => s.appId === appId && s.source === 'autowatch' && s.state === 'RUNNING'), 15000);
    report('2.2 手动打开的记事本被自动抓到', autoStart.ok, autoStart.ok ? { afterMs: autoStart.ms } : null);

    await sleep(2500);

    /* ---------- 测试 3：手动停表后不被立刻重新计时 ---------- */
    const beforeStop = sessions.forApp(appId).length;
    await tracker.stop(appId);
    const afterStop = tracker.snapshot().find((s) => s.appId === appId);
    report('3.1 手动停表后处于「抑制」状态', !!afterStop && afterStop.state === 'SUPPRESSED', afterStop ? afterStop.state : '没有运行时');
    report('3.2 停表立即记了一条', sessions.forApp(appId).length === beforeStop + 1, { before: beforeStop, after: sessions.forApp(appId).length });

    await sleep(3000);
    const stillSuppressed = tracker.snapshot().find((s) => s.appId === appId);
    report('3.3 进程还在跑，但不会重新开始计时', !!stillSuppressed && stillSuppressed.state === 'SUPPRESSED', stillSuppressed ? stillSuppressed.state : '错误：又被计时了');

    await killNotepad();
    const cleared = await waitFor(() => !tracker.snapshot().find((s) => s.appId === appId), 12000);
    report('3.4 进程退出后解除抑制', cleared.ok);

    tracker.stopTimer();
    result.ok = result.tests.every((t) => t.pass);
  } catch (e) {
    result.error = String((e && e.stack) || e);
    console.log('异常:', result.error);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'tracker-result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('\n总体:', result.ok ? '全部通过' : '有失败项');
  setTimeout(() => app.quit(), 300);
});
