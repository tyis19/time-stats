'use strict';
/** 统计页：总览 + 热力图 + 排行榜 + 趋势 */

const Stats = {
  calDays: 91,
  range: 'today',

  async render() {
    const body = document.getElementById('stats-body');
    body.innerHTML = '<div class="loading">正在统计…</div>';

    const [ov, cal, days, rank] = await Promise.all([
      window.api.stats.overview(),
      window.api.stats.calendar({ days: this.calDays }),
      window.api.stats.days({ days: 7 }),
      window.api.stats.ranking({ range: this.range }),
    ]);

    const streakText = ov.streak.current
      ? '已连续 ' + ov.streak.current + ' 天'
      : '今天还没记录';

    body.innerHTML =
      '<div class="toolbar"><div class="lib-title"><h2>统计</h2>' +
        '<span class="muted">' + streakText + (ov.streak.longest ? ' · 最长连续 ' + ov.streak.longest + ' 天' : '') + '</span>' +
      '</div><div class="toolbar-right"><span class="muted" style="font-size:11.5px">共 ' + ov.sessionCount + ' 条记录</span></div></div>' +

      '<div class="stats-row">' +
        '<div class="stat"><div class="k">今天</div><div class="v">' + U.fmtDuration(ov.todaySec) + '</div></div>' +
        '<div class="stat"><div class="k">本周</div><div class="v">' + U.fmtDuration(ov.weekSec) + '</div></div>' +
        '<div class="stat"><div class="k">本月</div><div class="v">' + U.fmtDuration(ov.monthSec) + '</div></div>' +
        '<div class="stat"><div class="k">全部</div><div class="v">' + U.fmtDuration(ov.totalSec) + '</div></div>' +
        '<div class="stat"><div class="k">今天启动</div><div class="v">' + ov.todaySessions + '<small>次</small></div></div>' +
        '<div class="stat"><div class="k">记录天数</div><div class="v">' + ov.streak.totalDays + '<small>天</small></div></div>' +
      '</div>' +

      '<div class="panel" style="margin-top:12px">' +
        '<div class="panel-head"><h3>最近 13 周</h3><span class="panel-sub">颜色越深，那天用得越久</span></div>' +
        '<div id="s-heat"></div>' +
      '</div>' +

      '<div class="two-col" style="margin-top:12px">' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>排行榜</h3>' +
            '<div class="segmented" id="s-range">' +
              '<button data-r="today" class="' + (this.range === 'today' ? 'active' : '') + '">今天</button>' +
              '<button data-r="week" class="' + (this.range === 'week' ? 'active' : '') + '">本周</button>' +
              '<button data-r="month" class="' + (this.range === 'month' ? 'active' : '') + '">本月</button>' +
              '<button data-r="all" class="' + (this.range === 'all' ? 'active' : '') + '">全部</button>' +
            '</div>' +
          '</div>' +
          '<div id="s-rank"></div>' +
        '</div>' +
        '<div class="panel">' +
          '<div class="panel-head"><h3>最近 7 天</h3><span class="panel-sub">每天总时长</span></div>' +
          '<div id="s-bars"></div>' +
        '</div>' +
      '</div>';

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

    document.getElementById('s-range').addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-r]');
      if (!btn) return;
      this.range = btn.dataset.r;
      for (const b of document.querySelectorAll('#s-range button')) b.classList.toggle('active', b === btn);
      const rows = await window.api.stats.ranking({ range: this.range });
      Charts.ranking(document.getElementById('s-rank'), rows);
    });
  },
};
