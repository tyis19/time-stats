'use strict';
/** 前后台唯一的桥。渲染进程只能通过这里的方法，不能直接碰文件系统。 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  apps: {
    list: () => invoke('apps:list'),
    add: () => invoke('apps:add'),
    update: (payload) => invoke('apps:update', payload),
    remove: (payload) => invoke('apps:remove', payload),
    relocate: (id) => invoke('apps:relocate', id),
    launch: (id) => invoke('apps:launch', id),
    stop: (payload) => invoke('apps:stop', payload),
    reveal: (id) => invoke('apps:reveal', id),
  },
  watch: {
    set: (enabled) => invoke('watch:set', { enabled }),
  },
  tracker: {
    snapshot: () => invoke('tracker:snapshot'),
  },
  stats: {
    overview: () => invoke('stats:overview'),
    days: (payload) => invoke('stats:days', payload),
    sessions: (payload) => invoke('stats:sessions', payload),
    deleteSession: (id) => invoke('stats:delete-session', id),
    reassignSession: (payload) => invoke('stats:reassign-session', payload),
    hours: (payload) => invoke('stats:hours', payload),
    calendar: (payload) => invoke('stats:calendar', payload),
    ranking: (payload) => invoke('stats:ranking', payload),
    appDetail: (id) => invoke('stats:app-detail', id),
    exportCsv: () => invoke('stats:export-csv'),
  },
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },
  system: {
    autoLaunch: (enabled) => invoke('system:auto-launch', { enabled }),
    createShortcut: () => invoke('system:create-shortcut'),
    openDataFolder: () => invoke('system:open-data-folder'),
    openLogFile: () => invoke('system:open-log-file'),
    openStartupFolder: () => invoke('system:open-startup-folder'),
    diagnostics: () => invoke('system:diagnostics'),
  },
  win: {
    minimize: () => invoke('win:minimize'),
    maximize: () => invoke('win:maximize'),
    close: () => invoke('win:close'),
  },
  quit: () => invoke('app:quit'),

  onUpdate: (cb) => {
    ipcRenderer.on('tracker:update', (_e, snapshot) => cb(snapshot));
  },
  onEvent: (cb) => {
    ipcRenderer.on('tracker:event', (_e, evt) => cb(evt));
  },
  onAppsChanged: (cb) => {
    ipcRenderer.on('apps:changed', () => cb());
  },
});
