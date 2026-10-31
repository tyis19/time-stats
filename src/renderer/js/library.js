'use strict';
/** 库：卡片墙 */

const Library = {
  filtered() {
    const s = App.state;
    const q = s.query.trim().toLowerCase();
    let list = s.apps.slice();
    if (q) {
      list = list.filter(
        (a) => a.name.toLowerCase().includes(q) || (a.exePath || '').toLowerCase().includes(q)
      );
    }
    const dir = s.sortDir === 'asc' ? 1 : -1;
    const key = s.sort;
    list.sort((a, b) => {
      if (key === 'name') return a.name.localeCompare(b.name, 'zh-CN') * (s.sortDir === 'desc' ? -1 : 1);
      if (key === 'total') return ((b.stats.totalSec || 0) - (a.stats.totalSec || 0)) * dir;
      if (key === 'created') return ((b.createdMs || 0) - (a.createdMs || 0)) * dir;
      const av = a.stats.lastUsedMs || 0;
      const bv = b.stats.lastUsedMs || 0;
      return (bv - av) * dir;
    });
    return list;
  },

  render() {
    const grid = document.getElementById('grid');
    const countEl = document.getElementById('lib-count');
    const emptyEl = document.getElementById('lib-empty');
    const list = this.filtered();

    countEl.textContent = App.state.apps.length ? '共 ' + App.state.apps.length + ' 个' : '';
    grid.innerHTML = '';

    if (!list.length) {
      emptyEl.hidden = false;
      emptyEl.querySelector('h3').textContent = App.state.query ? '没有找到匹配的软件' : '还没有添加任何软件';
      emptyEl.querySelector('p').innerHTML = App.state.query
        ? '换个关键词试试，或者清空搜索框。'
        : '点右上角「＋ 新建」，从电脑里挑一个 .exe 程序。<br />以后每次从这里启动它，都会自动记录用了多久。';
      emptyEl.querySelector('button').style.display = App.state.query ? 'none' : '';
      return;
    }
    emptyEl.hidden = true;

    const frag = document.createDocumentFragment();
    for (const app of list) frag.appendChild(this.card(app));
    grid.appendChild(frag);
  },

  card(app) {
    const running = app.running && (app.running.state === 'RUNNING' || app.running.state === 'STARTING' || app.running.state === 'HANDOVER');
    const node = document.createElement('article');
    node.className = 'card' + (running ? ' running' : '') + (app.exists ? '' : ' missing');
    node.dataset.id = app.id;

    const st = app.stats || {};
    const meta =
      '<span class="line">共 ' + U.fmtDuration(st.totalSec || 0) + '</span>' +
      (st.todaySec ? '<span class="line today">今天 ' + U.fmtDuration(st.todaySec) + '</span>' : '') +
      '<span class="line">最后使用 ' + U.fmtWhen(st.lastUsedMs) + '</span>';

    const iconHtml = app.iconFile
      ? '<img src="' + U.iconUrl(app.iconFile) + '" alt="" draggable="false" />'
      : '<div class="card-tile" style="' + U.tileStyle(app.name) + '">' + U.esc(U.initials(app.name)) + '</div>';

    const liveHtml = running
      ? '<div class="card-live" data-live-id="' + app.id + '"><span class="pulse"></span><span class="live-text">' +
        U.fmtDuration(Math.floor((Date.now() - app.running.startedMs) / 1000)) + '</span></div>'
      : '';

    node.innerHTML =
      '<div class="card-icon">' + iconHtml + '</div>' +
      '<div class="card-name" title="' + U.esc(app.name) + '">' + U.esc(app.name) + '</div>' +
      (running ? liveHtml : '<div class="card-meta">' + meta + '</div>') +
      '<div class="card-actions">' +
      (running
        ? '<button class="btn stop sm" data-act="stop">■ 结束</button>'
        : '<button class="btn primary sm" data-act="start">▶ 开始</button>') +
      '<button class="btn ghost sm" data-act="detail">详情</button>' +
      '</div>';

    return node;
  },

  /** 每秒只改计时文字，不重绘整个列表 */
  updateLive() {
    const running = App.state.running;
    for (const node of document.querySelectorAll('.card')) {
      const id = node.dataset.id;
      const r = running.get(id);
      const live = node.querySelector('[data-live-id]');
      const isRunning = r && (r.state === 'RUNNING' || r.state === 'STARTING' || r.state === 'HANDOVER');
      if (live && isRunning) {
        const txt = live.querySelector('.live-text');
        if (txt) txt.textContent = U.fmtDuration(Math.floor((Date.now() - r.startedMs) / 1000));
      }
    }
  },

  bind() {
    const grid = document.getElementById('grid');
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const id = card.dataset.id;
      const act = e.target.closest('[data-act]');
      if (act) {
        e.stopPropagation();
        const a = act.dataset.act;
        if (a === 'start') App.startApp(id);
        else if (a === 'stop') App.stopApp(id, false);
        else if (a === 'detail') Detail.open(id);
        return;
      }
      Detail.open(id);
    });

    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      App.showCardMenu(card.dataset.id, e.clientX, e.clientY);
    });
  },
};
