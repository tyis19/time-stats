'use strict';
/**
 * 启动与结束：把目标程序拉起来，必要时强制结束。
 * 注意 detached:true —— 让游戏脱离本工具，本工具崩了也不会带走游戏。
 */

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { shell } = require('electron');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 启动一个程序。
 * 返回 { ok, pid, mode }，mode: 'spawn' 直接启动 / 'shell' 走系统（可能弹 UAC）
 */
async function launch(app) {
  const exePath = app.exePath;
  if (!exePath || !fs.existsSync(exePath)) {
    return { ok: false, reason: '找不到程序文件，可能被移动或删除了。可以用「重新定位」重新指一下。' };
  }

  let child = null;
  let spawnError = null;

  try {
    child = spawn(exePath, Array.isArray(app.args) ? app.args : [], {
      cwd: path.dirname(exePath),
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.on('error', (e) => {
      spawnError = e;
    });
    child.unref();
  } catch (e) {
    spawnError = e;
  }

  await sleep(900); // 观察有没有「秒退」（UAC 拦截 / 缺 DLL 的典型表现）

  const exitedFast = child && child.exitCode !== null;
  if (spawnError || exitedFast) {
    // 换成系统方式打开：需要管理员权限的程序会弹授权框
    const errMsg = await shell.openPath(exePath);
    if (errMsg) {
      return {
        ok: false,
        reason: '启动失败：' + errMsg + '（可能是需要管理员权限被取消，或被安全软件拦截）',
      };
    }
    return { ok: true, pid: null, mode: 'shell' };
  }

  return { ok: true, pid: child ? child.pid : null, mode: 'spawn' };
}

/** 结束进程树（/T 连子进程，/F 强制） */
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve({ ok: false, reason: '没有进程号' });
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, output: String(stdout || '') + String(stderr || '') });
    });
  });
}

module.exports = { launch, killTree };
