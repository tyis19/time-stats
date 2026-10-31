'use strict';
/** 设置页 */

const Settings = {
  async render() {
    const body = document.getElementById('settings-body');
    body.innerHTML = '<div class="loading">正在读取设置…</div>';

    const info = await window.api.settings.get();
    const s = info.settings;
    const packaged = info.packaged;

    body.innerHTML =
      '<div class="toolbar"><div class="lib-title"><h2>设置</h2><span class="muted">改动立即生效</span></div></div>' +

      '<div class="settings-grid">' +
        '<div>' +

          '<div class="panel">' +
            '<div class="panel-head"><h3>统计方式</h3></div>' +

            '<div class="setting-row">' +
              '<div><div class="t">自动监视</div><div class="d">打开后，即使程序是从桌面或开始菜单打开的，只要它在你库里、并且正在运行，也会自动计时。<br />默认关闭：只统计从这个工具里点「开始」启动的程序。</div></div>' +
              '<div class="switch' + (s.autoWatch ? ' on' : '') + '" id="sw-watch"></div>' +
            '</div>' +

            '<div class="setting-row">' +
              '<div><div class="t">关闭窗口时</div><div class="d">' + (s.closeToTray ? '缩到右下角托盘继续计时（推荐）。' : '直接退出程序，正在计时的会立刻停表。') + '</div></div>' +
              '<div class="switch' + (s.closeToTray ? ' on' : '') + '" id="sw-tray"></div>' +
            '</div>' +
          '</div>' +

          '<div class="panel">' +
            '<div class="panel-head"><h3>数据</h3></div>' +
            '<div class="setting-row">' +
              '<div><div class="t">数据保存在这里</div><div class="d" style="user-select:text">' + U.esc(info.dataDir) + '<br />整个文件夹拷走，换电脑后记录也跟着走。</div></div>' +
              '<button class="btn ghost sm" id="btn-open-data">打开</button>' +
            '</div>' +
            '<div class="setting-row">' +
              '<div><div class="t">导出统计表格</div><div class="d">导出成 CSV，可用 Excel / WPS 打开，包含每次的开始、结束、时长。</div></div>' +
              '<button class="btn ghost sm" id="btn-export">导出</button>' +
            '</div>' +
            '<div class="setting-row">' +
              '<div><div class="t">自动备份</div><div class="d">每天第一次打开时备份一次数据，保留最近 7 天，放在 data\\backup 里。</div></div>' +
              '<span class="muted" style="font-size:11px">已开启</span>' +
            '</div>' +
          '</div>' +

        '</div>' +
        '<div>' +

          '<div class="panel">' +
            '<div class="panel-head"><h3>开机与托盘</h3></div>' +
            '<div class="setting-row">' +
              '<div><div class="t">开机自动启动</div><div class="d">开机后静默启动，只在右下角托盘出现，不弹窗，全程自动记录。<br />原理是在「启动」文件夹放一个快捷方式（不是改注册表），杀软更少误报，你也能自己删。</div></div>' +
              '<div class="switch' + (s.autoLaunch ? ' on' : '') + '" id="sw-autolaunch"></div>' +
            '</div>' +
            '<div class="setting-row">' +
              '<div><div class="t">桌面快捷方式</div><div class="d">在桌面生成一个中文名「时间统计」的图标，方便随时打开。</div></div>' +
              '<button class="btn ghost sm" id="btn-shortcut">创建</button>' +
            '</div>' +
            '<div class="setting-row">' +
              '<div><div class="t">启动文件夹</div><div class="d">如果开机没自动启动，可以打开这个文件夹看看快捷方式还在不在。</div></div>' +
              '<button class="btn ghost sm" id="btn-startup-folder">打开</button>' +
            '</div>' +
            (packaged ? '' : '<div class="setting-row"><div><div class="t" style="color:#f0c07a">当前是开发模式</div><div class="d">开机自启、桌面快捷方式需要打包成正式程序后才生效。</div></div></div>') +
          '</div>' +

          '<div class="panel">' +
            '<div class="panel-head"><h3>关于</h3><span class="panel-sub">v' + U.esc(info.version) + '</span></div>' +
            '<div class="kv" id="diag-box">' +
              '<div class="k">状态</div><div class="v">点下面的按钮查看运行状态</div>' +
            '</div>' +
            '<div style="margin-top:12px;display:flex;gap:8px">' +
              '<button class="btn ghost sm" id="btn-diag">查看运行状态</button>' +
              '<button class="btn ghost sm" id="btn-quit">退出程序</button>' +
            '</div>' +
          '</div>' +

        '</div>' +
      '</div>';

    this.bind(info);
  },

  bind(info) {
    const s = info.settings;

    const toggle = async (el, on, fn) => {
      const next = !el.classList.contains('on');
      const r = await fn(next);
      if (r && r.ok === false) {
        App.toast(r.reason || '操作没成功', 'err');
        return;
      }
      el.classList.toggle('on', on === undefined ? next : !!on);
      Settings.render();
    };

    document.getElementById('sw-watch').onclick = (e) =>
      toggle(e.currentTarget, null, async (on) => {
        const r = await window.api.watch.set(on);
        App.state.settings.autoWatch = r.enabled;
        App.toast(on ? '自动监视已打开：从任何地方启动都会统计' : '自动监视已关闭', 'ok');
        return r;
      });

    document.getElementById('sw-tray').onclick = (e) =>
      toggle(e.currentTarget, null, async (on) => {
        const r = await window.api.settings.set({ closeToTray: on });
        App.state.settings.closeToTray = r.settings.closeToTray;
        return r;
      });

    document.getElementById('sw-autolaunch').onclick = async (e) => {
      const el = e.currentTarget;
      const next = !el.classList.contains('on');
      const r = await window.api.system.autoLaunch(next);
      if (!r.ok) {
        App.toast(r.reason || '设置失败', 'err');
        return;
      }
      el.classList.toggle('on', r.enabled);
      App.toast(r.enabled ? '已加入开机启动（启动文件夹）' : '已取消开机启动', 'ok');
      if (r.enabled) {
        const readback = await window.api.settings.get();
        if (!readback.settings.autoLaunch) App.toast('快捷方式没写成功，可能被安全软件拦截了', 'err');
      }
    };

    document.getElementById('btn-open-data').onclick = () => window.api.system.openDataFolder();
    document.getElementById('btn-startup-folder').onclick = () => window.api.system.openStartupFolder();
    document.getElementById('btn-export').onclick = () => App.exportCsv();

    document.getElementById('btn-shortcut').onclick = async () => {
      const r = await window.api.system.createShortcut();
      if (r.ok) App.toast('桌面快捷方式已创建', 'ok');
      else App.toast(r.reason || '创建失败', 'err');
    };

    document.getElementById('btn-diag').onclick = async () => {
      const d = await window.api.system.diagnostics();
      const box = document.getElementById('diag-box');
      const rows = [
        ['版本', d.version + (d.packaged ? '（正式版）' : '（开发模式）')],
        ['数据目录', d.dataDir],
        ['进程数', d.processCount + ' 个，读取耗时 ' + d.scanMs + ' 毫秒'],
        ['轮询间隔', '计时中 ' + d.pollActiveMs / 1000 + ' 秒 / 待命 ' + d.pollWatchMs / 1000 + ' 秒'],
        ['自动监视', d.autoWatch ? '开' : '关'],
        ['开机自启', d.autoLaunchEnabled ? '已启用' : '未启用'],
        ['启动项位置', d.autoLaunchFile],
        ['库里软件', d.appCount + ' 个'],
        ['记录条数', d.sessionRows + ' 条' + (d.badLines ? '（跳过损坏 ' + d.badLines + ' 条）' : '')],
      ];
      box.innerHTML = rows.map((r) => '<div class="k">' + r[0] + '</div><div class="v">' + U.esc(r[1]) + '</div>').join('');
    };

    document.getElementById('btn-quit').onclick = async () => {
      const ok = await App.confirm('退出程序？', '退出后就不再统计时间了。如果只是不想看到窗口，可以点右上角的关闭按钮，程序会留在托盘继续计时。', '退出');
      if (ok) window.api.quit();
    };
  },
};
