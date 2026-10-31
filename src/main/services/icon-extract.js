'use strict';
/**
 * 图标提取，三级降级：
 *   1) 调系统接口取 256×256 大图（清晰）
 *   2) Electron 自带接口（Windows 上只有 32×32，会偏糊）
 *   3) 都失败就交给界面画「首字母磁贴」
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { app, nativeImage } = require('electron');

const PS_DIR = path.join(__dirname, 'ps');

function runPs(scriptName, args, timeout) {
  return new Promise((resolve) => {
    const script = path.join(PS_DIR, scriptName);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script].concat(args),
      { windowsHide: true, timeout: timeout || 15000 },
      (err, stdout, stderr) => resolve({ err, stdout, stderr })
    );
  });
}

async function extractIcon(exePath, outPng) {
  // 1) 系统接口 256
  try {
    fs.mkdirSync(path.dirname(outPng), { recursive: true });
    if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
    await runPs('icon-256.ps1', ['-ExePath', exePath, '-OutPng', outPng]);
    if (fs.existsSync(outPng) && fs.statSync(outPng).size > 256) {
      const img = nativeImage.createFromPath(outPng);
      const size = img.getSize();
      if (size.width >= 64) return { ok: true, size: size.width, source: 'shell' };
    }
  } catch (e) {
    /* 继续降级 */
  }

  // 2) Electron 自带
  try {
    const img = await app.getFileIcon(exePath, { size: 'large' });
    if (img && !img.isEmpty()) {
      fs.mkdirSync(path.dirname(outPng), { recursive: true });
      fs.writeFileSync(outPng, img.toPNG());
      return { ok: true, size: img.getSize().width, source: 'electron' };
    }
  } catch (e) {
    /* 继续降级 */
  }

  try {
    if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
  } catch (e) {
    /* 忽略 */
  }
  return { ok: false, size: 0, source: 'none' };
}

module.exports = { extractIcon, runPs };
