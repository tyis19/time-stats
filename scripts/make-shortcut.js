'use strict';
/** 在桌面创建「时间统计」快捷方式（用 Electron 原生接口，避免 COM） */

const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');

app.disableHardwareAcceleration();

const TARGET = 'E:\\game\\Time Statistics\\dist\\时间统计\\TimeStats.exe';
const ICON = 'E:\\game\\Time Statistics\\dist\\时间统计\\assets\\app.ico';

app.whenReady().then(() => {
  const result = { ok: false };
  try {
    const desktop = app.getPath('desktop');
    const link = path.join(desktop, '时间统计.lnk');
    const ok = shell.writeShortcutLink(link, 'create', {
      target: TARGET,
      cwd: path.dirname(TARGET),
      description: '时间统计 — 记录每个软件用了多久',
      icon: fs.existsSync(ICON) ? ICON : TARGET,
      iconIndex: 0,
    });
    result.wrote = ok;
    result.link = link;
    if (fs.existsSync(link)) {
      const info = shell.readShortcutLink(link);
      result.readBack = { target: info.target, icon: info.icon, description: info.description };
      result.ok = true;
    }
  } catch (e) {
    result.error = String((e && e.message) || e);
  }
  console.log(JSON.stringify(result, null, 2));
  setTimeout(() => app.quit(), 250);
});
