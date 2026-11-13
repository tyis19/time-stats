'use strict';
/**
 * 标签库：只管标签本身（名字、颜色、顺序）。
 *
 * 三条约定，改代码时别破坏：
 * 1) 「哪个软件挂了哪个标签」不存在这里，存在 apps.json 的 tagIds 里，而且存的是编号不是名字。
 *    所以改名立刻全站生效，历史统计一条都不用重算。
 * 2) 「未分类」是虚拟标签：不落盘、不能改名、不能删除。
 *    它由「一个标签都没挂的软件」自然构成，删标签时把软件丢回这里即可。
 * 3) 标签被删掉时，软件上的旧编号必须一起摘掉（stripTagFromApps），
 *    否则界面会显示一个查不到的标签。摘的时候可以顺手转到另一个标签，这就是「合并」。
 */

const { readJson, writeJson } = require('./store');

const RESERVED_TAG_NAME = '未分类';
const MAX_TAG_NAME = 16;
const MAX_TAGS_PER_APP = 32;

/** 深色界面上看着舒服、彼此区分度够的 8 个颜色 */
const TAG_PALETTE = [
  '#66c0f4', // 天蓝
  '#7ad16b', // 草绿
  '#e2b25f', // 琥珀
  '#c78bf0', // 紫
  '#e2705f', // 砖红
  '#5fd0c4', // 青绿
  '#f08fb0', // 粉
  '#9fb0c0', // 灰蓝
];

function cleanTagName(input) {
  return String(input == null ? '' : input)
    .replace(/^#+/, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TAG_NAME);
}

function isColor(v) {
  return /^#[0-9a-f]{6}$/i.test(String(v || ''));
}

function newTagId() {
  return 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

/** 软件上的标签编号：去重、只留字符串、限个上限，顺手把脏数据挡掉 */
function normalizeTagIds(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !v) continue;
    if (out.indexOf(v) >= 0) continue;
    out.push(v);
    if (out.length >= MAX_TAGS_PER_APP) break;
  }
  return out;
}

/**
 * 让一个标签的成员正好等于 appIds（界面上「勾选属于这个标签的软件」用它）。
 * 返回真正发生变化的软件数量。
 */
function applyTagMembers(apps, tagId, appIds) {
  const keep = new Set(Array.isArray(appIds) ? appIds : []);
  let changed = 0;
  for (const app of apps) {
    if (!Array.isArray(app.tagIds)) app.tagIds = [];
    const ids = app.tagIds;
    const has = ids.indexOf(tagId) >= 0;
    const want = keep.has(app.id);
    if (want && !has) {
      ids.push(tagId);
      changed++;
    } else if (!want && has) {
      app.tagIds = ids.filter((x) => x !== tagId);
      changed++;
    }
  }
  return changed;
}

/**
 * 标签被删除：从所有软件上摘掉它。
 * moveTo 有值就顺手把软件挂到那个标签上（等于把两个标签合并成一个）。
 */
function stripTagFromApps(apps, tagId, moveTo) {
  let changed = 0;
  for (const app of apps) {
    const ids = Array.isArray(app.tagIds) ? app.tagIds : [];
    if (ids.indexOf(tagId) < 0) continue;
    const next = ids.filter((x) => x !== tagId);
    if (moveTo && moveTo !== tagId && next.indexOf(moveTo) < 0) next.push(moveTo);
    app.tagIds = next;
    changed++;
  }
  return changed;
}

class TagStore {
  constructor({ file }) {
    this.file = file;
    this.tags = [];
    this.version = 0;
  }

  load() {
    const data = readJson(this.file, { schemaVersion: 1, tags: [] });
    const list = Array.isArray(data.tags) ? data.tags : [];
    const seenId = new Set();
    const seenName = new Set();
    const clean = [];

    for (const raw of list) {
      if (!raw || typeof raw.id !== 'string') continue;
      const name = cleanTagName(raw.name);
      if (!name || name === RESERVED_TAG_NAME) continue;
      if (seenId.has(raw.id) || seenName.has(name.toLowerCase())) continue;
      seenId.add(raw.id);
      seenName.add(name.toLowerCase());
      clean.push({
        id: raw.id,
        name,
        color: isColor(raw.color) ? raw.color : TAG_PALETTE[clean.length % TAG_PALETTE.length],
        createdMs: Number.isFinite(raw.createdMs) ? raw.createdMs : Date.now(),
      });
    }

    this.tags = clean;
    return this;
  }

  save() {
    writeJson(this.file, { schemaVersion: 1, tags: this.tags });
    this.version++;
  }

  list() {
    return this.tags;
  }

  get(id) {
    return this.tags.find((t) => t.id === id) || null;
  }

  findByName(name) {
    const n = cleanTagName(name).toLowerCase();
    if (!n) return null;
    return this.tags.find((t) => t.name.toLowerCase() === n) || null;
  }

  create(name, color) {
    const n = cleanTagName(name);
    if (!n) return { ok: false, reason: '标签名不能是空的' };
    if (n === RESERVED_TAG_NAME) return { ok: false, reason: '「未分类」是系统自己的分类，换个名字吧' };
    if (this.findByName(n)) return { ok: false, reason: '已经有同名标签了' };

    const tag = {
      id: newTagId(),
      name: n,
      color: isColor(color) ? color : this.nextColor(),
      createdMs: Date.now(),
    };
    this.tags.push(tag);
    this.save();
    return { ok: true, tag };
  }

  update(id, patch) {
    const tag = this.get(id);
    if (!tag) return { ok: false, reason: '找不到这个标签' };
    const p = patch || {};

    if (Object.prototype.hasOwnProperty.call(p, 'name')) {
      const n = cleanTagName(p.name);
      if (!n) return { ok: false, reason: '标签名不能是空的' };
      if (n === RESERVED_TAG_NAME) return { ok: false, reason: '「未分类」是系统自己的分类，换个名字吧' };
      const same = this.findByName(n);
      if (same && same.id !== id) return { ok: false, reason: '已经有同名标签了' };
      tag.name = n;
    }

    if (isColor(p.color)) tag.color = p.color;

    // 界面点色块是「换下一个颜色」，具体下一个是谁由这里决定，避免两边各存一份色板
    if (p.cycleColor) {
      const i = TAG_PALETTE.indexOf(tag.color);
      tag.color = TAG_PALETTE[(i + 1) % TAG_PALETTE.length];
    }

    this.save();
    return { ok: true, tag };
  }

  /** 拖动/上移下移后保存新的顺序；传进来的编号缺了谁就自动接在后面，绝不丢标签 */
  reorder(ids) {
    if (!Array.isArray(ids)) return { ok: false, reason: '参数不对' };
    const map = new Map(this.tags.map((t) => [t.id, t]));
    const next = [];
    for (const id of ids) {
      const t = map.get(id);
      if (!t) continue;
      next.push(t);
      map.delete(id);
    }
    for (const t of map.values()) next.push(t);
    this.tags = next;
    this.save();
    return { ok: true, tags: this.tags };
  }

  remove(id) {
    const idx = this.tags.findIndex((t) => t.id === id);
    if (idx < 0) return { ok: false, reason: '找不到这个标签' };
    const tag = this.tags.splice(idx, 1)[0];
    this.save();
    return { ok: true, tag };
  }

  /** 挑一个用得最少的颜色，让新标签尽量不撞色 */
  nextColor() {
    const used = new Map();
    for (const t of this.tags) used.set(t.color, (used.get(t.color) || 0) + 1);
    let best = TAG_PALETTE[0];
    let bestCount = Infinity;
    for (const c of TAG_PALETTE) {
      const n = used.get(c) || 0;
      if (n < bestCount) {
        bestCount = n;
        best = c;
      }
    }
    return best;
  }
}

module.exports = {
  TagStore,
  TAG_PALETTE,
  RESERVED_TAG_NAME,
  MAX_TAG_NAME,
  cleanTagName,
  normalizeTagIds,
  applyTagMembers,
  stripTagFromApps,
};
