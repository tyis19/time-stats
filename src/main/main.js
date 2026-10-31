'use strict';
/**
 * 主进程入口：装配所有零件。
 * 顺序很重要：先把数据目录定下来（必须在 whenReady 之前），再建窗口。
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, powerMonitor, shell, dialog, protocol } = require('electron');

protocol.registerSchemesAsPrivileged([
  { scheme: 'tsicon', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const { initPaths } = require('./paths');
const PATHS = initPaths();

const { readJson, writeJson } = require('./services/store');
const { logger } = require('./services/logger');
const { AppRegistry } = require('./services/apps');
const { SessionStore } = require('./services/sessions');
const { Tracker } = require('./services/tracker');
const stats = require('./services/stats');
const launcher = require('./services/launcher');
const autolaunch = require('./services/autolaunch');
const { createWindow, currentBounds } = require('./window');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');

const DEFAULTS = {
  schemaVersion: 2,
  autoWatch: false,
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
  debugLog: false,
  closeToTray: true,
  autoLaunch: false,
  sort: 'lastUsed',
  sortDir: 'desc',
  windowBounds: null,
};

let settings = Object.assign({}, DEFAULTS, readJson(PATHS.settingsFile, {}) || {});
const saveSettings = () => {
  try {
    writeJson(PATHS.settingsFile, settings);
  } catch (e) {
    /* 忽略 */
  }
};

/**
 * 老版本的 settings.json 会把「当时的默认值」原样写进文件，
 * 所以光改 DEFAULTS 对已经装过的用户不生效。
 * 这里只升级「还等于旧默认值」的字段——手改过的值不动。
 *   待命轮询 5 秒 → 10 秒（省电，检测晚一点靠开始时间前推补回来）
 *   交接窗口 2 分钟 → 15 秒
 *   心跳 15 秒 → 5 秒（崩溃后少丢时间）
 */
if (!settings.schemaVersion || settings.schemaVersion < 2) {
  if (settings.pollWatchMs === 5000) settings.pollWatchMs = 10000;
  if (settings.handoverWindowMs === 120000) settings.handoverWindowMs = 15000;
  if (settings.heartbeatMs === 15000) settings.heartbeatMs = 5000;
  settings.schemaVersion = 2;
  saveSettings();
}

logger.configure({ dir: PATHS.dataDir, enabled: settings.debugLog });

const registry = new AppRegistry({ file: PATHS.appsFile, iconDir: PATHS.iconDir }).load();
const sessions = new SessionStore(PATHS.sessionsFile).load();

let mainWindow = null;
let tray = null;
let quitting = false;
const hiddenStart = process.argv.includes('--hidden');

const persistActive = () => {
  try {
    writeJson(PATHS.activeFile, { schemaVersion: 1, sessions: tracker.captureActive() });
  } catch (e) {
    /* 忽略 */
  }
};
const readActive = () => {
  const data = readJson(PATHS.activeFile, { sessions: [] });
  return Array.isArray(data.sessions) ? data.sessions : [];
};

const tracker = new Tracker({
  sessions,
  apps: registry,
  launcher,
  getSettings: () => settings,
  persistActive,
  readActive,
});

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getWin() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function showWindow() {
  const win = getWin();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function refreshTray() {
  if (!tray) return;
  const args = new Map(registry.apps.map((a) => [a.id, a.name]));
  const running = tracker.snapshot().map((r) => ({
    name: args.get(r.appId) || '未知软件',
    elapsedSec: r.elapsedSec,
  }));
  tray.refresh(running);
}

function dailyBackup() {
  try {
    const day = stats.dayKey(Date.now());
    const dir = path.join(PATHS.backupDir, day);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      for (const f of [PATHS.appsFile, PATHS.sessionsFile, PATHS.settingsFile]) {
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
      }
      const dirs = fs
        .readdirSync(PATHS.backupDir)
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort();
      while (dirs.length > 7) {
        const old = dirs.shift();
        fs.rmSync(path.join(PATHS.backupDir, old), { recursive: true, force: true });
      }
    }
  } catch (e) {
    /* 备份失败不影响使用 */
  }
}

tracker.on('update', () => {
  broadcast('tracker:update', tracker.snapshot());
});

tracker.on('session-started', (d) => {
  broadcast('tracker:event', { type: 'started', appId: d.appId });
  refreshTray();
});

tracker.on('session-ended', (row) => {
  broadcast('tracker:event', { type: 'ended', appId: row.appId, row });
  broadcast('apps:changed');
  refreshTray();
});

tracker.on('launch-failed', (d) => {
  broadcast('tracker:event', { type: 'launch-failed', appId: d.appId });
  refreshTray();
});

app.on('second-instance', () => {
  showWindow();
});

app.whenReady().then(async () => {
  dailyBackup();

  // 图标走自定义协议：tsicon://icon/xxx.png（不把磁盘路径暴露给页面）
  protocol.handle('tsicon', (request) => {
    try {
      const u = new URL(request.url);
      const file = path.basename(decodeURIComponent(u.pathname));
      const full = path.join(PATHS.iconDir, file);
      if (!full.startsWith(PATHS.iconDir) || !fs.existsSync(full)) {
        return new Response('', { status: 404 });
      }
      return new Response(fs.readFileSync(full), { headers: { 'Content-Type': 'image/png' } });
    } catch (e) {
      return new Response('', { status: 500 });
    }
  });

  registerIpc({
    getWin,
    settings,
    saveSettings,
    registry,
    sessions,
    tracker,
    paths: PATHS,
    broadcast,
  });

  mainWindow = createWindow({
    settings,
    onClose: () => {
      if (quitting) return true;
      if (settings.closeToTray) {
        mainWindow.hide();
        return false; // 阻止关闭，缩到托盘继续计时
      }
      quitting = true;
      tracker.stopAll('shutdown');
      settings.windowBounds = currentBounds(mainWindow);
      saveSettings();
      return true;
    },
  });

  mainWindow.once('ready-to-show', () => {
    if (!hiddenStart) mainWindow.show();
  });

  try {
    tray = createTray({
      getRunning: () => {
        const names = new Map(registry.apps.map((a) => [a.id, a.name]));
        return tracker.snapshot().map((r) => ({
          name: names.get(r.appId) || '未知软件',
          elapsedSec: r.elapsedSec,
        }));
      },
      onOpen: showWindow,
      onQuit: () => {
        quitting = true;
        app.quit();
      },
    });
  } catch (e) {
    /* 托盘失败不影响主窗口 */
  }

  // 恢复上次没关掉的会话
  try {
    const rec = await tracker.recover();
    if (rec.resumed || rec.closed) {
      broadcast('tracker:event', { type: 'recovered', resumed: rec.resumed, closed: rec.closed });
    }
  } catch (e) {
    /* 忽略 */
  }

  // 关键：开机启动时如果「自动监视」是开着的，必须把后台巡检叫醒
  try {
    if (settings.autoWatch) await tracker.resetBaseline();
    else tracker.ensureTimer();
  } catch (e) {
    /* 忽略 */
  }

  powerMonitor.on('suspend', () => tracker.onSuspend());
  powerMonitor.on('resume', () => tracker.onResume());
  powerMonitor.on('lock-screen', () => tracker.stopTimer());
  powerMonitor.on('unlock-screen', () => tracker.ensureTimer());

  // 文件夹被搬走后自动修好开机自启的快捷方式
  try {
    autolaunch.heal();
  } catch (e) {
    /* 忽略 */
  }

  // 每秒刷新一次托盘上的计时
  setInterval(() => {
    if (tracker.snapshot().length) refreshTray();
  }, 60000);

  // 调试用：--shot 或 --shot=stats/settings/detail，截图后自动退出
  const shotArg = process.argv.find((a) => a.startsWith('--shot'));
  if (shotArg) {
    setTimeout(async () => {
      try {
        const view = shotArg.includes('=') ? shotArg.split('=')[1] : 'library';
        if (view === 'detail') {
          await mainWindow.webContents.executeJavaScript('Detail.open(App.state.apps[0].id)');
        } else if (view !== 'library') {
          await mainWindow.webContents.executeJavaScript('App.setView(' + JSON.stringify(view) + ')');
        }
        const scrollArg = process.argv.find((a) => a.startsWith('--scroll='));
        if (scrollArg) {
          const top = Number(scrollArg.split('=')[1]) || 0;
          await new Promise((r) => setTimeout(r, 700));
          await mainWindow.webContents.executeJavaScript(
            'document.getElementById("content").scrollTop = ' + top
          );
        }
        await new Promise((r) => setTimeout(r, 1400));
        const img = await mainWindow.webContents.capturePage();
        const outDir = process.env.TS_SHOT_DIR || path.join(require('os').tmpdir(), 'ts-shots');
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(path.join(outDir, 'shot-' + view + '.png'), img.toPNG());
      } catch (e) {
        try {
          fs.appendFileSync(path.join(require('os').tmpdir(), 'ts-shots-error.log'), String(e && e.stack) + '\n');
        } catch (e2) {
          /* 忽略 */
        }
      }
      quitting = true;
      app.quit();
    }, 1800);
  }
});

app.on('before-quit', () => {
  quitting = true;
  try {
    tracker.stopAll('shutdown');
  } catch (e) {
    /* 忽略 */
  }
  settings.windowBounds = currentBounds(mainWindow);
  saveSettings();
});

app.on('window-all-closed', () => {
  if (!settings.closeToTray) app.quit();
});

process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(PATHS.dataDir, 'error.log'), '[' + new Date().toISOString() + '] ' + (err.stack || err) + '\n');
  } catch (e) {
    /* 忽略 */
  }
});
