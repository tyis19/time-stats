'use strict';
/**
 * 计时核心：判断「还在不在跑」并维护一次会话的生死。
 *
 * 状态机：
 *   IDLE → STARTING → RUNNING → (HANDOVER) → IDLE
 *   用户手动停表 → SUPPRESSED（进程不退就不再自动起表）
 *
 * 判活三级：进程号 → 主进程名 → 同目录候选进程名（启动器交接）
 */

const { EventEmitter } = require('events');
const scanMod = require('./process-scan');

const STATE = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  HANDOVER: 'HANDOVER',
  SUPPRESSED: 'SUPPRESSED',
};

const MIN_SESSION_SEC = 2; // 少于 2 秒的抖动不入库

class Tracker extends EventEmitter {
  constructor(deps) {
    super();
    this.sessions = deps.sessions;
    this.apps = deps.apps;
    this.launcher = deps.launcher;
    this.getSettings = deps.getSettings;
    this.persistActive = deps.persistActive || (() => {});
    this.readActive = deps.readActive || (() => []);

    this.runtimes = new Map();
    this.autoPrev = new Map();
    this.suppressed = new Set();
    this.timer = null;
    this.currentDelay = 0;
    this.ticking = false;
    this.lastHeartbeat = 0;
    this.suspendAt = 0;
    this.stats_ = { ticks: 0, lastScanMs: 0 };
  }

  _rt(appId) {
    let r = this.runtimes.get(appId);
    if (!r) {
      r = {
        appId,
        state: STATE.IDLE,
        source: null,
        pid: null,
        primary: '',
        alts: [],
        startedMs: null,
        lastSeenMs: null,
        launchedMs: null,
        missed: 0,
        handoverUntil: 0,
        primaryGoneAt: 0,
        gapMs: 0,
      };
      this.runtimes.set(appId, r);
    }
    return r;
  }

  isBusy(appId) {
    const r = this.runtimes.get(appId);
    return !!r && r.state !== STATE.IDLE;
  }

  snapshot() {
    const now = Date.now();
    const out = [];
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.IDLE) continue;
      const startedMs = r.startedMs || r.launchedMs || now;
      out.push({
        appId: r.appId,
        state: r.state,
        startedMs,
        source: r.source,
        elapsedSec:
          r.state === STATE.STARTING || r.state === STATE.HANDOVER || r.state === STATE.RUNNING
            ? Math.max(0, Math.round((now - startedMs - Math.round(r.gapMs)) / 1000))
            : 0,
      });
    }
    return out;
  }

  captureActive() {
    const now = Date.now();
    const list = [];
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.IDLE) continue;
      list.push({
        appId: r.appId,
        state: r.state,
        startMs: r.startedMs || r.launchedMs || now,
        lastSeenMs: r.lastSeenMs || now,
        pid: r.pid || null,
        primary: r.primary || '',
        source: r.source,
      });
    }
    return list;
  }

  /* ------------------------------ 启动 / 停止 ------------------------------ */

  async start(appId, source) {
    const app = this.apps.get(appId);
    if (!app) return { ok: false, reason: '这个软件不在库里' };

    const r = this._rt(appId);
    if (r.state === STATE.SUPPRESSED) {
      // 用户停过表又主动点了开始：解除抑制，重新计时
      r.state = STATE.IDLE;
      this.suppressed.delete(appId);
    }
    if (r.state !== STATE.IDLE) return { ok: false, reason: '已经在计时了' };

    const src = source || 'launcher';
    r.state = STATE.STARTING;
    r.source = src;
    r.launchedMs = Date.now();
    r.startedMs = null;
    r.lastSeenMs = null;
    r.pid = null;
    r.missed = 0;
    r.gapMs = 0;
    r.primary = scanMod.normalizeName(app.imageName || app.name);

    // 候选进程：排除「启动前就已经在跑」的，避免把后台小工具当成本体
    try {
      const snap = await scanMod.scan({ force: true });
      r.alts = (app.altNames || [])
        .map(scanMod.normalizeName)
        .filter((n) => n && n !== r.primary && !snap.byName.has(n));
    } catch (e) {
      r.alts = [];
    }

    const result = await this.launcher.launch(app);
    if (!result.ok) {
      r.state = STATE.IDLE;
      r.source = null;
      r.pid = null;
      return { ok: false, reason: result.reason };
    }

    r.pid = result.pid || null;
    r.launchedMs = Date.now();
    this.ensureTimer();
    this.emit('update');
    return { ok: true, pid: r.pid, mode: result.mode };
  }

  async stop(appId, opts) {
    const options = opts || {};
    const r = this._rt(appId);
    if (r.state === STATE.IDLE) return { ok: true };

    const pid = r.pid;
    if (options.kill && pid) {
      await this.launcher.killTree(pid);
    }

    this._finish(r, Date.now(), options.kill ? 'manual-kill' : 'manual');
    // 进程可能还在跑：压住自动监视，直到它真的退出
    this.suppressed.add(appId);
    r.state = STATE.SUPPRESSED;
    this.ensureTimer();
    this.emit('update');
    return { ok: true };
  }

  /** 退出程序时，把还开着的会话按当前时间收尾 */
  stopAll(reason) {
    const now = Date.now();
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.RUNNING || r.state === STATE.HANDOVER || r.state === STATE.STARTING) {
        this._finish(r, now, reason || 'shutdown');
      }
    }
    this.stopTimer();
  }

  /* ------------------------------ 主循环 ------------------------------ */

  ensureTimer() {
    if (this.timer) return;
    const s = this.getSettings();
    const delay = this._wantDelay(s);
    if (!delay) return;
    this.currentDelay = delay;
    this.timer = setTimeout(() => this.tick(), delay);
  }

  stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.currentDelay = 0;
  }

  _wantDelay(s) {
    let hasActive = false;
    let hasSuppressed = false;
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.SUPPRESSED) hasSuppressed = true;
      else if (r.state !== STATE.IDLE) hasActive = true;
    }
    if (hasActive) return s.pollActiveMs;
    if (hasSuppressed) return s.pollActiveMs; // 停表后仍要盯着进程何时退出
    if (s.autoWatch) return s.pollWatchMs;
    return 0;
  }

  async tick() {
    this.timer = null;
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const s = this.getSettings();
      const t0 = Date.now();
      const snap = await scanMod.scan({ force: true });
      this.stats_.ticks++;
      this.stats_.lastScanMs = Date.now() - t0;

      for (const r of this.runtimes.values()) {
        if (r.state === STATE.IDLE) continue;
        this._advance(r, snap, now, s);
      }

      if (s.autoWatch) this._autoWatch(snap, now, s);
      else if (this.autoPrev.size) this.autoPrev.clear();

      if (now - this.lastHeartbeat >= s.heartbeatMs) {
        this.lastHeartbeat = now;
        this.persistActive();
      }

      this.emit('update');
    } catch (e) {
      this.emit('tracker-error', e);
    } finally {
      this.ticking = false;
      const s = this.getSettings();
      const delay = this._wantDelay(s);
      if (delay) {
        this.currentDelay = delay;
        this.timer = setTimeout(() => this.tick(), delay);
      } else {
        this.currentDelay = 0;
      }
    }
  }

  _alive(r, snap) {
    if (r.pid && snap.byPid.has(r.pid)) return 'pid';
    if (r.primary && snap.byName.has(r.primary)) return 'name';
    return null;
  }

  _altAlive(r, snap) {
    for (const n of r.alts) {
      if (snap.byName.has(n)) return n;
    }
    return null;
  }

  _advance(r, snap, now, s) {
    switch (r.state) {
      case STATE.STARTING: {
        if (this._alive(r, snap)) {
          r.state = STATE.RUNNING;
          r.startedMs = r.launchedMs || now;
          r.lastSeenMs = now;
          r.missed = 0;
          this.persistActive();
          this.emit('session-started', { appId: r.appId, startMs: r.startedMs, source: r.source });
          return;
        }
        if (now - (r.launchedMs || now) > s.startTimeoutMs) {
          r.state = STATE.IDLE;
          r.source = null;
          r.pid = null;
          this.emit('launch-failed', { appId: r.appId });
          this.persistActive();
        }
        return;
      }

      case STATE.RUNNING: {
        if (this._alive(r, snap)) {
          r.lastSeenMs = now;
          r.missed = 0;
          return;
        }
        r.missed++;

        // 刚启动没几秒主进程就没了 → 典型「启动器交出控制权」，等本体出现
        const livedMs = (r.lastSeenMs || now) - (r.startedMs || now);
        const looksLikeLauncher = livedMs < s.launcherQuickExitMs;

        if (r.missed === 1 && r.alts.length && looksLikeLauncher) {
          r.state = STATE.HANDOVER;
          r.primaryGoneAt = r.lastSeenMs || now;
          r.handoverUntil = now + s.handoverWindowMs;
          this.emit('handover', { appId: r.appId });
          return;
        }

        if (r.missed >= s.graceTicks) {
          this._finish(r, (r.lastSeenMs || now) + Math.round(s.pollActiveMs / 2), 'normal');
        }
        return;
      }

      case STATE.HANDOVER: {
        const alt = this._altAlive(r, snap);
        if (alt) {
          r.primary = alt;
          r.alts = [];
          r.state = STATE.RUNNING;
          r.missed = 0;
          r.lastSeenMs = now;
          this.emit('handover-done', { appId: r.appId, process: alt });
          return;
        }
        if (now > r.handoverUntil) {
          this._finish(r, (r.primaryGoneAt || now) + Math.round(s.pollActiveMs / 2), 'launcher-exit');
        }
        return;
      }

      case STATE.SUPPRESSED: {
        if (!this._alive(r, snap) && !this._altAlive(r, snap)) {
          r.state = STATE.IDLE;
          r.source = null;
          this.suppressed.delete(r.appId);
          this.persistActive();
        }
        return;
      }

      default:
        return;
    }
  }

  _autoWatch(snap, now, s) {
    for (const app of this.apps.list()) {
      if (app.watch === false) continue;
      const r = this._rt(app.id);
      const key = scanMod.normalizeName(app.imageName || app.name);
      const set = snap.byName.get(key);
      const cur = set ? set.size : 0;
      const prev = this.autoPrev.has(app.id) ? this.autoPrev.get(app.id) : cur;

      if (r.state === STATE.IDLE && !this.suppressed.has(app.id) && prev === 0 && cur > 0) {
        r.state = STATE.RUNNING;
        r.source = 'autowatch';
        r.startedMs = now - Math.round(s.pollActiveMs / 2);
        r.lastSeenMs = now;
        r.primary = key;
        r.alts = [];
        r.pid = null;
        r.missed = 0;
        r.gapMs = 0;
        this.persistActive();
        this.emit('session-started', { appId: app.id, startMs: r.startedMs, source: 'autowatch' });
      }
      this.autoPrev.set(app.id, cur);
    }
  }

  /** 打开自动监视时做基线：已经在跑的不计入 */
  async resetBaseline() {
    try {
      const snap = await scanMod.scan({ force: true });
      this.autoPrev.clear();
      for (const app of this.apps.list()) {
        const key = scanMod.normalizeName(app.imageName || app.name);
        const set = snap.byName.get(key);
        this.autoPrev.set(app.id, set ? set.size : 0);
      }
      this.ensureTimer();
      this.emit('update');
    } catch (e) {
      /* 忽略 */
    }
  }

  _finish(r, endMs, reason, opts) {
    const options = opts || {};
    const s = this.getSettings();
    const startMs = r.startedMs || r.launchedMs || endMs;
    let end = Math.max(startMs, endMs);
    if (end - startMs > s.maxSessionMs) end = startMs + s.maxSessionMs;

    const sec = Math.max(0, Math.round((end - startMs) / 1000));
    let row = null;
    if (sec >= MIN_SESSION_SEC) {
      row = this.sessions.append({
        appId: r.appId,
        startMs,
        endMs: end,
        gapMs: Math.max(0, Math.round(r.gapMs)),
        source: r.source || 'launcher',
        closedBy: reason,
        pid: r.pid || null,
        image: r.primary || '',
        recovered: !!options.recovered,
      });
    }

    r.state = STATE.IDLE;
    r.startedMs = null;
    r.lastSeenMs = null;
    r.launchedMs = null;
    r.pid = null;
    r.missed = 0;
    r.gapMs = 0;
    r.source = null;
    r.alts = [];
    r.handoverUntil = 0;

    this.persistActive();
    if (row) this.emit('session-ended', row);
    return row;
  }

  /** 开程序时恢复上次没关掉的会话 */
  async recover() {
    let active = [];
    try {
      active = this.readActive() || [];
    } catch (e) {
      active = [];
    }
    if (!Array.isArray(active) || !active.length) return { resumed: 0, closed: 0 };

    const snap = await scanMod.scan({ force: true });
    const now = Date.now();
    let resumed = 0;
    let closed = 0;

    for (const a of active) {
      const app = this.apps.get(a.appId);
      if (!app || !a.startMs) continue;
      const alive = (a.pid && snap.byPid.has(a.pid)) || (a.primary && snap.byName.has(a.primary));
      const fresh = now - (a.lastSeenMs || 0) < 10 * 60000;

      if (alive && fresh) {
        const r = this._rt(a.appId);
        r.state = STATE.RUNNING;
        r.source = a.source || 'launcher';
        r.startedMs = a.startMs;
        r.lastSeenMs = now;
        r.pid = a.pid || null;
        r.primary = a.primary || scanMod.normalizeName(app.imageName || app.name);
        r.missed = 0;
        resumed++;
      } else {
        const r = {
          appId: a.appId,
          state: STATE.RUNNING,
          source: a.source || 'launcher',
          pid: a.pid || null,
          primary: a.primary || '',
          altNames: [],
          alts: [],
          startedMs: a.startMs,
          lastSeenMs: a.lastSeenMs || a.startMs,
          gapMs: 0,
        };
        this._finish(r, Math.min(a.lastSeenMs || now, now), 'recovered', { recovered: true });
        closed++;
      }
    }

    if (resumed) this.ensureTimer();
    return { resumed, closed };
  }

  /* ------------------------------ 睡眠 / 锁屏 ------------------------------ */

  onSuspend() {
    this.suspendAt = Date.now();
    this.stopTimer();
  }

  onResume() {
    if (!this.suspendAt) return;
    const gap = Date.now() - this.suspendAt;
    this.suspendAt = 0;
    if (gap > 60000) {
      for (const r of this.runtimes.values()) {
        if (r.state === STATE.RUNNING || r.state === STATE.HANDOVER) r.gapMs += gap;
      }
      this.persistActive();
    }
    this.ensureTimer();
    this.emit('update');
  }
}

module.exports = { Tracker, STATE };
