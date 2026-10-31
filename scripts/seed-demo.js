'use strict';
/** 造一批演示数据（只写到 TS_DATA_DIR 指定的临时目录，不碰真实数据） */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_ROOT = process.env.TS_DATA_DIR || path.join(ROOT, 'tmp-test', 'demo');
const DATA = path.join(DATA_ROOT, 'data'); // 与程序实际使用的目录保持一致

const TARGETS = [
  'C:\\Windows\\System32\\notepad.exe',
  'E:\\game\\Archvale\\Archvale\\开始游戏.exe',
  'E:\\game\\gtasa\\【2025修复优化版】Grand Theft Auto San Andreas\\gta_sa.exe',
  'E:\\game\\Elin.Beta.22.14-94979\\Elin.Beta.22.14\\Elin.exe',
];

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    fs.rmSync(DATA, { recursive: true, force: true });
    fs.mkdirSync(DATA, { recursive: true });

    const { AppRegistry } = require(path.join(ROOT, 'src', 'main', 'services', 'apps.js'));
    const { SessionStore } = require(path.join(ROOT, 'src', 'main', 'services', 'sessions.js'));

    const reg = new AppRegistry({ file: path.join(DATA, 'apps.json'), iconDir: path.join(DATA, 'icons') });
    reg.load();

    const ids = [];
    for (const exe of TARGETS) {
      if (!fs.existsSync(exe)) continue;
      const r = await reg.add(exe);
      if (r.ok) ids.push(r.app.id);
      console.log('添加:', exe, r.ok ? 'OK' : r.reason);
    }

    const sessions = new SessionStore(path.join(DATA, 'sessions.ndjson'));
    sessions.load();

    const dayStart = (offset) => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset).getTime();
    };
    const H = 3600000;
    let seed = 20261031;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // 每个软件在过去 14 天里，随机挑几天玩
    for (let i = 0; i < ids.length; i++) {
      const appId = ids[i];
      for (let d = -13; d <= 0; d++) {
        const chance = i === 0 ? 0.55 : 0.4;
        if (rnd() > chance) continue;
        const startH = 9 + Math.floor(rnd() * 9);
        const start = dayStart(d) + startH * H + Math.floor(rnd() * 50) * 60000;
        const durMin = 15 + Math.floor(rnd() * 85);
        const end = start + durMin * 60000;
        sessions.append({
          appId,
          startMs: start,
          endMs: end,
          gapMs: 0,
          source: rnd() > 0.35 ? 'launcher' : 'autowatch',
          closedBy: 'normal',
        });
      }
    }

    // 一条跨天记录：昨晚 22:40 玩到今天 02:10
    if (ids[1]) {
      sessions.append({
        appId: ids[1],
        startMs: dayStart(-1) + 22 * H + 40 * 60000,
        endMs: dayStart(0) + 2 * H + 10 * 60000,
        gapMs: 0,
        source: 'launcher',
        closedBy: 'normal',
      });
    }

    // 一条含休眠的记录：中午玩了 2 小时，其中 40 分钟电脑睡眠
    if (ids[2]) {
      sessions.append({
        appId: ids[2],
        startMs: dayStart(0) + 12 * H + 10 * 60000,
        endMs: dayStart(0) + 14 * H + 10 * 60000,
        gapMs: 40 * 60000,
        source: 'launcher',
        closedBy: 'normal',
      });
    }

    fs.writeFileSync(
      path.join(DATA, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, closeToTray: true, autoWatch: true, sort: 'lastUsed' }, null, 2)
    );

    console.log('演示数据生成完毕:', DATA, '| 软件', ids.length, '| 记录', sessions.all().length);
  } catch (e) {
    console.error('生成失败:', (e && e.stack) || e);
  }
  setTimeout(() => app.quit(), 300);
});
