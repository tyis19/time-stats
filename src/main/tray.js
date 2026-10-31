'use strict';
/** 托盘：关掉窗口后还在这里，继续计时 */

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

/** 与主界面统一的时长写法 */
function formatHms(sec) {
  const s = Math.max(0, Math.round(sec));
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分 ' + (s % 60) + ' 秒';
}

function createTray({ getRunning, onOpen, onQuit }) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-32.png');
  const image = nativeImage.createFromPath(iconPath);
  const tray = new Tray(image);

  const refresh = () => {
    const running = getRunning() || [];
    const template = [
      { label: '打开时间统计', click: onOpen },
      { type: 'separator' },
    ];
    if (running.length) {
      template.push({ label: '正在使用', enabled: false });
      for (const r of running) {
        template.push({ label: '　' + r.name + '　' + formatHms(r.elapsedSec), enabled: false });
      }
      template.push({ type: 'separator' });
    } else {
      template.push({ label: '当前没有在统计的软件', enabled: false });
      template.push({ type: 'separator' });
    }
    template.push({ label: '退出', click: onQuit });

    tray.setContextMenu(Menu.buildFromTemplate(template));
    tray.setToolTip(running.length ? '时间统计 · 正在记录 ' + running.length + ' 个' : '时间统计');
  };

  tray.on('click', onOpen);
  tray.on('double-click', onOpen);
  refresh();

  return { tray, refresh, destroy: () => tray.destroy() };
}

module.exports = { createTray };
