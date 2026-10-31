'use strict';
/**
 * 进程扫描：整个程序唯一调用 tasklist 的地方。
 * - 一次拿到全部进程，全库共用，3 秒内重复调用直接吃缓存
 * - 输出是 CSV 且字段内含逗号（如 "8,656 K"），必须自己解析
 * - 中文 Windows 下可能是 GBK，也可能是 UTF-8，两种都试
 */

const { execFile } = require('child_process');

const CACHE_TTL = 1200; // 毫秒，同一轮轮询里多次调用只跑一次
let cached = null; // { at, snap }
let inflight = null; // Promise，合并并发

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuote = true;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

/** 进程名 → 统一比较用的键：小写、去掉 .exe */
function normalizeName(name) {
  return String(name || '')
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/\.exe$/i, '')
    .toLowerCase();
}

function makeEmptySnap() {
  return { byName: new Map(), byPid: new Set(), count: 0, at: Date.now(), error: null };
}

function parseTasklistBuffer(buf) {
  const snap = makeEmptySnap();
  const texts = [];

  // 严格 UTF-8 解不出来就换 GBK；两种都留着做名字匹配，谁中算谁
  try {
    texts.push(new TextDecoder('utf-8', { fatal: true }).decode(buf));
  } catch (e) {
    /* 不是合法 UTF-8 */
  }
  try {
    texts.push(new TextDecoder('gbk').decode(buf));
  } catch (e) {
    /* 理论上不会 */
  }
  if (!texts.length) texts.push(buf.toString('latin1'));

  for (const text of texts) {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line[0] !== '"') continue; // 跳过本地化提示行
      const f = splitCsvLine(line);
      if (f.length < 2) continue;
      const pid = parseInt(f[1], 10);
      if (!Number.isFinite(pid)) continue;

      snap.byPid.add(pid);
      const key = normalizeName(f[0]);
      if (!key) continue;
      let set = snap.byName.get(key);
      if (!set) {
        set = new Set();
        snap.byName.set(key, set);
      }
      set.add(pid);
    }
  }
  // 同一次任务在两种编码里各出现一次，按 pid 去重后计数
  snap.count = snap.byPid.size;
  return snap;
}

function runTasklist() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(
      'tasklist.exe',
      ['/FO', 'CSV', '/NH'],
      { windowsHide: true, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        const costMs = Date.now() - t0;
        if (err && (!stdout || !stdout.length)) {
          const snap = makeEmptySnap();
          snap.error = err.message || String(err);
          snap.costMs = costMs;
          resolve(snap);
          return;
        }
        let snap;
        try {
          snap = parseTasklistBuffer(stdout);
        } catch (e) {
          snap = makeEmptySnap();
          snap.error = e.message;
        }
        snap.costMs = costMs;
        resolve(snap);
      }
    );
  });
}

/** 取一次进程快照（默认吃 1.2 秒缓存） */
async function scan({ force = false } = {}) {
  const now = Date.now();
  if (!force && cached && now - cached.at < CACHE_TTL) return cached.snap;
  if (inflight) return inflight;

  inflight = runTasklist().then((snap) => {
    cached = { at: Date.now(), snap };
    inflight = null;
    return snap;
  });
  return inflight;
}

/** 某个键（进程名，不含 .exe）当前有几个实例 */
function countByName(snap, name) {
  const set = snap.byName.get(normalizeName(name));
  return set ? set.size : 0;
}

function hasName(snap, name) {
  const key = normalizeName(name);
  return !!key && snap.byName.has(key);
}

function hasPid(snap, pid) {
  return !!pid && snap.byPid.has(pid);
}

module.exports = {
  scan,
  hasName,
  hasPid,
  countByName,
  normalizeName,
  splitCsvLine,
  parseTasklistBuffer,
};
