'use strict';
/**
 * 开机自启：不写注册表，只在「启动」文件夹放一个快捷方式。
 * 好处：杀软/管家对注册表 Run 项最敏感，对「放个快捷方式」宽容得多；
 *       用户自己也能在启动文件夹里看到、随手删掉。
 */

const fs = require('fs');
const path = require('path');
const { app, shell } = require('electron');

const LINK_NAME = '时间统计.lnk';

function startupDir() {
  return path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function linkPath() {
  return path.join(startupDir(), LINK_NAME);
}

function targetExe() {
  return app.getPath('exe');
}

function isEnabled() {
  try {
    return fs.existsSync(linkPath());
  } catch (e) {
    return false;
  }
}

function writeLink(exe) {
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    return shell.writeShortcutLink(linkPath(), 'create', {
      target: exe,
      args: '--hidden',
      cwd: path.dirname(exe),
      description: '时间统计 — 后台记录软件使用时长',
      icon: exe,
      iconIndex: 0,
    });
  } catch (e) {
    return false;
  }
}

function enable() {
  if (!app.isPackaged) {
    return { ok: false, reason: '开发模式下不注册开机自启（打包后才可用）' };
  }
  const ok = writeLink(targetExe());
  return { ok, enabled: isEnabled(), reason: ok ? '' : '写入快捷方式失败，可能被安全软件拦截' };
}

function disable() {
  try {
    if (fs.existsSync(linkPath())) fs.unlinkSync(linkPath());
    return { ok: true, enabled: false };
  } catch (e) {
    return { ok: false, enabled: isEnabled(), reason: '删除快捷方式失败：' + e.message };
  }
}

function setEnabled(on) {
  return on ? enable() : disable();
}

/** 文件夹被搬走后，快捷方式指向会失效 → 悄悄修好 */
function heal() {
  if (!app.isPackaged) return { healed: false };
  try {
    if (!isEnabled()) return { healed: false };
    const link = shell.readShortcutLink(linkPath());
    const want = targetExe();
    const cur = (link && link.target) || '';
    if (cur.toLowerCase() !== want.toLowerCase() || !/--hidden/.test(link.args || '')) {
      writeLink(want);
      return { healed: true };
    }
  } catch (e) {
    writeLink(targetExe());
    return { healed: true };
  }
  return { healed: false };
}

function openStartupFolder() {
  try {
    fs.mkdirSync(startupDir(), { recursive: true });
    shell.openPath(startupDir());
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

/** 桌面快捷方式（中文显示名 + 自定义图标） */
function createDesktopShortcut() {
  if (!app.isPackaged) return { ok: false, reason: '打包后才可用' };
  const desktop = app.getPath('desktop');
  const file = path.join(desktop, '时间统计.lnk');
  const iconPath = path.join(path.dirname(app.getPath('exe')), 'assets', 'app.ico');
  const ok = shell.writeShortcutLink(file, 'create', {
    target: targetExe(),
    cwd: path.dirname(targetExe()),
    description: '时间统计 — 记录每个软件用了多久',
    icon: fs.existsSync(iconPath) ? iconPath : targetExe(),
    iconIndex: 0,
  });
  return { ok, path: file };
}

module.exports = { isEnabled, enable, disable, setEnabled, heal, openStartupFolder, createDesktopShortcut, linkPath };
