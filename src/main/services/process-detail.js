'use strict';
/**
 * 进程详情（真实路径）：只在两种少见情况下才动用。
 *   1) 撞名：同一个进程名同时有多个在跑，需要靠路径分清哪个是库里的软件
 *   2) 启动器交接：进程没了，看同一个安装目录下有没有新进程顶上来
 *
 * 为什么要单独一个服务：拿路径只能调 PowerShell，冷启动要 1 秒多，不能塞进 3 秒一次的轮询里。
 * 这里做了缓存 + 并发合并，同一个 pid 45 秒内只查一次；全量列表 8 秒内复用。
 * 查不到（受保护的系统进程、权限不够）一律返回空，绝不抛错。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { runPs } = require('./icon-extract');

const PID_TTL = 45000;
const ALL_TTL = 8000;

const pidCache = new Map(); // pid -> { name, path, at }
let allCache = null; // { rows, at }
let pidInflight = null;
let allInflight = null;

function norm(p) {
  return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function readResult(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\ufeff/, '');
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

async function runQuery(args) {
  const tmp = path.join(os.tmpdir(), 'ts-proc-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.json');
  try {
    await runPs('proc-detail.ps1', args.concat(['-OutFile', tmp]), 20000);
    return readResult(tmp);
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (e) {
      /* 忽略 */
    }
  }
}

/** 全量进程表（带路径），8 秒内复用 */
async function allProcesses() {
  const now = Date.now();
  if (allCache && now - allCache.at < ALL_TTL) return allCache.rows;
  if (allInflight) return allInflight;

  allInflight = runQuery(['-All'])
    .then((rows) => {
      const now2 = Date.now();
      for (const r of rows) {
        const pid = Number(r.pid);
        if (!Number.isFinite(pid)) continue;
        pidCache.set(pid, { name: String(r.name || ''), path: String(r.path || ''), at: now2 });
      }
      allCache = { rows, at: now2 };
      allInflight = null;
      return rows;
    })
    .catch(() => {
      allInflight = null;
      return [];
    });
  return allInflight;
}

/** 指定一批 pid 的真实路径：Map<pid, path>（拿不到的不会出现在里面） */
async function pathsFor(pids) {
  const want = [];
  const out = new Map();
  const now = Date.now();

  for (const raw of pids || []) {
    const pid = Number(raw);
    if (!Number.isFinite(pid)) continue;
    const hit = pidCache.get(pid);
    if (hit && now - hit.at < PID_TTL) {
      if (hit.path) out.set(pid, hit.path);
      continue;
    }
    want.push(pid);
  }
  if (!want.length) return out;

  if (pidInflight) {
    await pidInflight;
    for (const pid of want) {
      const hit = pidCache.get(pid);
      if (hit && hit.path) out.set(pid, hit.path);
    }
    return out;
  }

  pidInflight = runQuery(['-Pids', want.join(',')])
    .then((rows) => {
      const at = Date.now();
      for (const r of rows) {
        const pid = Number(r.pid);
        if (!Number.isFinite(pid)) continue;
        pidCache.set(pid, { name: String(r.name || ''), path: String(r.path || ''), at });
      }
      pidInflight = null;
      return rows;
    })
    .catch(() => {
      pidInflight = null;
      return [];
    });

  await pidInflight;
  for (const pid of want) {
    const hit = pidCache.get(pid);
    if (hit && hit.path) out.set(pid, hit.path);
  }
  return out;
}

/**
 * 这个安装目录下现在有哪些进程在跑（返回归一化后的进程名列表）。
 * 用于启动器交接：主进程退出后，同目录冒出来的新进程就是「本体」。
 */
async function namesInDir(dir, excludeName) {
  const base = norm(dir);
  if (!base) return [];
  const rows = await allProcesses();
  const out = [];
  const prefix = base + '\\';
  for (const r of rows) {
    const p = norm(r.path);
    if (!p || !p.startsWith(prefix)) continue;
    const name = String(r.name || '').replace(/\.exe$/i, '').toLowerCase();
    if (!name) continue;
    if (excludeName && name === excludeName) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** 某个 pid 是不是跑在这个目录下（撞名时用来确认身份） */
async function pidInDir(pid, dir) {
  const map = await pathsFor([pid]);
  const p = norm(map.get(Number(pid)));
  const base = norm(dir);
  if (!p || !base) return null; // 查不到：交给调用方按「不确定」处理
  return p.startsWith(base + '\\') ? true : false;
}

function clearCache() {
  pidCache.clear();
  allCache = null;
}

module.exports = { pathsFor, namesInDir, pidInDir, allProcesses, clearCache };
