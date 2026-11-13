'use strict';
/**
 * 界面侧的标签：画小标签、画筛选条、以及三个窗口
 *   1) 管理标签（新建 / 改名 / 换色 / 排序 / 删除时转移）
 *   2) 给某个软件选标签
 *   3) 给某个标签勾软件（第一次批量分配最快）
 *
 * 「未分类」不是真实标签，只在界面和筛选里作为一个虚拟项存在。
 */

const Tags = {
  NONE: '__none__',

  list() {
    return (App.state && App.state.tags) || [];
  },

  get(id) {
    return this.list().find((t) => t.id === id) || null;
  },

  nameOf(id) {
    const t = this.get(id);
    return t ? t.name : '';
  },

  /** 一个软件身上「真实存在」的标签 */
  ofApp(app) {
    const ids = (app && app.tagIds) || [];
    return ids.map((id) => this.get(id)).filter(Boolean);
  },

  matches(app) {
    const sel = App.state.tagFilter;
    if (!sel || sel.size === 0) return true;
    const tags = this.ofApp(app);
    if (!tags.length) return sel.has(this.NONE);
    for (const t of tags) {
      if (sel.has(t.id)) return true;
    }
    return false;
  },

  /** 粗略估个宽度（中文字比英文宽），用来决定卡片上放得下几个标签 */
  textWidth(text) {
    let w = 0;
    for (const ch of String(text || '')) {
      w += /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 10.5 : 6;
    }
    return w;
  },

  pillHtml(tag, extra) {
    if (!tag) return '';
    return (
      '<span class="tag-pill' + (extra ? ' ' + extra : '') + '"><i style="background:' + tag.color + '"></i>' +
      '<span>' + U.esc(tag.name) + '</span></span>'
    );
  },

  /**
   * 卡片上的标签行。
   * 卡片窄，按估算宽度先塞，塞不下就折成「+N」，绝不让文字溢出卡片。
   */
  cardTagsHtml(app) {
    const tags = this.ofApp(app);
    if (!tags.length) return '';

    const MAXW = 148;
    const out = [];
    let used = 0;

    for (let i = 0; i < tags.length; i++) {
      const t = tags[i];
      const w = Math.min(70, 18 + this.textWidth(t.name));
      const rest = tags.length - i - 1;
      const reserve = rest > 0 ? 24 : 0;
      if (out.length && used + w + reserve > MAXW) break;
      used += w + 4;
      out.push(this.pillHtml(t));
    }

    const hidden = tags.length - out.length;
    let html = out.join('');
    if (hidden > 0) {
      html +=
        '<span class="tag-pill more" title="' + U.esc(tags.map((t) => t.name).join('、')) + '">+' + hidden + '</span>';
    }
    return html;
  },

  /* ------------------------------ 筛选条 ------------------------------ */

  renderChips(container, onChange) {
    if (!container) return;
    const sel = App.state.tagFilter;
    const parts = [];
    parts.push('<button class="chip' + (sel.size ? '' : ' on') + '" data-tag="">全部</button>');
    parts.push(
      '<button class="chip' + (sel.has(this.NONE) ? ' on' : '') + '" data-tag="' + this.NONE + '">未分类</button>'
    );
    for (const t of this.list()) {
      parts.push(
        '<button class="chip' + (sel.has(t.id) ? ' on' : '') + '" data-tag="' + t.id + '">' +
        '<i style="background:' + t.color + '"></i>' + U.esc(t.name) + '</button>'
      );
    }
    parts.push('<button class="chip manage" data-act="manage"><span class="plus">＋</span>管理标签</button>');
    container.innerHTML = parts.join('');

    container.onclick = (e) => {
      const manage = e.target.closest('[data-act="manage"]');
      if (manage) {
        this.manager();
        return;
      }
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const id = chip.dataset.tag;
      if (!id) sel.clear();
      else if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      this.renderChips(container, onChange);
      if (onChange) onChange();
    };
  },

  /* ------------------------------ 弹窗底座 ------------------------------ */

  open(title, sub, body, buttons) {
    const wrap = document.getElementById('modal');
    wrap.hidden = false;
    wrap.innerHTML = '';

    const box = U.el('div', 'modal wide tag-modal');
    box.appendChild(U.el('h3', null, title));
    if (sub) box.appendChild(U.el('p', null, sub));
    box.appendChild(body);

    const actions = U.el('div', 'modal-actions');
    for (const b of buttons || []) {
      const btn = U.el('button', 'btn ' + (b.kind || 'ghost'), b.label);
      btn.type = 'button';
      btn.onclick = () => {
        if (b.fn) b.fn();
        else this.close();
      };
      actions.appendChild(btn);
    }
    box.appendChild(actions);
    wrap.appendChild(box);
    wrap.onclick = (e) => {
      if (e.target === wrap) this.close();
    };
    return box;
  },

  close() {
    App.closeModal();
  },

  /* ------------------------------ 1. 管理标签 ------------------------------ */

  async manager() {
    const res = await window.api.tags.list();
    App.state.tags = res.tags || [];
    App.state.untagged = res.untagged || { appCount: 0 };

    const body = document.createElement('div');
    body.className = 'tag-manager';

    const list = U.el('div', 'tag-list');
    if (!res.tags.length) {
      list.appendChild(
        U.el('div', 'tag-empty', '还没有标签。先建一个「游戏」或「学习」，再往里面勾软件。')
      );
    } else {
      res.tags.forEach((t, i) => list.appendChild(this.managerRow(t, res.tags, i)));
    }
    body.appendChild(list);

    if (res.untagged.appCount) {
      body.appendChild(
        U.el('div', 'tag-note', '另有 ' + res.untagged.appCount + ' 个软件还没打标签，统计里算「未分类」。')
      );
    }

    const create = U.el('div', 'tag-create');
    const input = document.createElement('input');
    input.className = 'tag-create-input';
    input.placeholder = '新标签的名字，比如「游戏」';
    input.maxLength = 16;
    const add = U.el('button', 'btn primary sm', '新建');
    const submit = async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      const r = await window.api.tags.create({ name });
      if (!r.ok) {
        App.toast(r.reason || '建不了这个标签', 'err');
        return;
      }
      await App.refreshTags();
      App.toast('已新建标签「' + r.tag.name + '」', 'ok');
      this.manager();
    };
    add.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
    create.appendChild(input);
    create.appendChild(add);
    body.appendChild(create);

    this.open('标签管理', '标签只管分类，不影响的计时。点名字改名，点色块换颜色。', body, [
      { label: '关闭', kind: 'primary', fn: () => this.close() },
    ]);

    setTimeout(() => input.focus(), 30);
  },

  managerRow(t, all, index) {
    const row = U.el('div', 'tag-row');
    row.dataset.id = t.id;

    const dot = U.el('button', 'tag-dot');
    dot.type = 'button';
    dot.style.background = t.color;
    dot.title = '点一下换颜色';
    dot.onclick = async () => {
      const r = await window.api.tags.update({ id: t.id, patch: { cycleColor: true } });
      if (!r.ok) {
        App.toast(r.reason || '换不了颜色', 'err');
        return;
      }
      await App.refreshTags();
      this.manager();
    };

    const main = U.el('div', 'tag-main');
    const name = U.el('div', 'tag-name', t.name);
    name.title = '点一下改名';
    const sub = U.el('div', 'tag-sub', t.appCount + ' 个软件 · 共 ' + U.fmtDuration(t.sec || 0));
    main.appendChild(name);
    main.appendChild(sub);

    const startRename = () => {
      const inp = document.createElement('input');
      inp.className = 'tag-name-input';
      inp.value = t.name;
      inp.maxLength = 16;
      main.replaceChild(inp, name);
      inp.focus();
      inp.select();

      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        if (!save) {
          main.replaceChild(name, inp);
          return;
        }
        const r = await window.api.tags.update({ id: t.id, patch: { name: inp.value } });
        if (!r.ok) {
          App.toast(r.reason || '改不了', 'err');
          main.replaceChild(name, inp);
          return;
        }
        await App.refreshTags();
        App.toast('已改名为「' + r.tag.name + '」', 'ok');
        this.manager();
      };
      inp.onkeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      };
      inp.onblur = () => finish(true);
    };
    name.onclick = startRename;

    const ops = U.el('div', 'tag-ops');

    const arrow = (label, title, dir) => {
      const b = U.el('button', 'tag-icon', label);
      b.type = 'button';
      b.title = title;
      b.disabled = (dir < 0 && index === 0) || (dir > 0 && index === all.length - 1);
      b.onclick = async () => {
        const ids = all.map((x) => x.id);
        const from = ids.indexOf(t.id);
        const to = from + dir;
        if (to < 0 || to >= ids.length) return;
        ids.splice(to, 0, ids.splice(from, 1)[0]);
        const r = await window.api.tags.reorder(ids);
        if (!r.ok) {
          App.toast(r.reason || '排不了', 'err');
          return;
        }
        await App.refreshTags();
        this.manager();
      };
      return b;
    };

    ops.appendChild(arrow('↑', '上移', -1));
    ops.appendChild(arrow('↓', '下移', 1));

    const membersBtn = U.el('button', 'btn ghost sm', '管理软件');
    membersBtn.type = 'button';
    membersBtn.onclick = () => this.members(t.id);
    ops.appendChild(membersBtn);

    const del = U.el('button', 'tag-icon danger', '删除');
    del.type = 'button';
    del.onclick = () => this.confirmRemove(t);
    ops.appendChild(del);

    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(ops);
    return row;
  },

  async confirmRemove(t) {
    const res = await window.api.tags.list();
    const others = (res.tags || []).filter((x) => x.id !== t.id);

    const body = document.createElement('div');
    const p = document.createElement('p');
    if (t.appCount) {
      p.innerHTML =
        '有 <b>' + t.appCount + '</b> 个软件在用这个标签，一共记了 ' + U.fmtDuration(t.sec || 0) +
        '。<br />删掉标签不会删掉任何使用记录，只影响它们以后归到哪一类。';
    } else {
      p.textContent = '还没有软件用这个标签，删掉不影响任何统计。';
    }
    body.appendChild(p);

    let moveTo = '';
    if (t.appCount && others.length) {
      const wrap = U.el('div', 'tag-move');
      wrap.appendChild(U.el('div', 'tag-move-label', '这些软件改成：'));
      const sel = document.createElement('select');
      sel.innerHTML =
        '<option value="">未分类（不属于任何标签）</option>' +
        others.map((x) => '<option value="' + x.id + '">合并到「' + U.esc(x.name) + '」</option>').join('');
      sel.onchange = () => {
        moveTo = sel.value;
      };
      wrap.appendChild(sel);
      body.appendChild(wrap);
    }

    this.open('删除标签「' + t.name + '」', '', body, [
      { label: '取消', fn: () => this.manager() },
      {
        label: '删除',
        kind: 'danger',
        fn: async () => {
          const r = await window.api.tags.remove({ id: t.id, moveTo: moveTo || null });
          if (!r.ok) {
            App.toast(r.reason || '删不掉', 'err');
            return;
          }
          await App.refreshTags();
          await App.refreshApps();
          App.toast(moveTo ? '已删除，软件合并到另一个标签' : '已删除标签', 'ok');
          this.manager();
        },
      },
    ]);
  },

  /* ------------------------------ 2. 给软件选标签 ------------------------------ */

  async assign(appId) {
    const app = (App.state.apps || []).find((a) => a.id === appId);
    if (!app) return;

    const res = await window.api.tags.list();
    App.state.tags = res.tags || [];
    const checked = new Set((app.tagIds || []).filter((id) => (res.tags || []).some((t) => t.id === id)));

    const body = document.createElement('div');
    const list = U.el('div', 'tag-check-list');

    const renderList = () => {
      list.innerHTML = '';
      if (!res.tags.length) {
        list.appendChild(U.el('div', 'tag-empty', '还没有标签，在下面先建一个。'));
        return;
      }
      for (const t of res.tags) {
        list.appendChild(
          this.checkRow({
            on: checked.has(t.id),
            color: t.color,
            title: t.name,
            toggle: (next) => {
              if (next) checked.add(t.id);
              else checked.delete(t.id);
            },
          })
        );
      }
    };
    renderList();
    body.appendChild(list);

    const create = U.el('div', 'tag-create');
    const input = document.createElement('input');
    input.className = 'tag-create-input';
    input.placeholder = '顺手新建一个标签';
    input.maxLength = 16;
    const add = U.el('button', 'btn ghost sm', '新建');
    const submit = async () => {
      const name = input.value.trim();
      if (!name) return;
      const r = await window.api.tags.create({ name });
      if (!r.ok) {
        App.toast(r.reason || '建不了', 'err');
        return;
      }
      const fresh = await window.api.tags.list();
      res.tags = fresh.tags || [];
      App.state.tags = res.tags;
      checked.add(r.tag.id);
      input.value = '';
      renderList();
    };
    add.onclick = submit;
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
    create.appendChild(input);
    create.appendChild(add);
    body.appendChild(create);

    this.open('给「' + app.name + '」设置标签', '可以多选。一个标签都不选的软件，统计里算「未分类」。', body, [
      { label: '取消', fn: () => this.close() },
      {
        label: '保存',
        kind: 'primary',
        fn: async () => {
          const r = await window.api.tags.setAppTags({ appId, tagIds: Array.from(checked) });
          if (!r.ok) {
            App.toast(r.reason || '保存失败', 'err');
            return;
          }
          await App.refreshTags();
          await App.refreshApps();
          this.close();
          App.toast('标签已更新', 'ok');
          if (App.state.view === 'detail') Detail.reload();
        },
      },
    ]);
  },

  /* ------------------------------ 3. 给标签勾软件 ------------------------------ */

  async members(tagId) {
    const tag = this.get(tagId);
    if (!tag) return;

    const all = (App.state.apps || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const checked = new Set(all.filter((a) => (a.tagIds || []).indexOf(tagId) >= 0).map((a) => a.id));

    const body = document.createElement('div');

    const searchWrap = U.el('div', 'tag-search');
    const search = document.createElement('input');
    search.className = 'tag-search-input';
    search.placeholder = '搜索软件名';
    searchWrap.appendChild(search);
    const countEl = U.el('span', 'tag-search-count', '已选 ' + checked.size + ' 个');
    searchWrap.appendChild(countEl);
    body.appendChild(searchWrap);

    const list = U.el('div', 'app-check-list');
    body.appendChild(list);

    const rows = [];
    const render = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      for (const app of all) {
        if (q && !app.name.toLowerCase().includes(q)) continue;
        shown++;
        const row = U.el('label', 'app-check-row');
        const box = U.el('span', 'check-box' + (checked.has(app.id) ? ' on' : ''));

        if (app.iconFile) {
          const img = document.createElement('img');
          img.className = 'mini-icon';
          img.src = U.iconUrl(app.iconFile);
          row.appendChild(img);
        } else {
          const tile = U.el('span', 'mini-tile', U.initials(app.name));
          tile.style.cssText = U.tileStyle(app.name);
          row.appendChild(tile);
        }

        row.appendChild(box);
        row.appendChild(U.el('span', 'check-name', app.name));

        const others = this.ofApp(app).filter((t) => t.id !== tagId);
        if (others.length) {
          row.appendChild(U.el('span', 'check-sub', others.map((t) => t.name).join('、')));
        }

        row.onclick = (e) => {
          e.preventDefault();
          if (checked.has(app.id)) checked.delete(app.id);
          else checked.add(app.id);
          box.classList.toggle('on');
          countEl.textContent = '已选 ' + checked.size + ' 个';
        };
        list.appendChild(row);
        rows.push(row);
      }
      if (!shown) list.appendChild(U.el('div', 'tag-empty', q ? '没有匹配的软件' : '库里还没有软件'));
    };
    search.oninput = render;
    render();

    this.open(
      '「' + tag.name + '」里有哪些软件',
      '勾上就算这个标签。一个软件可以属于多个标签，互不影响。',
      body,
      [
        { label: '取消', fn: () => this.close() },
        {
          label: '保存',
          kind: 'primary',
          fn: async () => {
            const r = await window.api.tags.setApps({ tagId, appIds: Array.from(checked) });
            if (!r.ok) {
              App.toast(r.reason || '保存失败', 'err');
              return;
            }
            await App.refreshTags();
            await App.refreshApps();
            App.toast('「' + tag.name + '」已更新', 'ok');
            this.manager();
          },
        },
      ]
    );
  },

  /* ------------------------------ 小零件 ------------------------------ */

  checkRow(opts) {
    const row = U.el('label', 'check-row');
    row.appendChild(U.el('span', 'check-box' + (opts.on ? ' on' : '')));
    if (opts.color) {
      const dot = U.el('i', 'check-dot');
      dot.style.background = opts.color;
      row.appendChild(dot);
    }
    row.appendChild(U.el('span', 'check-name', opts.title));
    row.onclick = (e) => {
      e.preventDefault();
      const box = row.querySelector('.check-box');
      const next = !box.classList.contains('on');
      box.classList.toggle('on', next);
      if (opts.toggle) opts.toggle(next);
    };
    return row;
  },
};
