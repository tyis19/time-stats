'use strict';
/** 手绘图表：不引第三方库，全部用 DOM 拼，轻量且不会有依赖问题 */

const Charts = {
  /** 每日柱状图：items = [{label, sec, today, tip}] */
  bars(container, items) {
    container.innerHTML = '';
    const max = Math.max(1, ...items.map((i) => i.sec || 0));
    const wrap = U.el('div', 'bars');
    for (const it of items) {
      const col = U.el('div', 'bar-col');
      const val = U.el('div', 'bar-value', it.sec ? U.fmtDuration(it.sec) : '');
      const bar = U.el('div', 'bar' + (it.sec ? '' : ' zero') + (it.today && it.sec ? ' today' : ''));
      const h = it.sec ? Math.max(3, Math.round((it.sec / max) * 108)) : 2;
      bar.style.height = h + 'px';
      col.appendChild(val);
      col.appendChild(bar);
      col.appendChild(U.el('div', 'bar-label', it.label));
      wrap.appendChild(col);
    }
    container.appendChild(wrap);
  },

  /** 24 小时分布：bins = 24 个秒数 */
  hours(container, bins) {
    container.innerHTML = '';
    const max = Math.max(1, ...bins);
    const wrap = U.el('div', 'hours');
    for (let i = 0; i < 24; i++) {
      const col = U.el('div', 'hour-col');
      const bar = U.el('div', 'hour-bar' + (bins[i] ? '' : ' zero'));
      const h = bins[i] ? Math.max(2, Math.round((bins[i] / max) * 92)) : 1;
      bar.style.height = h + 'px';
      bar.title = i + ' 点 · ' + (bins[i] ? U.fmtDuration(bins[i]) : '没有记录');
      col.appendChild(bar);
      wrap.appendChild(col);
    }
    const axis = U.el('div', 'hour-axis');
    ['0', '6', '12', '18', '23'].forEach((t) => axis.appendChild(U.el('span', null, t + ' 点')));
    container.appendChild(wrap);
    container.appendChild(axis);
  },

  /** 日历热力图：days = [{date, sec, level, startMs}] 升序 */
  heatmap(container, days) {
    container.innerHTML = '';
    if (!days.length) return;
    const grid = U.el('div', 'heatmap');
    const first = new Date(days[0].startMs || days[0].date + 'T00:00:00');
    const pad = (first.getDay() + 6) % 7; // 周一排第一行
    for (let i = 0; i < pad; i++) {
      const blank = U.el('div', 'heat-cell');
      blank.style.visibility = 'hidden';
      grid.appendChild(blank);
    }
    for (const d of days) {
      const cell = U.el('div', 'heat-cell' + (d.level ? ' l' + d.level : ''));
      cell.title = d.date + ' · ' + (d.sec ? U.fmtDuration(d.sec) : '没有记录');
      grid.appendChild(cell);
    }
    container.appendChild(grid);

    const legend = U.el('div', 'heat-legend');
    legend.appendChild(U.el('span', null, '少'));
    for (let i = 0; i <= 4; i++) legend.appendChild(U.el('div', 'heat-cell' + (i ? ' l' + i : '')));
    legend.appendChild(U.el('span', null, '多'));
    container.appendChild(legend);
  },

  /**
   * 环形占比图：items = [{name, sec, color}]
   * 环的分母是「传进来的这些项之和」，所以永远是一整圈；
   * 多标签造成的重复在数据层就算好 overlap，这里不掺和。
   */
  donut(container, items) {
    container.innerHTML = '';
    const total = items.reduce((sum, it) => sum + (it.sec || 0), 0);
    if (!total) {
      container.appendChild(U.el('div', 'loading', '这段时间还没有记录'));
      return;
    }

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 140 140');
    svg.setAttribute('class', 'donut'); // SVG 元素的 className 是只读的，只能这么写

    const ring = document.createElementNS(NS, 'circle');
    ring.setAttribute('cx', '70');
    ring.setAttribute('cy', '70');
    ring.setAttribute('r', '54');
    ring.setAttribute('fill', 'none');
    ring.setAttribute('stroke', 'rgba(255,255,255,0.05)');
    ring.setAttribute('stroke-width', '16');
    svg.appendChild(ring);

    const C = 2 * Math.PI * 54;
    let offset = 0;
    for (const it of items) {
      const share = (it.sec || 0) / total;
      const len = Math.max(0, share * C - 1.5); // 留 1.5 的缝，块与块才分得开
      const arc = document.createElementNS(NS, 'circle');
      arc.setAttribute('cx', '70');
      arc.setAttribute('cy', '70');
      arc.setAttribute('r', '54');
      arc.setAttribute('fill', 'none');
      arc.setAttribute('stroke', it.color);
      arc.setAttribute('stroke-width', '16');
      arc.setAttribute('stroke-dasharray', len + ' ' + (C - len));
      arc.setAttribute('stroke-dashoffset', String(-offset));
      arc.setAttribute('transform', 'rotate(-90 70 70)');
      const tip = document.createElementNS(NS, 'title');
      tip.textContent = it.name + ' · ' + U.fmtDuration(it.sec) + ' · ' + Math.round(share * 100) + '%';
      arc.appendChild(tip);
      svg.appendChild(arc);
      offset += share * C;
    }

    const top = items.slice().sort((a, b) => b.sec - a.sec)[0];
    const pct = document.createElementNS(NS, 'text');
    pct.setAttribute('x', '70');
    pct.setAttribute('y', '67');
    pct.setAttribute('text-anchor', 'middle');
    pct.setAttribute('fill', '#e6eef5');
    pct.setAttribute('font-size', '20');
    pct.setAttribute('font-weight', '600');
    pct.textContent = Math.round((top.sec / total) * 100) + '%';
    svg.appendChild(pct);

    const name = document.createElementNS(NS, 'text');
    name.setAttribute('x', '70');
    name.setAttribute('y', '86');
    name.setAttribute('text-anchor', 'middle');
    name.setAttribute('fill', '#8ba0b2');
    name.setAttribute('font-size', '11');
    name.textContent = top.name.length > 6 ? top.name.slice(0, 6) + '…' : top.name;
    svg.appendChild(name);

    container.appendChild(svg);
  },

  /** 排行榜：rows = [{name, iconFile, sec, count}] */
  ranking(container, rows) {
    container.innerHTML = '';
    if (!rows.length) {
      container.appendChild(U.el('div', 'loading', '这段时间还没有记录'));
      return;
    }
    const max = Math.max(1, ...rows.map((r) => r.sec));
    rows.slice(0, 8).forEach((r, i) => {
      const row = U.el('div', 'rank-row');
      row.appendChild(U.el('div', 'rank-no', String(i + 1)));

      if (r.iconFile) {
        const img = U.el('img', 'rank-icon');
        img.src = U.iconUrl(r.iconFile);
        row.appendChild(img);
      } else {
        const tile = U.el('div', 'rank-icon');
        tile.style.cssText = U.tileStyle(r.name) + ';display:grid;place-items:center;color:#fff;font-size:11px;font-weight:700';
        tile.textContent = U.initials(r.name);
        row.appendChild(tile);
      }

      const body = U.el('div', 'rank-body');
      body.appendChild(U.el('div', 'rank-name', r.name));
      const track = U.el('div', 'rank-track');
      const fill = U.el('div', 'rank-fill');
      fill.style.width = Math.max(3, Math.round((r.sec / max) * 100)) + '%';
      track.appendChild(fill);
      body.appendChild(track);
      row.appendChild(body);

      row.appendChild(U.el('div', 'rank-sec', U.fmtDuration(r.sec)));
      container.appendChild(row);
    });
  },
};
