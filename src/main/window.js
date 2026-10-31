'use strict';
/**
 * 主窗口：无边框 + 系统按钮浮在右上角（titleBarOverlay），深色标题栏。
 */

const path = require('path');
const { BrowserWindow, nativeImage } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');

function createWindow({ settings, onClose }) {
  const bounds = settings.windowBounds || {};
  const iconPath = path.join(ASSETS, 'icon-256.png');

  const win = new BrowserWindow({
    width: bounds.width || 1180,
    height: bounds.height || 760,
    x: Number.isFinite(bounds.x) ? bounds.x : undefined,
    y: Number.isFinite(bounds.y) ? bounds.y : undefined,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#171a21',
    title: '时间统计',
    icon: iconPath,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#171a21',
      symbolColor: '#c7d5e0',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (bounds.maximized) win.maximize();

  win.on('close', (e) => {
    if (onClose && onClose(e, win) === false) e.preventDefault();
  });

  win.on('closed', () => {});

  return win;
}

function currentBounds(win) {
  if (!win || win.isDestroyed()) return null;
  const b = win.getNormalBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

module.exports = { createWindow, currentBounds };
