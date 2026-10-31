'use strict';
/**
 * 计时核心：判断「还在不在跑」并维护一次会话的生死。
 *
 * 状态机：
 *   IDLE → STARTING → RUNNING → (HANDOVER) → IDLE     手动从本工具启动
 *   IDLE → CANDIDATE → RUNNING → (HANDOVER) → IDLE    自动监视（先去抖观察一会儿）
 *   用户手动停表 → SUPPRESSED（进程不退就不再自动起表）
 *
 * 判活三级：进程号+进程名 → 主进程名 → 同目录候选进程名（启动器交接）
 *
 * 几个刻意的设计：
 *   · 判活同时核对进程号和进程名。只核对号的话，进程号被系统回收再分配时会以为程序还开着。
 *   · 自动监视要「活过 debounceMs」才真正建会话，一闪而过的启动器不会留下垃圾记录。
 *   · 两次检查之间如果隔了很久（系统卡死），那段时间只扣掉、不算时长；隔太久才判中断结账。
 *   · 同名进程有多个时，才去查真实路径区分——查路径要调 PowerShell，不能常做。
 */

const { EventEmitter } = require('events');
const scanMod = require('./process-scan');
const procDetail = require('./process-detail');
const { logger } = require('./logger');

const STATE = {
  IDLE: 'IDLE',
  CANDIDATE: 'CANDIDATE',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  HANDOVER: 'HANDOVER',
  SUPPRESSED: 'SUPPRESSED',
};

const MIN_SESSION_SEC = 2; // 少于 2 秒的抖动不入库
const DIR_PROBE_MS = 4000; // 同目录探测节流
const VERIFY_MS = 30000; // 撞名校验节流

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
    this.lastTickAt = 0;
    this.lastSummaryAt = 0;
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
        candidateSinceMs: 0,
        missed: 0,
        handoverUntil: 0,
        primaryGoneAt: 0,
        gapMs: 0,
        dirCandidates: [],
        dirProbedAt: 0,
        dirProbing: false,
        verifiedPids: null,
        verifiedAt: 0,
        verifyBusy: false,
      };
      this.runtimes.set(appId, r);
    }
    return r;
  }

  _resetRuntime(r) {
    r.state = STATE.IDLE;
    r.startedMs = null;
    r.lastSeenMs = null;
    r.launchedMs = null;
    r.candidateSinceMs = 0;
    r.pid = null;
    r.missed = 0;
    r.gapMs = 0;
    r.source = null;
    r.alts = [];
    r.handoverUntil = 0;
    r.primaryGoneAt = 0;
    r.dirCandidates = [];
    r.dirProbedAt = 0;
    r.dirProbing = false;
    r.verifiedPids = null;
    r.verifiedAt = 0;
  }

  _appName(appId) {
    const a = this.apps.get(appId);
    return a ? a.name : appId;
  }

  isBusy(appId) {
    const r = this.runtimes.get(appId);
    return !!r && r.state !== STATE.IDLE;
  }

  snapshot() {
    const now = Date.now();
    const out = [];
    for (const r of this.runtimes.values()) {
      // CANDIDATE 还不算真正在计时（可能只是个一闪而过的启动器），不显示到界面上
      if (r.state === STATE.IDLE || r.state === STATE.CANDIDATE) continue;
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
      if (r.state === STATE.IDLE || r.state === STATE.CANDIDATE) continue;
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
    r.candidateSinceMs = 0;
    r.dirCandidates = [];
    r.verifiedPids = null;
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
      logger.warn('start', '启动失败', { app: app.name, reason: result.reason });
      return { ok: false, reason: result.reason };
    }

    r.pid = result.pid || null;
    r.launchedMs = Date.now();
    logger.info('start', '已启动并开始计时', {
      app: app.name,
      pid: r.pid,
      主进程名: r.primary,
      候选: r.alts.length,
    });
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

  /**
   * 多久看一次进程表：
   *   有人在计时 → 3 秒（要尽快发现它退出）
   *   没人在计时、但开着自动监视 → 10 秒（省电，检测晚一点，靠把开始时间往前推补回来）
   *   啥都没开 → 不看（完全不耗 CPU）
   */
  _wantDelay(s) {
    let hasActive = false;
    let hasSuppressed = false;
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.SUPPRESSED) hasSuppressed = true;
      else if (r.state !== STATE.IDLE) hasActive = true;
    }
    if (hasActive || hasSuppressed) return s.pollActiveMs;
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

      this._checkStall(now, s);

      const t0 = Date.now();
      const snap = await scanMod.scan({ force: true });
      this.stats_.ticks++;
      this.stats_.lastScanMs = Date.now() - t0;

      for (const r of this.runtimes.values()) {
        if (r.state === STATE.IDLE) continue;
        this._advance(r, snap, now, s);
        this._maybeVerify(r, snap);
      }

      if (s.autoWatch) this._autoWatch(snap, now, s);
      else if (this.autoPrev.size) this.autoPrev.clear();

      if (now - this.lastHeartbeat >= s.heartbeatMs) {
        this.lastHeartbeat = now;
        this.persistActive();
      }

      if (now - this.lastSummaryAt >= 30000) {
        this.lastSummaryAt = now;
        let active = 0;
        for (const r of this.runtimes.values()) if (r.state !== STATE.IDLE) active++;
        logger.debug('tick', '巡检完成', {
          进程数: snap.count,
          耗时ms: this.stats_.lastScanMs,
          在跟踪: active,
          自动监视: !!s.autoWatch,
          间隔ms: this.currentDelay,
        });
      }

      this.emit('update');
    } catch (e) {
      logger.warn('tick', '巡检出错', { error: e.message });
      this.emit('tracker-error', e);
    } finally {
      this.ticking = false;
      this.lastTickAt = Date.now();
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

  /**
   * 两次检查之间隔了太久（系统卡死、时钟跳变、被挂起）。
   * 短时间：只把这几十秒扣掉，不虚增时长。
   * 太久（超过 stallBreakMs）：判中断结账，用「最后一次看到它」当结束时间。
   */
  _checkStall(now, s) {
    const prev = this.lastTickAt;
    if (!prev) return;
    const gap = now - prev;
    if (gap <= (s.stallMs || 20000)) return;

    let touched = 0;
    let broke = 0;
    for (const r of this.runtimes.values()) {
      if (r.state === STATE.IDLE || r.state === STATE.SUPPRESSED) continue;
      touched++;
      if (gap > (s.stallBreakMs || 300000)) {
        this._finish(r, r.lastSeenMs || prev, 'interrupted');
        broke++;
      } else {
        r.gapMs += gap;
      }
    }
    if (touched) {
      logger.warn('tick', '两次检查间隔异常', { 间隔秒: Math.round(gap / 1000), 涉及会话: touched, 判中断: broke });
      if (broke) this.persistActive();
    }
  }

  /**
   * 判活：进程号和进程名都要对得上。
   * 撞名（同名进程不止一个）且已经查到过真实路径时，只在属于本软件目录的那些 pid 里认。
   */
  _alive(r, snap) {
    if (r.pid && scanMod.pidMatches(snap, r.pid, r.primary)) return 'pid';
    if (!r.primary) return null;

    const set = snap.byName.get(r.primary);
    if (!set || !set.size) return null;

    if (r.verifiedPids && r.verifiedPids.size) {
      for (const pid of set) {
        if (r.verifiedPids.has(pid)) return 'name';
      }
      return null; // 同名，但都不是这个软件的进程
    }
    return 'name';
  }

  _altAlive(r, snap) {
    for (const n of r.alts) {
      if (snap.byName.has(n)) return n;
    }
    for (const n of r.dirCandidates) {
      if (snap.byName.has(n)) return n;
    }
    return null;
  }

  /**
   * 同名进程有多个时才查真实路径（要调 PowerShell，约 1.5 秒），30 秒内不重复查。
   * 平时单实例，一次都不会触发，零开销。
   */
  _maybeVerify(r, snap) {
    if (!r.primary) return;
    const set = snap.byName.get(r.primary);
    if (!set || set.size <= 1) {
      if (r.verifiedPids) r.verifiedPids = null;
      return;
    }
    const now = Date.now();
    if (r.verifyBusy || (r.verifiedAt && now - r.verifiedAt < VERIFY_MS)) return;

    const app = this.apps.get(r.appId);
    if (!app || !app.workDir) return;

    r.verifyBusy = true;
    logger.info('alive', '发现同名进程，按路径区分', {
      app: app.name,
      同名实例: set.size,
    });

    procDetail
      .pathsFor([...set])
      .then((map) => {
        const base = String(app.workDir).toLowerCase().replace(/\\+$/, '');
        const ok = new Set();
        for (const [pid, p] of map) {
          const low = String(p || '').toLowerCase();
          if (low && low.startsWith(base + '\\')) ok.add(pid);
        }
        r.verifiedPids = ok.size ? ok : null;
        r.verifiedAt = Date.now();
        r.verifyBusy = false;
        logger.debug('alive', '路径区分结果', { app: app.name, 属于本软件: ok.size, 同名总数: set.size });
      })
      .catch(() => {
        r.verifyBusy = false;
        r.verifiedAt = Date.now();
      });
  }

  /** 启动器交接：查同一个安装目录下现在有哪些进程（异步，不阻塞巡检） */
  _probeDir(r) {
    const now = Date.now();
    if (r.dirProbing) return;
    if (r.dirProbedAt && now - r.dirProbedAt < DIR_PROBE_MS) return;
    const app = this.apps.get(r.appId);
    if (!app || !app.workDir) return;

    r.dirProbedAt = now;
    r.dirProbing = true;
    procDetail
      .namesInDir(app.workDir, r.primary)
      .then((names) => {
        r.dirCandidates = names;
        r.dirProbing = false;
        if (names.length) logger.debug('handover', '同目录候选进程', { app: app.name, 名单: names });
      })
      .catch(() => {
        r.dirProbing = false;
      });
  }

  _advance(r, snap, now, s) {
    switch (r.state) {
      /* 自动监视新发现的进程：先观察，活过 debounceMs 才算数 */
      case STATE.CANDIDATE: {
        if (this._alive(r, snap)) {
          r.lastSeenMs = now;
          const waited = now - (r.candidateSinceMs || now);
          if (waited >= (s.debounceMs || 5000)) {
            r.state = STATE.RUNNING;
            r.startedMs = r.candidateSinceMs || now; // 从第一次看到算起，不丢这几秒
            r.missed = 0;
            this.persistActive();
            logger.info('session', '观察期满，开始计时', {
              app: this._appName(r.appId),
              等待秒: Math.round(waited / 1000),
            });
            this.emit('session-started', { appId: r.appId, startMs: r.startedMs, source: r.source });
          }
          return;
        }
        // 观察期内就没了 → 一闪而过，不留记录
        logger.info('watch', '进程一闪而过，未计入', {
          app: this._appName(r.appId),
          存活秒: Math.round((now - (r.candidateSinceMs || now)) / 1000),
        });
        this._resetRuntime(r);
        this.persistActive();
        return;
      }

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
          logger.warn('start', '启动后一直没看到进程', { app: this._appName(r.appId) });
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
        const app = this.apps.get(r.appId);
        const hasCandidates = r.alts.length > 0 || (app && app.altNames && app.altNames.length > 0);

        if (r.missed === 1 && looksLikeLauncher && hasCandidates) {
          // 兜底：自动监视建立的会话可能还没带候选名单，这里补上
          if (!r.alts.length && app && Array.isArray(app.altNames)) {
            r.alts = app.altNames.map(scanMod.normalizeName).filter((n) => n && n !== r.primary);
          }
          r.state = STATE.HANDOVER;
          r.primaryGoneAt = r.lastSeenMs || now;
          r.handoverUntil = now + (s.handoverWindowMs || 15000);
          logger.info('handover', '主进程提前退出，等本体出现', {
            app: this._appName(r.appId),
            存活秒: Math.round(livedMs / 1000),
            窗口秒: Math.round((s.handoverWindowMs || 15000) / 1000),
          });
          this._probeDir(r); // 异步补充「同目录现在真的有哪些进程」
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
          r.dirCandidates = [];
          r.verifiedPids = null;
          r.state = STATE.RUNNING;
          r.missed = 0;
          r.lastSeenMs = now;
          logger.info('handover', '交接成功，改盯本体进程', {
            app: this._appName(r.appId),
            新进程: alt,
          });
          this.emit('handover-done', { appId: r.appId, process: alt });
          return;
        }
        if (now > r.handoverUntil) {
          logger.info('handover', '交接窗口内没等到本体，按启动器退出结账', {
            app: this._appName(r.appId),
          });
          this._finish(r, (r.primaryGoneAt || now) + Math.round(s.pollActiveMs / 2), 'launcher-exit');
          return;
        }
        this._probeDir(r); // 还没等到，继续隔几秒查一次同目录
        return;
      }

      case STATE.SUPPRESSED: {
        if (!this._alive(r, snap) && !this._altAlive(r, snap)) {
          r.state = STATE.IDLE;
          r.source = null;
          this.suppressed.delete(r.appId);
          this.persistActive();
          logger.debug('suppress', '进程已退出，解除停表压制', { app: this._appName(r.appId) });
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
        // 不立刻建会话：先进候选态，活够 debounceMs 才算数
        r.state = STATE.CANDIDATE;
        r.source = 'autowatch';
        r.primary = key;
        r.candidateSinceMs = now;
        r.lastSeenMs = now;
        r.pid = null;
        // 同目录的候选进程先备着，万一这个是启动器，交接时立刻用得上
        r.alts = (app.altNames || [])
          .map(scanMod.normalizeName)
          .filter((n) => n && n !== key);
        r.missed = 0;
        r.gapMs = 0;
        r.dirCandidates = [];
        r.verifiedPids = null;
        logger.info('watch', '发现新进程，开始观察', {
          app: app.name,
          进程名: key,
          实例数: cur,
          门槛秒: Math.round((s.debounceMs || 5000) / 1000),
        });
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
      logger.info('watch', '重置基线（此刻已经在跑的软件不会被计入）');
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
      logger.info('session', '记录一次使用', {
        app: this._appName(r.appId),
        时长秒: sec,
        扣除秒: Math.round(r.gapMs / 1000),
        结束原因: reason,
        来源: r.source,
      });
    } else if (sec > 0) {
      logger.info('session', '太短，不入库', { app: this._appName(r.appId), 时长秒: sec, 结束原因: reason });
    }

    this._resetRuntime(r);
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
        logger.info('recover', '上次没关掉的会话，继续计时', { app: app.name });
      } else {
        // 用「最后一次心跳」当结束时间，宁可少算几秒，绝不多算
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
        logger.info('recover', '上次遗留的会话按最后心跳结账', { app: app.name });
      }
    }

    if (resumed) this.ensureTimer();
    return { resumed, closed };
  }

  /* ------------------------------ 睡眠 / 锁屏 ------------------------------ */

  onSuspend() {
    this.suspendAt = Date.now();
    this.stopTimer();
    logger.info('power', '系统进入睡眠，暂停巡检');
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
    this.lastTickAt = Date.now(); // 别把睡着的这段时间当成「系统卡死」
    logger.info('power', '系统唤醒，恢复巡检', { 睡眠秒: Math.round(gap / 1000) });
    this.ensureTimer();
    this.emit('update');
  }
}

module.exports = { Tracker, STATE };
