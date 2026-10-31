'use strict';
/**
 * Electron 环境自检：图标提取质量 + 程序名读取。
 * 用法：vendor\electron\electron.exe scripts\probe-electron.js
 * 结果同时打印并写入 tmp-test\probe-electron.json（防止窗口程序吞掉控制台输出）
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'tmp-test');
const RESULT = path.join(OUT_DIR, 'probe-electron.json');

function save(obj) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(RESULT, JSON.stringify(obj, null, 2), 'utf8');
  console.log(JSON.stringify(obj, null, 2));
}

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const result = { ok: false, items: [] };
  try {
    const { AppRegistry } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'apps.js'));
    const reg = new AppRegistry({
      file: path.join(OUT_DIR, 'probe-apps.json'),
      iconDir: path.join(OUT_DIR, 'icons'),
    });
    reg.load();

    const targets = [
      'C:\\Windows\\System32\\notepad.exe',
      'E:\\game\\Archvale\\Archvale\\开始游戏.exe',
      'E:\\game\\gtasa\\【2025修复优化版】Grand Theft Auto San Andreas\\gta_sa.exe',
    ];

    for (const exe of targets) {
      if (!fs.existsSync(exe)) {
        result.items.push({ exe, skip: true });
        continue;
      }
      const info = await reg.inspect(exe);
      const added = await reg.add(exe, { name: info.name });
      result.items.push({
        exe,
        name: info.name,
        imageName: info.imageName,
        altNames: info.altNames,
        icon: added.ok ? { file: added.app.iconFile, size: added.app.iconSize, source: added.app.iconSource } : added.reason,
      });
    }
    result.ok = result.items.some((i) => !i.skip && i.icon && i.icon.size >= 64);
  } catch (e) {
    result.error = String((e && e.stack) || e);
  }
  save(result);
  setTimeout(() => app.quit(), 400);
});
