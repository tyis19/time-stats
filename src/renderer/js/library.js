'use strict';
/** 库：卡片墙 */

const Library = {
  filtered() {
    const s = App.state;
    let q = s.query.trim().toLowerCase();
    let tagQuery = '';
    if (q.charAt(0) === '#') {
      tagQuery = q.slice(1);
      q = '';
    }

    let list = s.apps.slice();

    // 标签筛选：没选就是全部；选了多个就是「有其中任意一个」
    list = list.filter((a) => Tags.matches(a));

    if (tagQuery) {
      const hit = Tags.list()
        .filter((t) => t.name.toLowerCase().includes(tagQuery))
        .map((t) => t.id);
      list = list.filter((a) => (a.tagIds || []).some((id) => hit.indexOf(id) >= 0));
    }

    if (q) {
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.autoName || '').toLowerCase().includes(q) ||
          (a.exePath || '').toLowerCase().includes(q) ||
          Tags.ofApp(a).some((t) => t.name.toLowerCase().includes(q))
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

    // 重绘前记住谁正在输入中文名，重绘后把光标放回去，免得打字打到一半被冲掉
    const keep = this._keepFocus();

    Tags.renderChips(document.getElementById('lib-tagbar'), () => this.render());

    const list = this.filtered();
    const total = App.state.apps.length;
    const filtering = App.state.tagFilter.size > 0 || !!App.state.query.trim();

    countEl.textContent = total
      ? filtering
        ? '筛出 ' + list.length + ' / ' + total + ' 个'
        : '共 ' + total + ' 个'
      : '';
    grid.innerHTML = '';

    if (!list.length) {
      emptyEl.hidden = false;
      const byTag = App.state.tagFilter.size > 0;
      emptyEl.querySelector('h3').textContent = App.state.query
        ? '没有找到匹配的软件'
        : byTag
          ? '这个标签下还没有软件'
          : '还没有添加任何软件';
      emptyEl.querySelector('p').innerHTML = App.state.query
        ? '换个关键词试试，或者点「全部」清空筛选。'
        : byTag
          ? '点标签筛选条右边的「管理标签」，在标签上点「管理软件」，把软件勾进来；<br />也可以右键软件卡片选「设置标签」。'
          : '点右上角「＋ 新建」，从电脑里挑一个 .exe 程序。<br />以后每次从这里启动它，都会自动记录用了多久。';
      emptyEl.querySelector('button').style.display = filtering ? 'none' : '';
      return;
    }
    emptyEl.hidden = true;

    const frag = document.createDocumentFragment();
    for (const app of list) frag.appendChild(this.card(app));
    grid.appendChild(frag);
    this._restoreFocus(keep);
  },

  /** 记录正在编辑的输入框（没在编辑就返回 null） */
  _keepFocus() {
    const a = document.activeElement;
    if (!a || !a.classList || !a.classList.contains('card-name-input')) return null;
    return { id: a.dataset.nameFor, pos: a.selectionStart == null ? 0 : a.selectionStart };
  },

  _restoreFocus(keep) {
    if (!keep) return;
    const inp = document.querySelector('.card-name-input[data-name-for="' + keep.id + '"]');
    if (!inp) return;
    inp.focus();
    const pos = Math.min(keep.pos, inp.value.length);
    try {
      inp.setSelectionRange(pos, pos);
    } catch (e) {
      /* 忽略 */
    }
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
    const tagRow = Tags.cardTagsHtml(app);

    const iconHtml = app.iconFile
      ? '<img src="' + U.iconUrl(app.iconFile) + '" alt="" draggable="false" />'
      : '<div class="card-tile" style="' + U.tileStyle(app.name) + '">' + U.esc(U.initials(app.name)) + '</div>';

    const liveHtml = running
      ? '<div class="card-live" data-live-id="' + app.id + '"><span class="pulse"></span><span class="live-text">' +
        U.fmtDuration(Math.floor((Date.now() - app.running.startedMs) / 1000)) + '</span></div>'
      : '';

    // 系统自动读出来的英文原名，和用户自己起的名字分开存：
    //   autoName 没有、或和 name 一样 = 没改过名（或改完又清空了），输入框留空
    const autoName = app.autoName || app.name;
    const renamed = !!app.autoName && app.name !== app.autoName;
    const custom = renamed ? app.name : '';

    node.innerHTML =
      '<div class="card-icon">' + iconHtml + '</div>' +
      '<input class="card-name-input' + (renamed ? ' filled' : '') + '" type="text" maxlength="40"' +
      ' data-name-for="' + app.id + '" data-origin="' + U.esc(custom) + '"' +
      ' placeholder="起个中文名" spellcheck="false" autocomplete="off"' +
      ' value="' + U.esc(custom) + '" title="在这里输入中文名，清空就恢复原名" />' +
      '<div class="card-name' + (renamed ? ' origin' : '') + '" title="' + U.esc(autoName) + '">' + U.esc(autoName) + '</div>' +
      (tagRow ? '<div class="card-tags">' + tagRow + '</div>' : '') +
      (running ? liveHtml : '<div class="card-meta">' + meta + '</div>') +
      '<div class="card-actions">' +
      (running
        ? '<button class="btn stop sm" data-act="stop">■ 结束</button>'
        : '<button class="btn primary sm" data-act="start">▶ 开始</button>') +
      '<button class="btn ghost sm" data-act="detail">详情</button>' +
      '</div>';

    return node;
  },

  /** 把输入框里的中文名存起来；清空则恢复系统原名 */
  async saveName(id, raw) {
    const app = App.state.apps.find((a) => a.id === id);
    if (!app) return;
    const cur = app.autoName && app.name !== app.autoName ? app.name : '';
    const next = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (next === cur) return;

    // 先在本地改掉，卡片立刻显示新名字，不用等后面存盘
    app.autoName = app.autoName || app.name;
    app.name = next || app.autoName;

    const r = await window.api.apps.update({ id, patch: { customName: next } });
    if (!r || !r.ok) {
      App.toast((r && r.reason) || '改名没保存上', 'err');
      App.refreshApps();
      return;
    }
    App.toast(next ? '已改名为「' + next + '」' : '已恢复系统原名', 'ok');
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
      // 点输入框只是要打字，别跳到详情页
      if (e.target.closest('.card-name-input')) return;
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

    // 中文名输入框：改完、离开输入框时自动保存
    grid.addEventListener('change', (e) => {
      const inp = e.target.closest('.card-name-input');
      if (!inp) return;
      if (inp.dataset.skip === '1') {
        delete inp.dataset.skip;
        return;
      }
      this.saveName(inp.dataset.nameFor, inp.value);
    });

    grid.addEventListener('keydown', (e) => {
      const inp = e.target.closest('.card-name-input');
      if (!inp) return;
      // 中文输入法正在选词，这个回车是给输入法的，别当成「保存」
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        inp.blur(); // 回车 = 保存并离开输入框
      } else if (e.key === 'Escape') {
        inp.value = inp.dataset.origin || ''; // Esc = 不保存，还原成改之前
        inp.dataset.skip = '1';
        inp.blur();
      }
    });

    grid.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.card-name-input')) {
        e.stopPropagation();
        return; // 输入框上保留系统的复制 / 粘贴菜单
      }
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      App.showCardMenu(card.dataset.id, e.clientX, e.clientY);
    });
  },
};
