'use strict';
/** 验证「启动文件夹快捷方式」机制：能写、能读回、能删（只在临时目录里试，不动真实的启动文件夹） */

const { app, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const dir = path.join(os.tmpdir(), 'ts-shortcut-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, '时间统计.lnk');
  const result = { ok: false };

  try {
    const wrote = shell.writeShortcutLink(link, 'create', {
      target: process.execPath,
      args: '--hidden',
      cwd: path.dirname(process.execPath),
      description: '时间统计测试',
      icon: process.execPath,
      iconIndex: 0,
    });
    result.wrote = wrote;
    result.exists = fs.existsSync(link);

    if (result.exists) {
      const info = shell.readShortcutLink(link);
      result.readBack = { target: info.target, args: info.args, description: info.description };
      result.argsOk = /--hidden/.test(info.args || '');
      result.targetOk = (info.target || '').toLowerCase() === process.execPath.toLowerCase();
    }
    result.ok = !!result.exists && result.argsOk && result.targetOk;
    result.link = link;
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }

  console.log(JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(os.tmpdir(), 'ts-shortcut-result.json'), JSON.stringify(result, null, 2));
  // 不删目录，留给人工核对；这里只是临时目录
  setTimeout(() => app.quit(), 300);
});
