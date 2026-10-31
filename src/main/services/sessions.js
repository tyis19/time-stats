'use strict';
/**
 * 会话流水账：一次使用 = 一行。只追加，不改写，断电最多丢最后一行。
 * 另外提供查询、删除单条（删的时候才整体重写一次）。
 */

const fs = require('fs');
const path = require('path');
const { ensureDir } = require('./store');

function toLocalIso(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return (
    d.getFullYear() +
    '-' + pad(d.getMonth() + 1) +
    '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) +
    ':' + pad(d.getMinutes()) +
    ':' + pad(d.getSeconds()) +
    sign + oh + ':' + om
  );
}

class SessionStore {
  constructor(file) {
    this.file = file;
    this.rows = [];
    this.byApp = new Map();
    this.badLines = 0;
    this.version = 0;
  }

  load() {
    this.rows = [];
    this.byApp = new Map();
    this.badLines = 0;
    if (!fs.existsSync(this.file)) return this;

    const text = fs.readFileSync(this.file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      let row;
      try {
        row = JSON.parse(t);
      } catch (e) {
        this.badLines++;
        continue;
      }
      if (!row || !row.appId || !Number.isFinite(row.startMs)) {
        this.badLines++;
        continue;
      }
      this._index(row);
    }
    return this;
  }

  _index(row) {
    if (!Number.isFinite(row.endMs)) row.endMs = row.startMs;
    if (!Number.isFinite(row.sec)) {
      row.sec = Math.max(0, Math.round((row.endMs - row.startMs) / 1000));
    }
    if (!Number.isFinite(row.gapMs)) row.gapMs = 0;
    this.rows.push(row);
    let arr = this.byApp.get(row.appId);
    if (!arr) {
      arr = [];
      this.byApp.set(row.appId, arr);
    }
    arr.push(row);
  }

  append(row) {
    ensureDir(path.dirname(this.file));
    const full = Object.assign(
      {
        v: 1,
        id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        start: toLocalIso(row.startMs),
        end: toLocalIso(row.endMs),
      },
      row
    );
    full.sec = Math.round((full.endMs - full.startMs) / 1000);
    fs.appendFileSync(this.file, JSON.stringify(full) + '\n');
    this._index(full);
    this.version++;
    return full;
  }

  all() {
    return this.rows;
  }

  forApp(appId) {
    return this.byApp.get(appId) || [];
  }

  remove(id) {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.id !== id);
    if (this.rows.length === before) return false;
    this._rewrite();
    return true;
  }

  removeByApp(appId) {
    this.rows = this.rows.filter((r) => r.appId !== appId);
    this._rewrite();
  }

  /**
   * 把一条记录改归到另一个软件名下（「记错软件了」）。
   * 起止时间、时长、休眠扣除全部原样保留，只换归属。
   */
  reassign(id, appId) {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return false;
    if (row.appId === appId) return true;
    row.appId = appId;
    this._rewrite();
    return true;
  }

  _rewrite() {
    ensureDir(path.dirname(this.file));
    const tmp = this.file + '.tmp';
    const text = this.rows.map((r) => JSON.stringify(r)).join('\n') + (this.rows.length ? '\n' : '');
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, this.file);
    this.byApp = new Map();
    const rows = this.rows;
    this.rows = [];
    for (const r of rows) this._index(r);
    this.version++;
  }
}

module.exports = { SessionStore, toLocalIso };
