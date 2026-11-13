'use strict';
/**
 * 统计计算（纯函数，不碰文件、不碰界面）。
 *
 * 两个关键口径：
 * 1) 跨天拆分：22:00 玩到次日 02:00 → 两天各算 2 小时，这样「每天几点开始/结束」才对得上。
 * 2) 有效时长：默认扣掉休眠/睡眠造成的空档（gapMs），同时保留原时长供对照。
 */

const HOUR = 3600000;
const DAY = 86400000;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function startOfDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function addDays(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime();
}

function dayKey(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function startOfWeek(ms) {
  const d = new Date(startOfDay(ms));
  const wd = (d.getDay() + 6) % 7; // 周一为一周开始
  return addDays(d.getTime(), -wd);
}

function startOfMonth(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function addMonths(ms, n) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
}

function durationMs(s) {
  return Math.max(1, (s.endMs || s.startMs) - s.startMs);
}

/** 某条会话在 [from,to) 区间内的净秒数（已按比例扣掉休眠空档） */
function effSecInRange(s, from, to) {
  const a = Math.max(s.startMs, from);
  const b = Math.min(s.endMs, to);
  if (b <= a) return 0;
  const total = durationMs(s);
  const overlap = b - a;
  const gapShare = (s.gapMs || 0) * (overlap / total);
  return Math.max(0, (overlap - gapShare) / 1000);
}

/** 把一次会话按自然日切开 */
function splitByDay(s) {
  const out = [];
  const end = s.endMs || s.startMs;
  const total = durationMs(s);
  let cur = s.startMs;
  let guard = 0;
  while (cur < end && guard++ < 400) {
    const midnight = addDays(startOfDay(cur), 1);
    const segEnd = Math.min(end, midnight);
    const overlap = segEnd - cur;
    const gapShare = (s.gapMs || 0) * (overlap / total);
    out.push({
      date: dayKey(cur),
      fromMs: cur,
      toMs: segEnd,
      sec: Math.max(0, Math.round((overlap - gapShare) / 1000)),
      rawSec: Math.round(overlap / 1000),
      carriedIn: cur > s.startMs,
      session: s,
    });
    cur = segEnd;
  }
  return out;
}

/** 按天汇总（某天第一次开始、最后一次结束、总时长、启动次数） */
function daySeries(rows, fromMs, toMs, appId) {
  const start = startOfDay(fromMs);
  const end = startOfDay(toMs);
  const map = new Map();

  for (let d = start; d <= end; d = addDays(d, 1)) {
    map.set(dayKey(d), {
      date: dayKey(d),
      startMs: d,
      sec: 0,
      sessions: 0,
      launches: 0,
      firstStartMs: null,
      lastEndMs: null,
      carriedIn: false,
      maxGapSec: 0,
    });
  }

  for (const s of rows) {
    if (appId && s.appId !== appId) continue;
    if (s.endMs < start || s.startMs >= addDays(end, 1)) continue;

    // 启动次数只算「开始于这一天」的
    const launchRec = map.get(dayKey(s.startMs));
    if (launchRec && s.startMs >= start) launchRec.launches++;

    for (const seg of splitByDay(s)) {
      const rec = map.get(seg.date);
      if (!rec) continue;
      rec.sec += seg.sec;
      rec.sessions++;
      if (rec.firstStartMs === null || seg.fromMs < rec.firstStartMs) {
        rec.firstStartMs = seg.fromMs;
        rec.carriedIn = seg.carriedIn;
      }
      if (rec.lastEndMs === null || seg.toMs > rec.lastEndMs) rec.lastEndMs = seg.toMs;
    }
  }

  return Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** 某一天的 24 小时分布（净秒） */
function hourly(rows, dayMs, appId) {
  const dayStart = startOfDay(dayMs);
  const dayEnd = addDays(dayStart, 1);
  const bins = new Array(24).fill(0);

  for (const s of rows) {
    if (appId && s.appId !== appId) continue;
    const a = Math.max(s.startMs, dayStart);
    const b = Math.min(s.endMs, dayEnd);
    if (b <= a) continue;
    const total = durationMs(s);
    let cur = a;
    let guard = 0;
    while (cur < b && guard++ < 100) {
      const nextHour = Math.floor(cur / HOUR) * HOUR + HOUR;
      const segEnd = Math.min(b, nextHour);
      const gapShare = (s.gapMs || 0) * ((segEnd - cur) / total);
      const idx = new Date(cur).getHours();
      bins[idx] += (segEnd - cur - gapShare) / 1000;
      cur = segEnd;
    }
  }
  return bins.map((v) => Math.round(v));
}

/** 区间总览 */
function overview(rows, fromMs, toMs) {
  let sec = 0;
  let count = 0;
  const apps = new Set();
  for (const s of rows) {
    const v = effSecInRange(s, fromMs, toMs);
    if (v <= 0) continue;
    sec += v;
    count++;
    apps.add(s.appId);
  }
  return { sec: Math.round(sec), count, appCount: apps.size };
}

/** 某一天的日历热力等级：0 无记录，1-4 由浅到深 */
function heatLevel(sec) {
  if (!sec) return 0;
  const m = sec / 60;
  if (m < 15) return 1;
  if (m < 60) return 2;
  if (m < 180) return 3;
  return 4;
}

/** 日历热力图（含每天的净秒与等级） */
function calendar(rows, fromMs, toMs, appId) {
  const days = daySeries(rows, fromMs, toMs, appId);
  return days.map((d) => ({
    date: d.date,
    startMs: d.startMs,
    sec: Math.round(d.sec),
    level: heatLevel(d.sec),
  }));
}

/** 排行榜 */
function ranking(rows, apps, fromMs, toMs, by) {
  const map = new Map();
  for (const s of rows) {
    const v = effSecInRange(s, fromMs, toMs);
    if (v <= 0) continue;
    let rec = map.get(s.appId);
    if (!rec) {
      rec = { appId: s.appId, sec: 0, count: 0 };
      map.set(s.appId, rec);
    }
    rec.sec += v;
    rec.count++;
  }
  const list = Array.from(map.values()).map((r) => {
    const app = apps.get(r.appId);
    return {
      appId: r.appId,
      name: app ? app.name : '（已移除）',
      iconFile: app ? app.iconFile : null,
      sec: Math.round(r.sec),
      count: r.count,
    };
  });
  list.sort((a, b) => (by === 'count' ? b.count - a.count || b.sec - a.sec : b.sec - a.sec));
  return list;
}

/** 连续使用天数 */
function streak(rows) {
  const totals = new Map();
  for (const s of rows) {
    for (const seg of splitByDay(s)) {
      if (seg.sec <= 0) continue;
      totals.set(seg.date, (totals.get(seg.date) || 0) + seg.sec);
    }
  }
  const days = Array.from(totals.keys()).sort();
  if (!days.length) return { current: 0, longest: 0, totalDays: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < days.length; i++) {
    const prev = new Date(days[i - 1] + 'T00:00:00').getTime();
    const cur = new Date(days[i] + 'T00:00:00').getTime();
    if (Math.round((cur - prev) / DAY) === 1) run++;
    else run = 1;
    if (run > longest) longest = run;
  }

  let d = startOfDay(Date.now());
  if (!totals.has(dayKey(d))) d = addDays(d, -1);
  let current = 0;
  while (totals.has(dayKey(d))) {
    current++;
    d = addDays(d, -1);
  }
  return { current, longest, totalDays: days.length };
}

/** 单个软件的总览（四项时长全部走 effSecInRange，保证同一套口径，秒级也不会对不上） */function appSummary(rows, appId, now) {
  const list = rows.filter((s) => s.appId === appId);
  const total = overview(list, 0, Number.MAX_SAFE_INTEGER).sec;
  const today = overview(list, startOfDay(now), addDays(startOfDay(now), 1)).sec;
  const week = overview(list, startOfWeek(now), addDays(startOfDay(now), 1)).sec;
  const month = overview(list, startOfMonth(now), addDays(startOfDay(now), 1)).sec;
  const lastUsedMs = list.reduce((acc, s) => Math.max(acc, s.endMs || 0), 0);
  return {
    totalSec: total,
    todaySec: today,
    weekSec: week,
    monthSec: month,
    sessionCount: list.length,
    avgSec: list.length ? Math.round(total / list.length) : 0,
    lastUsedMs: lastUsedMs || null,
  };
}

/**
 * 按标签汇总。
 *
 * 注意这是「多标签」口径：一个软件挂了两个标签，它的时长会在两个标签下各算一次。
 * 所以各标签之和可能大于真实总时长（overlapSec 就是多出来的那部分）。
 * 界面上用一行小字把差额说清楚，不装作对得上。
 *
 * onlyIds：只统计这几个标签（传 null 表示全都算）。
 * 统计页选中两个以上标签时用得上——那时候用户只想比这几类，
 * 软件身上顺带挂的大类标签（比如两个游戏都挂的「游戏」）不该再冒出来占一片，
 * 它的时长恰好等于所选几片之和，画进去纯属噪音。
 */
function tagBreakdown(rows, apps, fromMs, toMs, onlyIds) {
  const perTag = new Map();
  let totalSec = 0;
  let untaggedSec = 0;
  let untaggedSessions = 0;

  for (const s of rows) {
    const v = effSecInRange(s, fromMs, toMs);
    if (v <= 0) continue;
    totalSec += v;

    const app = apps.get(s.appId);
    const ids = app && Array.isArray(app.tagIds) ? app.tagIds : [];
    if (!ids.length) {
      untaggedSec += v;
      untaggedSessions++;
      continue;
    }

    for (const id of ids) {
      if (onlyIds && !onlyIds.has(id)) continue;
      let rec = perTag.get(id);
      if (!rec) {
        rec = { tagId: id, sec: 0, sessionCount: 0, appIds: new Set() };
        perTag.set(id, rec);
      }
      rec.sec += v;
      rec.sessionCount++;
      rec.appIds.add(s.appId);
    }
  }

  return {
    totalSec: Math.round(totalSec),
    untaggedSec: Math.round(untaggedSec),
    untaggedSessions,
    perTag,
  };
}

/** 这条记录是否属于选中的标签；selected 为空表示不筛（选「未分类」用 __none__） */
function matchesTags(app, selected) {
  if (!selected || !selected.length) return true;
  const ids = app && Array.isArray(app.tagIds) ? app.tagIds : [];
  if (!ids.length) return selected.indexOf('__none__') >= 0;
  for (const id of ids) {
    if (selected.indexOf(id) >= 0) return true;
  }
  return false;
}

module.exports = {
  HOUR,
  DAY,
  startOfDay,
  addDays,
  dayKey,
  startOfWeek,
  startOfMonth,
  addMonths,
  durationMs,
  effSecInRange,
  splitByDay,
  daySeries,
  hourly,
  overview,
  heatLevel,
  calendar,
  ranking,
  streak,
  appSummary,
  tagBreakdown,
  matchesTags,
};
