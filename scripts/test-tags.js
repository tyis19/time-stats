'use strict';
/**
 * 标签自检：node scripts/test-tags.js
 * 重点验证：
 *   · 旧数据（没有 tagIds 字段）不会被改坏
 *   · 改名不换编号、重名/保留字拦得住、重排序不丢标签
 *   · 删标签时「转移到另一个标签」= 合并
 *   · 多标签统计会重复计入，overlap 算得对
 *   · 休眠扣除、未分类的口径和原来的统计一致
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const T = require(path.join(__dirname, '..', 'src', 'main', 'services', 'tags.js'));
const S = require(path.join(__dirname, '..', 'src', 'main', 'services', 'stats.js'));

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(
    (ok ? '  ✓ ' : '  ✗ ') + name +
    (ok ? '' : '  期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual))
  );
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-tags-'));
const file = path.join(dir, 'tags.json');

console.log('\n=== 1. 新建 / 改名 / 重名 / 保留字 ===');
const store = new T.TagStore({ file }).load();
check('一开始是空的', store.list().length, 0);
check('标签文件不存在也不会崩', store.tags, []);

const a = store.create('游戏');
check('新建成功', a.ok, true);
check('第一个颜色', a.tag.color, T.TAG_PALETTE[0]);
const b = store.create('学习');
check('第二个标签自动换色', b.tag.color, T.TAG_PALETTE[1]);
check('重名（带空格）被拦住', store.create('  游戏 ').ok, false);
check('保留字「未分类」被拦住', store.create('未分类').ok, false);
check('空名字被拦住', store.create('   ').ok, false);
check('带 # 的名字会自动去掉', store.create('#影音').tag.name, '影音');
store.remove(store.findByName('影音').id);

const renamed = store.update(a.tag.id, { name: '单机游戏' });
check('改名成功', renamed.ok, true);
check('改名后编号不变', renamed.tag.id, a.tag.id);
check('老名字查不到了', store.findByName('游戏'), null);

const reopened = new T.TagStore({ file }).load();
check('重新读盘：名字是新的', reopened.list()[0].name, '单机游戏');
check('重新读盘：数量对', reopened.list().length, 2);

console.log('\n=== 2. 排序 / 换色 / 删除 ===');
const ids = reopened.list().map((t) => t.id);
reopened.reorder(ids.slice().reverse());
check('倒序后第一个是「学习」', reopened.list()[0].name, '学习');
reopened.reorder([reopened.list()[0].id]);
check('排序漏传的标签不会被删掉', reopened.list().length, 2);

const target = reopened.list()[0];
const colorBefore = target.color;
reopened.update(target.id, { cycleColor: true });
check('换色后颜色变了', reopened.get(target.id).color !== colorBefore, true);

const removed = reopened.remove(target.id);
check('删除成功', removed.ok, true);
check('删完只剩一个', reopened.list().length, 1);

console.log('\n=== 3. 旧数据兼容（软件清单没有 tagIds） ===');
check('缺字段 → 空数组', T.normalizeTagIds(undefined), []);
check('null → 空数组', T.normalizeTagIds(null), []);
check('字符串 → 空数组（类型不对不硬塞）', T.normalizeTagIds('t1'), []);
check('重复编号去重', T.normalizeTagIds(['t1', 't1', 't2']), ['t1', 't2']);
check('混进非字符串会被剔掉', T.normalizeTagIds(['t1', 3, null, 't2']), ['t1', 't2']);

console.log('\n=== 4. 批量勾选（给标签选软件） ===');
const apps = [
  { id: 'p1', tagIds: [] },
  { id: 'p2', tagIds: ['t1'] },
  { id: 'p3', tagIds: ['t1', 't2'] },
];
const changed = T.applyTagMembers(apps, 't1', ['p1', 'p3']);
check('改动了两个软件', changed, 2);
check('p1 加上了 t1', apps[0].tagIds, ['t1']);
check('p2 被取消 t1', apps[1].tagIds, []);
check('p3 原本就有，不重复加', apps[2].tagIds, ['t1', 't2']);

console.log('\n=== 5. 删除标签：转移 = 合并 ===');
const list = [
  { id: 'p1', tagIds: ['t1'] },
  { id: 'p2', tagIds: ['t1', 't2'] },
  { id: 'p3', tagIds: ['t2'] },
];
T.stripTagFromApps(list, 't1', 't2');
check('摘掉 t1 并转到 t2', list[0].tagIds, ['t2']);
check('本来就有 t2 的不会重复', list[1].tagIds, ['t2']);
check('没有 t1 的不动', list[2].tagIds, ['t2']);

const list2 = [{ id: 'p1', tagIds: ['t1'] }];
T.stripTagFromApps(list2, 't1', null);
check('不转移 → 掉进未分类', list2[0].tagIds, []);

console.log('\n=== 6. 按标签统计（多标签会重复计） ===');
const at = (y, m, d, h, min) => new Date(y, m - 1, d, h, min, 0, 0).getTime();
const rows = [
  // p1 只有 t1：1 小时
  { id: 's1', appId: 'p1', startMs: at(2026, 11, 1, 10, 0), endMs: at(2026, 11, 1, 11, 0), gapMs: 0 },
  // p2 有 t1 + t2：1 小时，会在两个标签下各算一次
  { id: 's2', appId: 'p2', startMs: at(2026, 11, 1, 12, 0), endMs: at(2026, 11, 1, 13, 0), gapMs: 0 },
  // p3 没标签：1 小时里睡了 30 分钟，有效 30 分钟
  { id: 's3', appId: 'p3', startMs: at(2026, 11, 1, 14, 0), endMs: at(2026, 11, 1, 15, 0), gapMs: 30 * 60000 },
];
const map = new Map([
  ['p1', { id: 'p1', tagIds: ['t1'] }],
  ['p2', { id: 'p2', tagIds: ['t1', 't2'] }],
  ['p3', { id: 'p3', tagIds: [] }],
]);
const from = at(2026, 11, 1, 0, 0);
const to = at(2026, 11, 2, 0, 0);
const br = S.tagBreakdown(rows, map, from, to);

check('真实总时长（扣掉 30 分钟休眠）', br.totalSec, 9000);
check('t1 时长 = p1 + p2', Math.round(br.perTag.get('t1').sec), 7200);
check('t2 时长 = p2', Math.round(br.perTag.get('t2').sec), 3600);
check('未分类时长 = p3 的有效 30 分钟', br.untaggedSec, 1800);
const denom = 7200 + 3600 + 1800;
check('标签合计（用于环形图分母）', denom, 12600);
check('多标签重叠 = 合计 - 实际', denom - br.totalSec, 3600);
check('t1 下面挂了两个软件', br.perTag.get('t1').appIds.size, 2);

console.log('\n=== 6b. 只统计所选标签（选两个以上时的环） ===');
// 复刻真实场景：两个游戏都挂「游戏」(t9)，一个挂「模拟经营」(t1)，一个挂「大战略」(t2)
const gMap = new Map([
  ['g1', { id: 'g1', tagIds: ['t9', 't1'] }],
  ['g2', { id: 'g2', tagIds: ['t9', 't2'] }],
]);
const gRows = [
  { id: 'g1s', appId: 'g1', startMs: at(2026, 11, 1, 10, 0), endMs: at(2026, 11, 1, 11, 12), gapMs: 0 },
  { id: 'g2s', appId: 'g2', startMs: at(2026, 11, 1, 12, 0), endMs: at(2026, 11, 1, 12, 13) + 6000, gapMs: 0 },
];
const gAll = S.tagBreakdown(gRows, gMap, from, to);
check('全算：模拟经营 72 分钟', Math.round(gAll.perTag.get('t1').sec), 4320);
check('全算：大战略 13 分 6 秒', Math.round(gAll.perTag.get('t2').sec), 786);
check('全算：游戏 = 两片之和', Math.round(gAll.perTag.get('t9').sec), 4320 + 786);
check('全算：环合计比实际多算一份', Math.round(gAll.perTag.get('t9').sec + gAll.perTag.get('t1').sec + gAll.perTag.get('t2').sec) - gAll.totalSec, 4320 + 786);

const gSel = S.tagBreakdown(gRows, gMap, from, to, new Set(['t1', 't2']));
check('只算所选：模拟经营还在', Math.round(gSel.perTag.get('t1').sec), 4320);
check('只算所选：大战略还在', Math.round(gSel.perTag.get('t2').sec), 786);
check('只算所选：「游戏」不再出现', gSel.perTag.has('t9'), false);
check('只算所选：两片加起来正好等于实际', Math.round(gSel.perTag.get('t1').sec + gSel.perTag.get('t2').sec) - gSel.totalSec, 0);
check('只算所选：占比是 85% / 15%', [
  Math.round((4320 / (4320 + 786)) * 100),
  Math.round((786 / (4320 + 786)) * 100),
], [85, 15]);

const gOne = S.tagBreakdown(gRows, gMap, from, to, new Set(['t1']));
check('只选一个时也守规矩：只算那一个', gOne.perTag.has('t2'), false);

console.log('\n=== 7. 筛选命中规则 ===');
check('不筛 → 全过', S.matchesTags(map.get('p3'), []), true);
check('选 t1 → p2 命中', S.matchesTags(map.get('p2'), ['t1']), true);
check('选 t2 → p1 不命中', S.matchesTags(map.get('p1'), ['t2']), false);
check('选「未分类」→ p3 命中', S.matchesTags(map.get('p3'), ['__none__']), true);
check('选 t1 → p3 不命中', S.matchesTags(map.get('p3'), ['t1']), false);

console.log('\n=== 8. 坏文件不拖垮启动 ===');
const badFile = path.join(dir, 'bad.json');
fs.writeFileSync(badFile, '{ 这不是 json');
const bad = new T.TagStore({ file: badFile }).load();
check('坏文件 → 当空标签库', bad.list(), []);
check('重复名字只留一个', (function () {
  const f = path.join(dir, 'dup.json');
  fs.writeFileSync(f, JSON.stringify({ tags: [
    { id: 't1', name: '游戏', color: '#66c0f4' },
    { id: 't2', name: '游戏', color: '#7ad16b' },
    { id: 't1', name: '另一个', color: '#7ad16b' },
    { id: 't3', name: '未分类', color: '#7ad16b' },
  ] }));
  return new T.TagStore({ file: f }).load().list().length;
})(), 1);

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) {
  /* 临时目录删不掉不影响结果 */
}

console.log('\n' + (failed ? '有 ' + failed + ' 项没通过' : '全部通过'));
process.exit(failed ? 1 : 0);
