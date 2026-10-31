'use strict';
/**
 * 路径规划：让数据跟着程序文件夹走（绿色版）。
 * 打包后： <程序目录>\data      —— 我们的数据（清单、流水账、设置）
 *          <程序目录>\runtime   —— Chromium 自己的东西（缓存等，可随手删）
 * 开发时： <项目根>\data
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function canWrite(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.w-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (e) {
    return false;
  }
}

function pickBaseDir() {
  // 测试/截图时可以用环境变量把数据目录指到别处，避免污染真实数据
  if (process.env.TS_DATA_DIR) {
    return { base: process.env.TS_DATA_DIR, portable: false };
  }
  const appRoot = app.getAppPath(); // 打包后 = ...\resources\app
  const exeDir = path.dirname(app.getPath('exe'));
  const candidates = [];

  if (app.isPackaged) candidates.push(exeDir);
  // 开发态（electron.exe src）时，exe 目录是 vendor\electron，不能用
  candidates.push(path.join(appRoot, '..', '..'));
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'TimeStats'));
  }

  for (const dir of candidates) {
    if (canWrite(dir)) return { base: dir, portable: dir === exeDir };
  }
  const fallback = path.join(process.env.TEMP || '.', 'TimeStats');
  fs.mkdirSync(fallback, { recursive: true });
  return { base: fallback, portable: false };
}

function initPaths() {
  const { base, portable } = pickBaseDir();
  const dataDir = path.join(base, 'data');
  const runtimeDir = path.join(base, 'runtime');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  // 必须在 whenReady 之前设置，否则 Chromium 会写到 %APPDATA%
  app.setPath('userData', runtimeDir);
  app.setPath('sessionData', path.join(runtimeDir, 'session'));
  app.setPath('crashDumps', path.join(runtimeDir, 'crashes'));

  return {
    base,
    portable,
    dataDir,
    runtimeDir,
    appsFile: path.join(dataDir, 'apps.json'),
    sessionsFile: path.join(dataDir, 'sessions.ndjson'),
    settingsFile: path.join(dataDir, 'settings.json'),
    activeFile: path.join(dataDir, 'active-session.json'),
    iconDir: path.join(dataDir, 'icons'),
    backupDir: path.join(dataDir, 'backup'),
  };
}

module.exports = { initPaths };
