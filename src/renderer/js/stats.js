'use strict';
/** 统计页：总览 + 按标签 + 热力图 + 排行榜 + 趋势 */

const Stats = {
  calDays: 91,
  range: 'today',
  _seq: 0,

  rangeName() {
    return { today: '今天', week: '本周', month: '本月', all: '全部' }[this.range] || '';
  },

  rangeLabel() {
    return this.rangeName() + '共 ';
  },

  async render() {
    const body = document.getElementById('stats-body');
    const seq = ++this._seq;
    body.innerHTML = '<div class="loading">正在统计…</div>';

    const filter = Array.from(App.state.tagFilter);
    const [ov, cal, days, rank, tagStat] = await Promise.all([
      window.api.stats.overview({ tagIds: filter }),
      window.api.stats.calendar({ days: this.calDays, tagIds: filter }),
      window.api.stats.days({ days: 7, tagIds: filter }),
      window.api.stats.ranking({ range: this.range, tagIds: filter }),
      window.api.stats.tags({ range: this.range, tagIds: filter }),
    ]);
    if (seq !== this._seq) return; // 期间又刷新过，丢掉这次的结果，避免两次渲染打架

    const streakText = ov.streak.current
      ? '已连续 ' + ov.streak.current + ' 天'
      : '今天还没记录';

    body.innerHTML =
      '<div class="toolbar"><div class="lib-title"><h2>统计</h2>' +
        '<span class="muted">' + streakText + (ov.streak.longest ? ' · 最长连续 ' + ov.streak.longest + ' 天' : '') + '</span>' +
      '</div>' +
      '<div class="toolbar-right">' +
        '<div class="segmented" id="s-range">' +
          '<button data-r="today" class="' + (this.range === 'today' ? 'active' : '') + '">今天</button>' +
          '<button data-r="week" class="' + (this.range === 'week' ? 'active' : '') + '">本周</button>' +
          '<button data-r="month" class="' + (this.range === 'month' ? 'active' : '') + '">本月</button>' +
          '<button data-r="all" class="' + (this.range === 'all' ? 'active' : '') + '">全部</button>' +
        '</div>' +
        '<span class="muted" style="font-size:11.5px">共 ' + ov.sessionCount + ' 条记录</span>' +
      '</div></div>' +

      '<div class="tagbar" id="stats-tagbar"></div>' +

      '<div class="stats-row">' +
        '<div class="stat"><div class="k">今天</div><div class="v">' + U.fmtDuration(ov.todaySec) + '</div></div>' +
        '<div class="stat"><div class="k">本周</div><div class="v">' + U.fmtDuration(ov.weekSec) + '</div></div>' +
        '<div class="stat"><div class="k">本月</div><div class="v">' + U.fmtDuration(ov.monthSec) + '</div></div>' +
        '<div class="stat"><div class="k">全部</div><div class="v">' + U.fmtDuration(ov.totalSec) + '</div></div>' +
        '<div class="stat"><div class="k">今天启动</div><div class="v">' + ov.todaySessions + '<small>次</small></div></div>' +
        '<div class="stat"><div class="k">记录天数</div><div class="v">' + ov.streak.totalDays + '<small>天</small></div></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>按标签</h3><span class="panel-sub" id="s-tagsum"></span></div>' +
        '<div class="tag-stat-grid">' +
          '<div id="s-donut"></div>' +
          '<div id="s-tagtable"></div>' +
        '</div>' +
        '<div class="tag-note-line" id="s-tagnote"></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>最近 13 周</h3><span class="panel-sub">颜色越深，那天用得越久</span></div>' +
        '<div id="s-heat"></div>' +
      '</div>' +

      '<div class="two-col" style="margin-top:12px">' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>排行榜</h3><span class="panel-sub">按上方范围</span></div>' +
          '<div id="s-rank"></div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>最近 7 天</h3><span class="panel-sub">每天总时长</span></div>' +
          '<div id="s-bars"></div>' +
        '</div>' +
      '</div>';

    Tags.renderChips(document.getElementById('stats-tagbar'), () => this.render());
    Charts.heatmap(document.getElementById('s-heat'), cal);
    Charts.ranking(document.getElementById('s-rank'), rank);
    Charts.bars(
      document.getElementById('s-bars'),
      days.map((d) => ({
        label: new Date(d.startMs).getMonth() + 1 + '/' + new Date(d.startMs).getDate(),
        sec: Math.round(d.sec),
        today: d.date === U.fmtDate(Date.now()),
      }))
    );
    try {
      this.paintTags(tagStat);
    } catch (err) {
      const note = document.getElementById('s-tagnote');
      if (note) note.textContent = '按标签统计没能画出来：' + (err && err.message ? err.message : String(err));
      console.error(err);
    }

    document.getElementById('s-range').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-r]');
      if (!btn) return;
      this.range = btn.dataset.r;
      for (const b of document.querySelectorAll('#s-range button')) b.classList.toggle('active', b === btn);
      await this.refreshRange();
    });
  },

  /** 切换范围时只重画排行榜和标签面板，不整页闪一下 */
  async refreshRange() {
    const filter = Array.from(App.state.tagFilter);
    const [rank, tagStat] = await Promise.all([
      window.api.stats.ranking({ range: this.range, tagIds: filter }),
      window.api.stats.tags({ range: this.range, tagIds: filter }),
    ]);
    const rankBox = document.getElementById('s-rank');
    if (rankBox) Charts.ranking(rankBox, rank);
    this.paintTags(tagStat);
  },

  /** 环形图 + 明细表 + 底部说明 */
  paintTags(data) {
    const items = data.tags.map((t) => ({ id: t.id, name: t.name, sec: t.sec, color: t.color }));
    if (data.untagged.sec > 0) {
      items.push({ id: Tags.NONE, name: '未分类', sec: data.untagged.sec, color: '#5b7185' });
    }

    const donutBox = document.getElementById('s-donut');
    if (donutBox) Charts.donut(donutBox, items);

    const tableBox = document.getElementById('s-tagtable');
    if (tableBox) this.renderTagTable(tableBox, data);

    const sum = document.getElementById('s-tagsum');
    if (sum) {
      // 筛选之后写「所选范围」，免得和顶部那张「全部」卡片同名不同数
      const head = data.filtered ? this.rangeName() + ' · 所选范围共 ' : this.rangeLabel();
      sum.textContent =
        head + U.fmtDuration(data.totalSec) +
        (data.tags.length ? ' · ' + data.tags.length + ' 个标签' : ' · 还没打标签');
    }

    const note = document.getElementById('s-tagnote');
    if (note) {
      const parts = [];
      if (data.scoped) {
        parts.push('只算你选中的标签：软件身上顺带挂的其它标签（比如「游戏」）不画进环里，也不参与占比。');
      }
      if (data.overlapSec > 0) {
        parts.push(
          (data.scoped
            ? '你选中的标签之间有重叠，同一个软件的时长在每片里各算一次'
            : '同一个软件挂了多个标签，它的时长会在每个标签下各算一次') +
          '：图上合计 ' + U.fmtDuration(data.denom) + '，实际 ' + U.fmtDuration(data.totalSec) +
          '，多算 ' + U.fmtDuration(data.overlapSec) + '。'
        );
      }
      if (data.tags.length) parts.push('点一行加选，再点一次取消。');
      note.textContent = parts.join(' ');
    }
  },

  renderTagTable(container, data) {
    container.innerHTML = '';

    const rows = data.tags.map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      sec: t.sec,
      appCount: t.appCount,
    }));
    if (data.untagged.sec > 0) {
      rows.push({ id: Tags.NONE, name: '未分类', color: '#5b7185', sec: data.untagged.sec, appCount: null });
    }

    if (!rows.length) {
      container.appendChild(U.el('div', 'loading', '这段时间还没有记录'));
      return;
    }

    const denom = data.denom || 1;
    const table = document.createElement('table');
    table.className = 'tag-table';
    table.innerHTML =
      '<thead><tr><th>标签</th><th>时长</th><th>占比</th><th>软件</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');

    for (const r of rows) {
      const tr = document.createElement('tr');
      if (App.state.tagFilter.has(r.id)) tr.classList.add('on');
      tr.innerHTML =
        '<td><i class="tag-dot-sm" style="background:' + r.color + '"></i>' + U.esc(r.name) + '</td>' +
        '<td>' + U.fmtDuration(r.sec) + '</td>' +
        '<td>' + Math.round((r.sec / denom) * 100) + '%</td>' +
        '<td>' + (r.appCount == null ? '—' : r.appCount + ' 个') + '</td>';
      tr.onclick = () => {
        const sel = App.state.tagFilter;
        if (sel.has(r.id)) sel.delete(r.id);
        else sel.add(r.id);
        this.render();
      };
      tbody.appendChild(tr);
    }

    container.appendChild(table);
  },
};
