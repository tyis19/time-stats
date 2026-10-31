'use strict';
/** 界面总控：视图切换、全局事件、提示与弹窗 */

const App = {
  state: {
    apps: [],
    running: new Map(),
    settings: {},
    query: '',
    sort: 'lastUsed',
    sortDir: 'desc',
    view: 'library',
    detailId: null,
  },
  _runSig: '',

  async boot() {
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.card') && !e.target.closest('input')) e.preventDefault();
    });

    const info = await window.api.settings.get();
    this.state.settings = info.settings;
    this.state.sort = info.settings.sort || 'lastUsed';
    this.state.sortDir = info.settings.sortDir || 'desc';
    const sel = document.getElementById('sort-select');
    if (sel) sel.value = this.state.sort;

    this.bind();
    Library.bind();

    await this.refreshApps();

    const snap = await window.api.tracker.snapshot();
    this.onRunning(snap || []);

    window.api.onUpdate((s) => this.onRunning(s));
    window.api.onEvent((e) => this.onEvent(e));
    window.api.onAppsChanged(() => this.refreshApps());

    setInterval(() => {
      Library.updateLive();
      Detail.updateLive();
    }, 1000);
  },

  bind() {
    document.getElementById('tabs').addEventListener('click', (e) => {
      const btn = e.target.closest('.tab');
      if (btn) this.setView(btn.dataset.view);
    });

    const search = document.getElementById('search');
    search.addEventListener('input', () => {
      this.state.query = search.value;
      Library.render();
    });

    const sort = document.getElementById('sort-select');
    sort.addEventListener('change', async () => {
      this.state.sort = sort.value;
      Library.render();
      await window.api.settings.set({ sort: sort.value });
    });

    document.getElementById('btn-add').onclick = () => this.addApp();
    document.getElementById('btn-add-empty').onclick = () => this.addApp();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideMenu();
        this.closeModal();
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'f' && this.state.view === 'library') {
        e.preventDefault();
        search.focus();
      }
    });
  },

  async refreshApps() {
    this.state.apps = await window.api.apps.list();
    if (this.state.view === 'library') Library.render();
    if (this.state.view === 'stats') Stats.render();
  },

  setView(name) {
    this.state.view = name;
    document.body.dataset.view = name;
    for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === 'view-' + name);
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.dataset.view === name);

    const searchWrap = document.getElementById('search-wrap');
    const addBtn = document.getElementById('btn-add');
    const inDetail = name === 'detail';
    searchWrap.style.visibility = name === 'library' ? 'visible' : 'hidden';
    addBtn.style.visibility = name === 'library' ? 'visible' : 'hidden';

    if (name === 'library') Library.render();
    if (name === 'stats') Stats.render();
    if (name === 'settings') Settings.render();
    if (inDetail) {
      /* 详情页由 Detail.open 渲染 */
    }
    document.getElementById('content').scrollTop = 0;
  },

  /* ------------------------------ 动作 ------------------------------ */

  async addApp() {
    const r = await window.api.apps.add();
    if (!r || r.canceled) return;
    if (!r.ok) {
      this.toast(r.reason || '添加失败', 'err');
      return;
    }
    this.toast('已添加到库：' + r.app.name, 'ok');
    await this.refreshApps();
  },

  async startApp(id) {
    const r = await window.api.apps.launch(id);
    if (!r || !r.ok) {
      this.toast((r && r.reason) || '启动失败', 'err');
      return;
    }
  },

  async stopApp(id, kill) {
    if (kill) {
      const app = this.state.apps.find((a) => a.id === id);
      const ok = await this.confirm(
        '结束并关闭程序？',
        '会立刻停表，并把「' + (app ? app.name : '这个程序') + '」强制关闭。没保存的进度可能会丢。',
        '结束并关闭'
      );
      if (!ok) return;
    }
    await window.api.apps.stop({ id, kill: !!kill });
    this.toast(kill ? '已结束并关闭程序' : '已停止计时', 'ok');
    await this.refreshApps();
  },

  async relocateApp(id) {
    const r = await window.api.apps.relocate(id);
    if (!r || r.canceled) return;
    if (!r.ok) {
      this.toast(r.reason || '重新定位失败', 'err');
      return;
    }
    this.toast('位置已更新', 'ok');
    await this.refreshApps();
    if (this.state.view === 'detail') Detail.reload();
  },

  async removeApp(id) {
    const app = this.state.apps.find((a) => a.id === id);
    const choice = await this.choose(
      '移除「' + (app ? app.name : '这个软件') + '」',
      '移除后不再统计它。历史记录你可以选择保留或一起删掉。',
      [
        { key: 'cancel', label: '取消', ghost: true },
        { key: 'keep', label: '移除，保留记录' },
        { key: 'delete', label: '移除并删除记录', danger: true },
      ]
    );
    if (!choice || choice === 'cancel') return;
    const r = await window.api.apps.remove({ id, deleteSessions: choice === 'delete' });
    if (!r || !r.ok) {
      this.toast('移除失败', 'err');
      return;
    }
    this.toast(choice === 'delete' ? '已移除并删除记录' : '已移除，历史记录保留', 'ok');
    if (this.state.view === 'detail') this.setView('library');
    await this.refreshApps();
  },

  async exportCsv() {
    const r = await window.api.stats.exportCsv();
    if (!r || r.canceled) return;
    if (r.ok) this.toast('已导出到：' + r.filePath, 'ok');
    else this.toast(r.reason || '导出失败', 'err');
  },

  /* ------------------------------ 后台推送 ------------------------------ */

  onRunning(snapshot) {
    const map = new Map((snapshot || []).map((r) => [r.appId, r]));
    this.state.running = map;
    const sig = (snapshot || [])
      .map((r) => r.appId + ':' + r.state)
      .sort()
      .join('|');
    if (sig !== this._runSig) {
      this._runSig = sig;
      this.refreshApps();
    }
  },

  onEvent(evt) {
    if (!evt) return;
    if (evt.type === 'launch-failed') {
      const app = this.state.apps.find((a) => a.id === evt.appId);
      this.toast('「' + (app ? app.name : '程序') + '」没启动起来：可能授权被取消，或被安全软件拦了', 'err');
      this.refreshApps();
    } else if (evt.type === 'recovered') {
      if (evt.resumed) this.toast('已接着上次的计时继续记录', 'ok');
      if (evt.closed) this.toast('上次有一次使用没正常结束，已按最后记录时间补记', 'ok');
      this.refreshApps();
    } else if (evt.type === 'ended') {
      this.refreshApps();
    }
  },

  /* ------------------------------ 右键菜单 ------------------------------ */

  showCardMenu(id, x, y) {
    const app = this.state.apps.find((a) => a.id === id);
    if (!app) return;
    const running = this.state.running.get(id);
    const isRunning = running && running.state !== 'SUPPRESSED';

    const items = [
      { label: '查看详情', fn: () => Detail.open(id) },
      isRunning ? { label: '结束计时', fn: () => this.stopApp(id, false) } : { label: '开始', fn: () => this.startApp(id) },
      { label: '打开所在文件夹', fn: () => window.api.apps.reveal(id) },
      { label: '重新定位…', fn: () => this.relocateApp(id) },
      { sep: true },
    ];
    if (isRunning) items.push({ label: '结束并关闭程序', danger: true, fn: () => this.stopApp(id, true) });
    items.push({ label: '从库中移除…', danger: true, fn: () => this.removeApp(id) });

    this.renderMenu(items, x, y);
  },

  renderMenu(items, x, y) {
    const menu = document.getElementById('ctxmenu');
    menu.innerHTML = '';
    for (const it of items) {
      if (it.sep) {
        menu.appendChild(U.el('div', 'sep'));
        continue;
      }
      const node = U.el('div', 'item' + (it.danger ? ' danger' : ''), it.label);
      node.onclick = () => {
        this.hideMenu();
        it.fn();
      };
      menu.appendChild(node);
    }
    menu.hidden = false;
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    menu.style.left = Math.max(8, left) + 'px';
    menu.style.top = Math.max(8, top) + 'px';

    if (!this._menuBound) {
      this._menuBound = true;
      document.addEventListener('mousedown', (e) => {
        if (!e.target.closest('#ctxmenu')) this.hideMenu();
      });
      window.addEventListener('blur', () => this.hideMenu());
      document.getElementById('content').addEventListener('scroll', () => this.hideMenu());
    }
  },

  hideMenu() {
    const menu = document.getElementById('ctxmenu');
    if (menu) menu.hidden = true;
  },

  /* ------------------------------ 弹窗与提示 ------------------------------ */

  confirm(title, text, okLabel) {
    return this.choose(title, text, [
      { key: 'cancel', label: '取消', ghost: true },
      { key: 'ok', label: okLabel || '确定', danger: true },
    ]).then((r) => r === 'ok');
  },

  choose(title, text, buttons) {
    return new Promise((resolve) => {
      const wrap = document.getElementById('modal');
      wrap.hidden = false;
      wrap.innerHTML = '';
      const box = U.el('div', 'modal');
      box.innerHTML = '<h3>' + U.esc(title) + '</h3><p>' + text + '</p>';

      const actions = U.el('div', 'modal-actions');
      const close = (val) => {
        wrap.hidden = true;
        wrap.innerHTML = '';
        resolve(val);
      };
      for (const b of buttons) {
        const btn = U.el('button', 'btn ' + (b.danger ? 'danger' : b.ghost ? 'ghost' : 'primary'), b.label);
        btn.onclick = () => close(b.key);
        actions.appendChild(btn);
      }
      box.appendChild(actions);
      wrap.appendChild(box);
      wrap.onclick = (e) => {
        if (e.target === wrap) close(null);
      };
    });
  },

  closeModal() {
    const wrap = document.getElementById('modal');
    if (wrap && !wrap.hidden) {
      wrap.hidden = true;
      wrap.innerHTML = '';
    }
  },

  /** 从一列选项里挑一个，返回选项的 key（取消返回 null） */
  pick(title, text, items) {
    return new Promise((resolve) => {
      const wrap = document.getElementById('modal');
      wrap.hidden = false;
      wrap.innerHTML = '';
      const box = U.el('div', 'modal wide');
      box.innerHTML = '<h3>' + U.esc(title) + '</h3><p>' + text + '</p>';

      const close = (val) => {
        wrap.hidden = true;
        wrap.innerHTML = '';
        resolve(val);
      };

      const list = U.el('div', 'pick-list');
      if (!items.length) {
        list.innerHTML = '<div class="pick-empty">库里还没有别的软件</div>';
      }
      for (const it of items) {
        const row = U.el('button', 'pick-row');
        row.type = 'button';
        row.appendChild(U.el('span', 'pick-name', it.label));
        if (it.sub) row.appendChild(U.el('span', 'pick-sub', it.sub));
        row.onclick = () => close(it.key);
        list.appendChild(row);
      }
      box.appendChild(list);

      const actions = U.el('div', 'modal-actions');
      const cancel = U.el('button', 'btn ghost', '取消');
      cancel.onclick = () => close(null);
      actions.appendChild(cancel);
      box.appendChild(actions);

      wrap.appendChild(box);
      wrap.onclick = (e) => {
        if (e.target === wrap) close(null);
      };
    });
  },

  toast(text, type) {
    const wrap = document.getElementById('toasts');
    if (!wrap) return;
    const t = U.el('div', 'toast' + (type ? ' ' + type : ''), text);
    wrap.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s';
      t.style.opacity = '0';
      setTimeout(() => t.remove(), 260);
    }, 3000);
  },
};

window.addEventListener('DOMContentLoaded', () => {
  App.boot().catch((e) => {
    document.body.innerHTML = '<div style="padding:40px;color:#e2705f;font-family:Segoe UI">启动失败：' + U.esc(String(e)) + '</div>';
  });
});
