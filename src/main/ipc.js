'use strict';
/** 前后台通道：界面能做什么，全部在这里登记 */

const fs = require('fs');
const path = require('path');
const { ipcMain, dialog, shell, app } = require('electron');
const stats = require('./services/stats');
const autolaunch = require('./services/autolaunch');
const { normalizeTagIds, applyTagMembers, stripTagFromApps } = require('./services/tags');
const { logger } = require('./services/logger');

function pad(n) {
  return String(n).padStart(2, '0');
}

function humanTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 与界面完全一致的时长写法（导出表格用） */
function fmtHms(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分 ' + (s % 60) + ' 秒';
}

function registerIpc(ctx) {
  const { getWin, settings, saveSettings, registry, tags, sessions, tracker, paths, broadcast } = ctx;

  /**
   * 软件编号 → 软件。
   * 顺带把「查不到对应标签」的孤儿编号过滤掉（比如 tags.json 被误删过），
   * 这样界面和统计都不会被不存在的标签带偏；软件里的原始编号不动，找回 tags.json 就恢复。
   */
  const appMap = () => {
    const known = new Set(tags.list().map((t) => t.id));
    const map = new Map();
    for (const a of registry.apps) {
      map.set(a.id, Object.assign({}, a, { tagIds: (a.tagIds || []).filter((id) => known.has(id)) }));
    }
    return map;
  };

  const pickedTags = (p) => (Array.isArray(p && p.tagIds) ? p.tagIds.filter((x) => typeof x === 'string') : []);

  const filterRows = (rows, map, selected) => {
    if (!selected.length) return rows;
    return rows.filter((r) => stats.matchesTags(map.get(r.appId), selected));
  };

  const broadcastTags = () => broadcast('tags:changed');

  /* ------------------------------- 软件库 ------------------------------- */

  ipcMain.handle('apps:list', async () => {
    const now = Date.now();
    const dayStart = stats.startOfDay(now);
    const dayEnd = stats.addDays(dayStart, 1);
    const weekStart = stats.startOfWeek(now);
    const monthStart = stats.startOfMonth(now);
    const rows = sessions.all();

    const agg = new Map();
    for (const s of rows) {
      let a = agg.get(s.appId);
      if (!a) {
        a = { totalSec: 0, todaySec: 0, weekSec: 0, monthSec: 0, sessionCount: 0, lastUsedMs: 0 };
        agg.set(s.appId, a);
      }
      a.totalSec += stats.effSecInRange(s, 0, Number.MAX_SAFE_INTEGER);
      a.sessionCount++;
      a.lastUsedMs = Math.max(a.lastUsedMs, s.endMs || 0);
      a.todaySec += stats.effSecInRange(s, dayStart, dayEnd);
      a.weekSec += stats.effSecInRange(s, weekStart, dayEnd);
      a.monthSec += stats.effSecInRange(s, monthStart, dayEnd);
    }

    const running = new Map(tracker.snapshot().map((r) => [r.appId, r]));

    return registry.list().map((a) => {
      const st = agg.get(a.id) || { totalSec: 0, todaySec: 0, weekSec: 0, monthSec: 0, sessionCount: 0, lastUsedMs: 0 };
      return Object.assign({}, a, {
        stats: {
          totalSec: Math.round(st.totalSec),
          todaySec: Math.round(st.todaySec),
          weekSec: Math.round(st.weekSec),
          monthSec: Math.round(st.monthSec),
          sessionCount: st.sessionCount,
          lastUsedMs: st.lastUsedMs || null,
        },
        running: running.get(a.id) || null,
        exists: fs.existsSync(a.exePath),
      });
    });
  });

  ipcMain.handle('apps:add', async () => {
    const win = getWin();
    const res = await dialog.showOpenDialog(win, {
      title: '选择要统计时长的程序',
      properties: ['openFile'],
      filters: [{ name: '程序', extensions: ['exe'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };

    const added = await registry.add(res.filePaths[0]);
    if (added.ok && settings.autoWatch) await tracker.resetBaseline();
    if (added.ok) {
      broadcast('apps:changed');
      broadcast('tracker:update', tracker.snapshot());
    }
    return added;
  });

  ipcMain.handle('apps:update', (e, payload) => {
    const r = registry.update(payload.id, payload.patch || {});
    if (r.ok) broadcast('apps:changed');
    return r;
  });

  ipcMain.handle('apps:remove', async (e, payload) => {
    const id = payload.id;
    if (tracker.isBusy(id)) await tracker.stop(id, {});
    const r = registry.remove(id);
    if (r.ok && payload.deleteSessions) sessions.removeByApp(id);
    if (r.ok) {
      broadcast('apps:changed');
      broadcast('tracker:update', tracker.snapshot());
    }
    return r;
  });

  ipcMain.handle('apps:relocate', async (e, id) => {
    const win = getWin();
    const res = await dialog.showOpenDialog(win, {
      title: '重新指定这个程序的位置',
      properties: ['openFile'],
      filters: [{ name: '程序', extensions: ['exe'] }],
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const r = await registry.relocate(id, res.filePaths[0]);
    if (r.ok) broadcast('apps:changed');
    return r;
  });

  ipcMain.handle('apps:launch', async (e, id) => {
    const r = await tracker.start(id, 'launcher');
    broadcast('tracker:update', tracker.snapshot());
    return r;
  });

  ipcMain.handle('apps:stop', async (e, payload) => {
    const r = await tracker.stop(payload.id, { kill: !!payload.kill });
    broadcast('tracker:update', tracker.snapshot());
    broadcast('apps:changed');
    return r;
  });

  ipcMain.handle('apps:reveal', (e, id) => {
    const a = registry.get(id);
    if (!a) return { ok: false };
    shell.showItemInFolder(a.exePath);
    return { ok: true };
  });

  /* ------------------------------- 标签 ------------------------------- */

  /** 标签清单 + 每个标签挂着几个软件、总共多少时长（管理窗口用） */
  ipcMain.handle('tags:list', () => {
    const map = appMap();
    const secById = new Map();

    for (const s of sessions.all()) {
      const v = stats.effSecInRange(s, 0, Number.MAX_SAFE_INTEGER);
      if (v <= 0) continue;
      const ids = (map.get(s.appId) || {}).tagIds || [];
      for (const id of ids) secById.set(id, (secById.get(id) || 0) + v);
    }

    const appCountById = new Map();
    let untaggedApps = 0;
    for (const a of registry.list()) {
      const ids = (map.get(a.id) || {}).tagIds || [];
      if (!ids.length) untaggedApps++;
      for (const id of ids) appCountById.set(id, (appCountById.get(id) || 0) + 1);
    }

    return {
      tags: tags.list().map((t) => ({
        id: t.id,
        name: t.name,
        color: t.color,
        appCount: appCountById.get(t.id) || 0,
        sec: Math.round(secById.get(t.id) || 0),
      })),
      untagged: { appCount: untaggedApps },
    };
  });

  ipcMain.handle('tags:create', (e, payload) => {
    const p = payload || {};
    const r = tags.create(p.name, p.color);
    if (r.ok) broadcastTags();
    return r;
  });

  ipcMain.handle('tags:update', (e, payload) => {
    const p = payload || {};
    const r = tags.update(p.id, p.patch || {});
    if (r.ok) {
      broadcastTags();
      broadcast('apps:changed'); // 改了名字，卡片上的小标签要跟着重画
    }
    return r;
  });

  ipcMain.handle('tags:reorder', (e, payload) => {
    const r = tags.reorder(payload && payload.ids);
    if (r.ok) broadcastTags();
    return r;
  });

  /** 删标签：可以把用它的软件转到另一个标签（等于合并），也可以丢回「未分类」 */
  ipcMain.handle('tags:delete', (e, payload) => {
    const p = payload || {};
    if (!tags.get(p.id)) return { ok: false, reason: '找不到这个标签' };
    const moveTo = p.moveTo && p.moveTo !== p.id && tags.get(p.moveTo) ? p.moveTo : null;
    const changed = stripTagFromApps(registry.apps, p.id, moveTo);
    if (changed) registry.save();
    tags.remove(p.id);
    broadcastTags();
    broadcast('apps:changed');
    return { ok: true, moved: changed, moveTo };
  });

  /** 一次把这个标签的成员设成 appIds（「勾选属于这个标签的软件」） */
  ipcMain.handle('tags:set-apps', (e, payload) => {
    const p = payload || {};
    if (!tags.get(p.tagId)) return { ok: false, reason: '找不到这个标签' };
    const changed = applyTagMembers(registry.apps, p.tagId, p.appIds || []);
    if (changed) registry.save();
    broadcastTags();
    broadcast('apps:changed');
    return { ok: true, changed };
  });

  /** 一个软件的标签整体换成 tagIds（卡片右键 / 详情页用） */
  ipcMain.handle('apps:set-tags', (e, payload) => {
    const p = payload || {};
    const known = new Set(tags.list().map((t) => t.id));
    const ids = normalizeTagIds(p.tagIds).filter((id) => known.has(id));
    const r = registry.update(p.appId, { tagIds: ids });
    if (r.ok) {
      broadcastTags();
      broadcast('apps:changed');
    }
    return r;
  });

  /* ------------------------------- 监视开关 ------------------------------- */

  ipcMain.handle('watch:set', async (e, payload) => {
    settings.autoWatch = !!payload.enabled;
    saveSettings();
    await tracker.resetBaseline();
    tracker.ensureTimer();
    return { ok: true, enabled: settings.autoWatch };
  });

  ipcMain.handle('tracker:snapshot', () => tracker.snapshot());

  /* ------------------------------- 统计 ------------------------------- */

  ipcMain.handle('stats:overview', (e, payload) => {
    const p = payload || {};
    const now = Date.now();
    const dayStart = stats.startOfDay(now);
    const dayEnd = stats.addDays(dayStart, 1);
    const map = appMap();
    const rows = filterRows(sessions.all(), map, pickedTags(p));

    const today = stats.overview(rows, dayStart, dayEnd);
    const week = stats.overview(rows, stats.startOfWeek(now), dayEnd);
    const month = stats.overview(rows, stats.startOfMonth(now), dayEnd);
    let totalSec = 0;
    for (const s of rows) totalSec += stats.effSecInRange(s, 0, Number.MAX_SAFE_INTEGER);

    const rank = stats.ranking(rows, map, dayStart, dayEnd);
    const st = stats.streak(rows);

    return {
      todaySec: today.sec,
      weekSec: week.sec,
      monthSec: month.sec,
      totalSec: Math.round(totalSec),
      todaySessions: today.count,
      streak: st,
      topApp: rank[0] || null,
      appCount: registry.list().length,
      sessionCount: rows.length,
    };
  });

  ipcMain.handle('stats:days', (e, payload) => {
    const p = payload || {};
    const now = Date.now();
    const days = Math.max(1, p.days || 30);
    const from = stats.addDays(stats.startOfDay(now), -(days - 1));
    const to = stats.addDays(stats.startOfDay(now), 1);
    const rows = filterRows(sessions.all(), appMap(), pickedTags(p));
    return stats.daySeries(rows, from, to, p.appId || null);
  });

  ipcMain.handle('stats:sessions', (e, payload) => {
    const p = payload || {};
    let rows = p.appId ? sessions.forApp(p.appId) : sessions.all();
    if (!p.appId) rows = filterRows(rows, appMap(), pickedTags(p));
    rows = rows.slice().sort((a, b) => b.startMs - a.startMs);
    const total = rows.length;
    const offset = Math.max(0, p.offset || 0);
    const limit = Math.max(1, p.limit || 50);
    return {
      total,
      rows: rows.slice(offset, offset + limit).map((r) => {
        const app = registry.get(r.appId);
        return Object.assign({}, r, { appName: app ? app.name : '（已移除）' });
      }),
    };
  });

  ipcMain.handle('stats:delete-session', (e, id) => {
    const ok = sessions.remove(id);
    if (ok) {
      broadcast('apps:changed');
      broadcast('tracker:update', tracker.snapshot());
    }
    return { ok };
  });

  /** 「记错软件了」：把这条记录的归属换掉，时长和起止时间原样保留 */
  ipcMain.handle('stats:reassign-session', (e, payload) => {
    const p = payload || {};
    if (!p.id || !p.appId) return { ok: false, reason: '参数不全' };
    const target = registry.get(p.appId);
    if (!target) return { ok: false, reason: '找不到这个软件' };
    const ok = sessions.reassign(p.id, p.appId);
    if (ok) {
      logger.info('session', '一条记录改了归属', { id: p.id, 改成: target.name });
      broadcast('apps:changed');
      broadcast('tracker:update', tracker.snapshot());
    }
    return { ok };
  });

  ipcMain.handle('stats:hours', (e, payload) => {
    const p = payload || {};
    const dayMs = p.dateMs || Date.now();
    const rows = filterRows(sessions.all(), appMap(), pickedTags(p));
    return stats.hourly(rows, dayMs, p.appId || null);
  });

  ipcMain.handle('stats:calendar', (e, payload) => {
    const p = payload || {};
    const now = Date.now();
    const days = Math.max(7, p.days || 91);
    const from = stats.addDays(stats.startOfDay(now), -(days - 1));
    const to = stats.addDays(stats.startOfDay(now), 1);
    const rows = filterRows(sessions.all(), appMap(), pickedTags(p));
    return stats.calendar(rows, from, to, p.appId || null);
  });

  ipcMain.handle('stats:ranking', (e, payload) => {
    const p = payload || {};
    const now = Date.now();
    const dayStart = stats.startOfDay(now);
    const dayEnd = stats.addDays(dayStart, 1);
    let from = dayStart;
    if (p.range === 'week') from = stats.startOfWeek(now);
    else if (p.range === 'month') from = stats.startOfMonth(now);
    else if (p.range === 'all') from = 0;
    const map = appMap();
    const rows = filterRows(sessions.all(), map, pickedTags(p));
    return stats.ranking(rows, map, from, dayEnd);
  });

  /**
   * 按标签统计。
   * 分母 denom = 图里各片时长 + 未分类时长；多标签会让 denom 大于真实总时长，
   * 差额放在 overlapSec 里，界面用小字如实说明，不假装能加得起来。
   *
   * 选中两个以上标签时（scoped），环里只算选中的那几个标签。
   * 筛选是「或」：命中的软件身上往往还挂着「游戏」这类大类标签，
   * 把它画进去会白占一大片，还会把真正的占比压小。用户比的是所选几类，就只画这几类。
   */
  ipcMain.handle('stats:tags', (e, payload) => {
    const p = payload || {};
    const now = Date.now();
    const dayStart = stats.startOfDay(now);
    const dayEnd = stats.addDays(dayStart, 1);
    let from = 0;
    if (p.range === 'today') from = dayStart;
    else if (p.range === 'week') from = stats.startOfWeek(now);
    else if (p.range === 'month') from = stats.startOfMonth(now);

    const map = appMap();
    const picked = pickedTags(p);
    const rows = filterRows(sessions.all(), map, picked);

    const scopedIds = picked.filter((id) => id !== '__none__');
    const scoped = picked.length >= 2 && scopedIds.length > 0;
    const scopedSet = scoped ? new Set(scopedIds) : null;

    const b = stats.tagBreakdown(rows, map, from, dayEnd, scopedSet);

    const appCount = new Map();
    for (const a of registry.list()) {
      const ids = (map.get(a.id) || {}).tagIds || [];
      for (const id of ids) appCount.set(id, (appCount.get(id) || 0) + 1);
    }

    const list = [];
    let taggedSec = 0;
    for (const t of tags.list()) {
      if (scopedSet && !scopedSet.has(t.id)) continue;
      const rec = b.perTag.get(t.id);
      if (!rec) continue;
      const sec = Math.round(rec.sec);
      taggedSec += sec;
      list.push({
        id: t.id,
        name: t.name,
        color: t.color,
        sec,
        sessionCount: rec.sessionCount,
        appCount: appCount.get(t.id) || rec.appIds.size,
      });
    }
    list.sort((a, b2) => b2.sec - a.sec);

    const denom = taggedSec + b.untaggedSec;
    return {
      range: p.range || 'all',
      totalSec: b.totalSec,
      taggedSec,
      denom,
      overlapSec: Math.max(0, denom - b.totalSec),
      untagged: { sec: b.untaggedSec, sessionCount: b.untaggedSessions },
      filtered: picked.length > 0,
      scoped,
      tags: list,
    };
  });

  ipcMain.handle('stats:app-detail', (e, id) => {
    const app = registry.get(id);
    if (!app) return { ok: false, reason: '找不到这个软件' };
    const now = Date.now();
    const today = stats.startOfDay(now);
    const rows = sessions.forApp(id);
    const summary = stats.appSummary(rows, id, now);
    const last7 = stats.daySeries(rows, stats.addDays(today, -6), today, id);
    const last14 = stats.daySeries(rows, stats.addDays(today, -13), today, id);
    const calendar = stats.calendar(rows, stats.addDays(today, -90), today, id);
    return {
      ok: true,
      app: Object.assign({}, app, { running: tracker.snapshot().find((r) => r.appId === id) || null }),
      summary,
      last7,
      last14,
      calendar,
      todayHours: stats.hourly(rows, now, id),
      sessions: rows.slice().sort((a, b) => b.startMs - a.startMs).slice(0, 60),
      sessionCount: rows.length,
    };
  });

  ipcMain.handle('stats:export-csv', async () => {
    const win = getWin();
    const d = new Date();
    const res = await dialog.showSaveDialog(win, {
      title: '导出统计表格',
      defaultPath: path.join(app.getPath('documents'), '时间统计-' + stats.dayKey(Date.now()) + '.csv'),
      filters: [{ name: 'CSV 表格（Excel 可打开）', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };

    const rows = sessions.all().slice().sort((a, b) => a.startMs - b.startMs);
    const tagName = (id) => {
      const t = tags.get(id);
      return t ? t.name : '';
    };
    const lines = ['软件,标签,开始时间,结束时间,时长,时长(秒),日期,来源,结束原因,含休眠(秒)'];
    for (const r of rows) {
      const a = registry.get(r.appId);
      const clean = Math.max(0, Math.round((r.endMs - r.startMs - (r.gapMs || 0)) / 1000));
      lines.push(
        [
          a ? a.name : '（已移除）',
          a ? (a.tagIds || []).map(tagName).filter(Boolean).join('、') : '',
          humanTime(r.startMs),
          humanTime(r.endMs),
          fmtHms(clean),
          clean,
          stats.dayKey(r.startMs),
          r.source === 'autowatch' ? '自动监视' : '从本工具启动',
          r.closedBy || '',
          Math.round((r.gapMs || 0) / 1000),
        ]
          .map(csvCell)
          .join(',')
      );
    }
    fs.writeFileSync(res.filePath, '\ufeff' + lines.join('\r\n'), 'utf8');
    return { ok: true, filePath: res.filePath };
  });

  /* ------------------------------- 设置 / 系统 ------------------------------- */

  ipcMain.handle('settings:get', () => ({
    settings: Object.assign({}, settings, { autoLaunch: autolaunch.isEnabled() }),
    dataDir: paths.dataDir,
    version: app.getVersion(),
    packaged: app.isPackaged,
  }));

  ipcMain.handle('settings:set', (e, patch) => {
    const allowed = ['closeToTray', 'sort', 'sortDir', 'pollActiveMs', 'pollWatchMs', 'graceTicks', 'debugLog'];
    for (const k of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) settings[k] = patch[k];
    }
    saveSettings();
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'debugLog')) {
      logger.setEnabled(!!settings.debugLog);
    }
    tracker.ensureTimer();
    return { ok: true, settings: Object.assign({}, settings) };
  });

  ipcMain.handle('system:auto-launch', (e, payload) => {
    const r = autolaunch.setEnabled(!!payload.enabled);
    settings.autoLaunch = autolaunch.isEnabled();
    saveSettings();
    return Object.assign({}, r, { enabled: autolaunch.isEnabled() });
  });

  ipcMain.handle('system:create-shortcut', () => autolaunch.createDesktopShortcut());

  ipcMain.handle('system:open-data-folder', () => {
    shell.openPath(paths.dataDir);
    return { ok: true };
  });

  ipcMain.handle('system:open-log-file', () => {
    const p = logger.path();
    if (p && fs.existsSync(p)) {
      shell.showItemInFolder(p);
      return { ok: true, path: p };
    }
    shell.openPath(paths.dataDir);
    return { ok: false, path: p || paths.dataDir, reason: '还没有日志文件，先打开数据文件夹' };
  });

  ipcMain.handle('system:open-startup-folder', () => autolaunch.openStartupFolder());

  ipcMain.handle('system:diagnostics', async () => {
    const scanMod = require('./services/process-scan');
    const snap = await scanMod.scan({ force: true });
    return {
      version: app.getVersion(),
      packaged: app.isPackaged,
      dataDir: paths.dataDir,
      autoLaunchFile: autolaunch.linkPath(),
      autoLaunchEnabled: autolaunch.isEnabled(),
      processCount: snap.count,
      scanMs: snap.costMs,
      scanError: snap.error || null,
      pollActiveMs: settings.pollActiveMs,
      pollWatchMs: settings.pollWatchMs,
      debounceMs: settings.debounceMs,
      heartbeatMs: settings.heartbeatMs,
      autoWatch: settings.autoWatch,
      debugLog: !!settings.debugLog,
      logPath: logger.path(),
      sessionRows: sessions.all().length,
      badLines: sessions.badLines,
      appCount: registry.apps.length,
    };
  });

  ipcMain.handle('win:minimize', () => {
    const win = getWin();
    if (win) win.minimize();
    return { ok: true };
  });

  ipcMain.handle('win:maximize', () => {
    const win = getWin();
    if (!win) return { ok: true };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle('win:close', () => {
    const win = getWin();
    if (win) win.close();
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    app.quit();
    return { ok: true };
  });
}

module.exports = { registerIpc };
