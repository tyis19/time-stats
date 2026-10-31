'use strict';
/** 通用小工具：时间格式化、文本转义、颜色生成 */

const U = {
  pad(n) {
    return String(n).padStart(2, '0');
  },

  /**
   * 全程序唯一的时长格式：12345 → "3 小时 25 分 45 秒"
   * 三段恒显示、秒不丢、不四舍五入，保证同一个数在任何位置显示都一样。
   */
  fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    return h + ' 小时 ' + m + ' 分 ' + r + ' 秒';
  },

  /** 旧名字保留，内部走同一个格式（卡片、排行榜等在用的就是它） */
  fmtHours(sec) {
    return U.fmtDuration(sec);
  },

  fmtDate(ms) {
    const d = new Date(ms);
    return d.getFullYear() + '-' + U.pad(d.getMonth() + 1) + '-' + U.pad(d.getDate());
  },

  fmtTime(ms) {
    const d = new Date(ms);
    return U.pad(d.getHours()) + ':' + U.pad(d.getMinutes());
  },

  fmtTimeSec(ms) {
    const d = new Date(ms);
    return U.pad(d.getHours()) + ':' + U.pad(d.getMinutes()) + ':' + U.pad(d.getSeconds());
  },

  /** "今天 21:30" / "昨天 09:12" / "10月28日 20:05" */
  fmtWhen(ms) {
    if (!ms) return '还没用过';
    const now = new Date();
    const d = new Date(ms);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((today - day) / 86400000);
    if (diff === 0) return '今天 ' + U.fmtTime(ms);
    if (diff === 1) return '昨天 ' + U.fmtTime(ms);
    if (diff < 7) return diff + ' 天前';
    return d.getMonth() + 1 + '月' + d.getDate() + '日';
  },

  fmtWeekday(ms) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return names[new Date(ms).getDay()];
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  /** 名称 → 稳定的色相，用于没有图标时画渐变磁贴 */
  hueOf(name) {
    let h = 0;
    const s = String(name || '?');
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  },

  tileStyle(name) {
    const h = U.hueOf(name);
    return 'background:linear-gradient(140deg,hsl(' + h + ' 45% 42%),hsl(' + ((h + 38) % 360) + ' 48% 26%))';
  },

  initials(name) {
    const s = String(name || '?').trim();
    if (!s) return '?';
    const first = s[0];
    return /[a-z]/i.test(first) ? first.toUpperCase() : first;
  },

  /** 图标地址：走自定义协议，避免直接暴露文件路径 */
  iconUrl(iconFile) {
    return iconFile ? 'tsicon://icon/' + encodeURIComponent(iconFile) : '';
  },

  el(tag, className, text) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    if (text != null) n.textContent = text;
    return n;
  },

  clamp(v, a, b) {
    return Math.min(b, Math.max(a, v));
  },
};
