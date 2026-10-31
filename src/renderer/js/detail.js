'use strict';
/** 详情页：一个软件的全部账本 */

const Detail = {
  data: null,

  async open(id) {
    App.setView('detail');
    const body = document.getElementById('detail-body');
    body.innerHTML = '<div class="loading">正在读取记录…</div>';
    const d = await window.api.stats.appDetail(id);
    if (!d.ok) {
      App.toast(d.reason || '打不开这个软件', 'err');
      App.setView('library');
      return;
    }
    this.data = d;
    this.render(d);
  },

  async reload() {
    if (this.data && this.data.app) await this.open(this.data.app.id);
  },

  render(d) {
    const body = document.getElementById('detail-body');
    const app = d.app;
    const s = d.summary;
    const running = app.running && (app.running.state === 'RUNNING' || app.running.state === 'STARTING' || app.running.state === 'HANDOVER');

    const iconHtml = app.iconFile
      ? '<img src="' + U.iconUrl(app.iconFile) + '" alt="" />'
      : '<div class="hero-tile" style="' + U.tileStyle(app.name) + '">' + U.esc(U.initials(app.name)) + '</div>';

    const liveHtml = running
      ? '<div class="hero-live" data-detail-live>' + U.fmtDuration(Math.floor((Date.now() - app.running.startedMs) / 1000)) + '</div>'
      : '';

    const last7 = d.last7.map((x) => ({
      label: new Date(x.startMs).getMonth() + 1 + '/' + new Date(x.startMs).getDate(),
      sec: Math.round(x.sec),
      today: x.date === U.fmtDate(Date.now()),
    }));

    body.innerHTML =
      '<div class="detail-top">' +
        '<button class="btn ghost" id="btn-back">← 返回库</button>' +
        '<div style="flex:1"></div>' +
        '<button class="btn ghost" id="btn-reveal">打开所在文件夹</button>' +
      '</div>' +

      '<div class="detail-hero">' + iconHtml +
        '<div class="hero-body">' +
          '<div class="hero-title"><h1>' + U.esc(app.name) + '</h1>' + liveHtml + '</div>' +
          '<div class="hero-path" title="' + U.esc(app.exePath) + '">' + U.esc(app.exePath) + '</div>' +
          '<div class="hero-actions">' +
            (running
              ? '<button class="btn stop" id="btn-run">■ 结束</button>'
              : '<button class="btn primary" id="btn-run">▶ 开始</button>') +
            '<button class="btn ghost" id="btn-export">导出表格</button>' +
            '<button class="btn ghost" id="btn-relocate">重新定位</button>' +
            '<button class="btn danger" id="btn-remove">从库中移除</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="stats-row">' +
        '<div class="stat"><div class="k">总共</div><div class="v">' + U.fmtDuration(s.totalSec) + '</div></div>' +
        '<div class="stat"><div class="k">今天</div><div class="v">' + U.fmtDuration(s.todaySec) + '</div></div>' +
        '<div class="stat"><div class="k">本周</div><div class="v">' + U.fmtDuration(s.weekSec) + '</div></div>' +
        '<div class="stat"><div class="k">本月</div><div class="v">' + U.fmtDuration(s.monthSec) + '</div></div>' +
        '<div class="stat"><div class="k">启动次数</div><div class="v">' + s.sessionCount + '<small>次</small></div></div>' +
        '<div class="stat"><div class="k">平均每次</div><div class="v">' + U.fmtDuration(s.avgSec) + '</div></div>' +
      '</div>' +

      '<div class="chart-grid">' +
        '<div class="panel"><div class="panel-head"><h3>最近 7 天</h3><span class="panel-sub">每天用了多久</span></div><div id="d-bars"></div></div>' +
        '<div class="panel"><div class="panel-head"><h3>今天的时间分布</h3><span class="panel-sub">按小时</span></div><div id="d-hours"></div></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>最近 90 天</h3><span class="panel-sub">颜色越深用得越久</span></div>' +
        '<div id="d-heat"></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>每天的开始与结束</h3><span class="panel-sub">最近 14 天</span></div>' +
        '<div id="d-days"></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>使用记录</h3><span class="panel-sub">共 ' + d.sessionCount + ' 次' +
          (d.sessionCount > 60 ? '（显示最近 60 条）' : '') + '</span></div>' +
        '<div id="d-table"></div>' +
      '</div>';

    Charts.bars(document.getElementById('d-bars'), last7);
    Charts.hours(document.getElementById('d-hours'), d.todayHours);
    Charts.heatmap(document.getElementById('d-heat'), d.calendar);
    this.renderDayTable(d.last14 || []);
    this.renderTable(d.sessions);

    document.getElementById('btn-back').onclick = () => App.setView('library');
    document.getElementById('btn-reveal').onclick = () => window.api.apps.reveal(app.id);
    document.getElementById('btn-export').onclick = () => App.exportCsv();
    document.getElementById('btn-relocate').onclick = () => App.relocateApp(app.id);
    document.getElementById('btn-remove').onclick = () => App.removeApp(app.id);
    document.getElementById('btn-run').onclick = () => {
      if (running) App.stopApp(app.id, false);
      else App.startApp(app.id);
    };
  },

  /** 按天汇总：这一天的第一次开始、最后一次结束 */
  renderDayTable(days) {
    const box = document.getElementById('d-days');
    if (!days || !days.length) {
      box.innerHTML = '<div class="loading">还没有记录</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'sessions';
    table.innerHTML =
      '<thead><tr><th>日期</th><th>星期</th><th>第一次开始</th><th>最后一次结束</th><th>总时长</th><th>启动</th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');

    const list = days.slice().sort((a, b) => (a.date < b.date ? 1 : -1)); // 新的在上面
    for (const d of list) {
      const tr = document.createElement('tr');
      if (!d.sec) tr.style.opacity = '0.45';
      const isToday = d.date === U.fmtDate(Date.now());
      const startText = d.firstStartMs
        ? U.fmtTime(d.firstStartMs) + (d.carriedIn ? ' <span class="tag warn">承接前一天</span>' : '')
        : '—';
      const endText = d.lastEndMs ? U.fmtTime(d.lastEndMs) : '—';
      tr.innerHTML =
        '<td>' + d.date + (isToday ? ' <span class="tag">今天</span>' : '') + '</td>' +
        '<td>' + U.fmtWeekday(d.startMs) + '</td>' +
        '<td>' + startText + '</td>' +
        '<td>' + endText + '</td>' +
        '<td>' + (d.sec ? U.fmtDuration(d.sec) : '—') + '</td>' +
        '<td>' + (d.launches || 0) + ' 次</td>';
      tbody.appendChild(tr);
    }

    box.innerHTML = '';
    box.appendChild(table);
  },

  renderTable(rows) {
    const box = document.getElementById('d-table');
    if (!rows.length) {
      box.innerHTML = '<div class="loading">还没有使用记录。点上面的「开始」试试。</div>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'sessions';
    table.innerHTML =
      '<thead><tr><th>日期</th><th>开始</th><th>结束</th><th>时长</th><th>来源</th><th></th></tr></thead><tbody></tbody>';
    const tbody = table.querySelector('tbody');

    for (const r of rows) {
      const tr = document.createElement('tr');
      const clean = Math.max(0, Math.round(((r.endMs || 0) - (r.startMs || 0) - (r.gapMs || 0)) / 1000));
      const srcTag =
        r.source === 'autowatch'
          ? '<span class="tag auto">自动监视</span>'
          : '<span class="tag">本工具启动</span>';
      const gap = r.gapMs > 60000 ? '<span class="tag warn">含休眠 ' + Math.round(r.gapMs / 60000) + ' 分</span>' : '';
      const crossDay = U.fmtDate(r.startMs) !== U.fmtDate(r.endMs);
      tr.innerHTML =
        '<td>' + U.fmtDate(r.startMs) + (crossDay ? ' <span class="tag warn">跨天</span>' : '') + '</td>' +
        '<td>' + U.fmtTimeSec(r.startMs) + '</td>' +
        '<td>' + (r.closedBy === 'recovered' ? '<span class="tag warn">异常中断</span>' : U.fmtTimeSec(r.endMs)) + '</td>' +
        '<td>' + U.fmtDuration(clean) + '</td>' +
        '<td>' + srcTag + ' ' + gap + '</td>' +
        '<td><span class="table-link" data-del="' + r.id + '">删除</span></td>';
      tbody.appendChild(tr);
    }

    tbody.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-del]');
      if (!del) return;
      const ok = await App.confirm('删除这条记录？', '这条记录会从统计里永久移除，其他记录不受影响。', '删除');
      if (!ok) return;
      await window.api.stats.deleteSession(del.dataset.del);
      App.toast('已删除', 'ok');
      Detail.reload();
      App.refreshApps();
    });

    box.innerHTML = '';
    box.appendChild(table);
  },

  updateLive() {
    if (!this.data || !this.data.app) return;
    const r = App.state.running.get(this.data.app.id);
    const node = document.querySelector('[data-detail-live]');
    if (node && r) node.textContent = U.fmtDuration(Math.floor((Date.now() - r.startedMs) / 1000));
  },
};
