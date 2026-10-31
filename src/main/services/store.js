'use strict';
/**
 * 存盘小工具：先写临时文件 → 强制落盘 → 改名替换。
 * 这样即使写到一半断电，原来的文件也不会变成半截垃圾。
 */

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  for (const candidate of [file, file + '.bak']) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const text = fs.readFileSync(candidate, 'utf8');
      if (!text.trim()) continue;
      return JSON.parse(text);
    } catch (e) {
      // 坏了就试 .bak
    }
  }
  return typeof fallback === 'function' ? fallback() : fallback;
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (fs.existsSync(file)) {
    try {
      fs.copyFileSync(file, file + '.bak');
    } catch (e) {
      /* 备份失败不影响主流程 */
    }
  }
  fs.renameSync(tmp, file);
}

module.exports = { readJson, writeJson, ensureDir };
