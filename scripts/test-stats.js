'use strict';
/**
 * 统计口径自检：node scripts/test-stats.js
 * 重点验证「跨天拆分」「休眠扣除」「按小时分布」。
 */

const path = require('path');
const S = require(path.join(__dirname, '..', 'src', 'main', 'services', 'stats.js'));

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '  期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual)));
}

const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).getTime();

const rows = [
  // 跨天：10/30 22:00 → 10/31 02:00，共 4 小时
  { id: 'a', appId: 'p1', startMs: at(2026, 10, 30, 22, 0), endMs: at(2026, 10, 31, 2, 0), gapMs: 0 },
  // 10/31 10:00 → 11:30，共 1.5 小时
  { id: 'b', appId: 'p1', startMs: at(2026, 10, 31, 10, 0), endMs: at(2026, 10, 31, 11, 30), gapMs: 0 },
  // 11/1 09:00 → 10:00，其中 30 分钟在睡眠 → 有效 30 分钟
  { id: 'c', appId: 'p2', startMs: at(2026, 11, 1, 9, 0), endMs: at(2026, 11, 1, 10, 0), gapMs: 30 * 60000 },
];

console.log('\n=== 1. 跨天拆分 ===');
const days = S.daySeries(rows, at(2026, 10, 30, 0, 0), at(2026, 11, 1, 0, 0));
check('10/30 时长（秒，应为 7200）', days[0].sec, 7200);
check('10/30 首次开始', days[0].firstStartMs, at(2026, 10, 30, 22, 0));
check('10/30 最后结束', days[0].lastEndMs, at(2026, 10, 31, 0, 0));
check('10/31 时长（秒，应为 7200+5400）', days[1].sec, 12600);
check('10/31 首次开始（应为 00:00，承接前一天）', days[1].firstStartMs, at(2026, 10, 31, 0, 0));
check('10/31 是否标记为承接前一天', days[1].carriedIn, true);
check('10/31 启动次数（只算当天开始的，应为 1）', days[1].launches, 1);

console.log('\n=== 2. 按小时分布（10/31）===');
const hours = S.hourly(rows, at(2026, 10, 31, 12, 0), 'p1');
check('0 点（承接，3600 秒）', hours[0], 3600);
check('1 点（承接，3600 秒）', hours[1], 3600);
check('2 点（已结束，0）', hours[2], 0);
check('10 点（3600 秒）', hours[10], 3600);
check('11 点（1800 秒）', hours[11], 1800);

console.log('\n=== 3. 休眠扣除 ===');
const eff = S.effSecInRange(rows[2], at(2026, 11, 1, 0, 0), at(2026, 11, 2, 0, 0));
check('1 小时会话含 30 分钟睡眠 → 有效 1800 秒', eff, 1800);
const day11 = S.daySeries(rows, at(2026, 11, 1, 0, 0), at(2026, 11, 1, 0, 0));
check('11/1 当天有效时长', day11[0].sec, 1800);

console.log('\n=== 4. 区间总览 / 排行 ===');
const ov = S.overview(rows, at(2026, 10, 30, 0, 0), at(2026, 11, 2, 0, 0));
check('总有效秒数（4小时 + 1.5小时 + 有效0.5小时 = 21600）', ov.sec, 21600);
const apps = new Map([
  ['p1', { name: '游戏A', iconFile: null }],
  ['p2', { name: '游戏B', iconFile: null }],
]);
const rank = S.ranking(rows, apps, at(2026, 10, 30, 0, 0), at(2026, 11, 2, 0, 0));
check('排行第一名', rank[0].name, '游戏A');
check('排行第一名时长（4小时+1.5小时=19800）', rank[0].sec, 19800);

console.log('\n=== 5. 热力等级 / 连续天数 ===');
check('0 秒 → 0 级', S.heatLevel(0), 0);
check('10 分钟 → 1 级', S.heatLevel(600), 1);
check('45 分钟 → 2 级', S.heatLevel(2700), 2);
check('2 小时 → 3 级', S.heatLevel(7200), 3);
check('5 小时 → 4 级', S.heatLevel(18000), 4);
const st = S.streak(rows);
check('历史最长连续天数（10/30、10/31、11/1 → 3 天）', st.longest, 3);

console.log('\n' + (failed ? '✗ 有 ' + failed + ' 项不通过' : '✓ 统计口径全部通过'));
process.exit(failed ? 1 : 0);
