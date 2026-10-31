'use strict';
/**
 * 诊断日志：默认关闭，打开后写 data/debug.log。
 *
 * 目的只有一个：用户说「我这个游戏没记上」时，能看出是哪一步把它拦下的
 * （进程没扫到 / 名字对不上 / 被判成启动器 / 在基线里已经跑着 / 去抖还没满）。
 *
 * 规则：
 *   · 只在开关打开时才写，关闭时连字符串都不拼（几乎零开销）
 *   · 单个文件 2MB，最多留 3 个历史文件，不会撑爆硬盘
 *   · 只记「库里这些软件的判定过程」，不记用户其它进程在干嘛
 */

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 3;

function pad(n, w) {
  return String(n).padStart(w || 2, '0');
}

function stamp() {
  const d = new Date();
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3)
  );
}

class Logger {
  constructor() {
    this.dir = null;
    this.enabled = false;
    this.file = null;
    this.bytes = 0;
    this.writeError = null;
  }

  configure({ dir, enabled }) {
    this.dir = dir || this.dir;
    if (this.dir) this.file = path.join(this.dir, 'debug.log');
    this.setEnabled(!!enabled);
    if (this.file) {
      try {
        this.bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
      } catch (e) {
        this.bytes = 0;
      }
    }
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (this.enabled) this.info('log', '诊断日志已开启');
  }

  _rotate() {
    try {
      for (let i = KEEP - 1; i >= 1; i--) {
        const from = this.file + '.' + i;
        const to = this.file + '.' + (i + 1);
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      if (fs.existsSync(this.file)) fs.renameSync(this.file, this.file + '.1');
    } catch (e) {
      /* 轮转失败不影响主流程 */
    }
    this.bytes = 0;
  }

  write(level, tag, msg, data) {
    if (!this.enabled || !this.file) return;
    let line = stamp() + ' [' + level + '] ' + tag + '  ' + msg;
    if (data !== undefined) {
      try {
        line += '  ' + JSON.stringify(data);
      } catch (e) {
        line += '  (数据无法序列化)';
      }
    }
    line += '\n';
    try {
      const buf = Buffer.from(line, 'utf8');
      if (this.bytes + buf.length > MAX_BYTES) this._rotate();
      fs.appendFileSync(this.file, buf);
      this.bytes += buf.length;
    } catch (e) {
      this.writeError = e.message;
    }
  }

  info(tag, msg, data) {
    this.write('INFO', tag, msg, data);
  }

  warn(tag, msg, data) {
    this.write('WARN', tag, msg, data);
  }

  debug(tag, msg, data) {
    if (this.enabled) this.write('DEBUG', tag, msg, data);
  }

  path() {
    return this.file;
  }
}

const logger = new Logger();

module.exports = { logger, Logger };
