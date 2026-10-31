'use strict';
/**
 * 打包：把源码 + 本机缓存的 Electron 运行环境，做成绿色版文件夹。
 * 用法：node scripts/build.js
 * 产物：dist\时间统计\  （双击 TimeStats.exe 即用）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist', '时间统计');
const ZIP = path.join(
  process.env.LOCALAPPDATA || '',
  'electron',
  'Cache',
  '81a88082f2544068e7b917dcf52b8e4cbfee1381073bb8b9f3c543b027d0dba5',
  'electron-v43.3.0-win32-x64.zip'
);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

function log(msg) {
  console.log('  ' + msg);
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const st = fs.statSync(full);
      if (e.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

function copyDir(src, dest, excludes) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (excludes.includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d, excludes);
    else fs.copyFileSync(s, d);
  }
}

console.log('\n[1/7] 检查运行环境包');
if (!fs.existsSync(ZIP)) {
  console.error('找不到 Electron 运行包：' + ZIP);
  process.exit(1);
}
log('已找到：' + path.basename(ZIP));

console.log('[2/7] 清理旧产物并解压运行环境');
rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });
execFileSync(TAR, ['-xf', ZIP, '-C', DIST], { stdio: 'inherit' });
log('解压完成');

console.log('[3/7] 精简运行环境');
const defaultApp = path.join(DIST, 'resources', 'default_app.asar');
if (fs.existsSync(defaultApp)) {
  fs.unlinkSync(defaultApp);
  log('删除 default_app.asar');
}
const localesDir = path.join(DIST, 'locales');
const keep = new Set(['zh-CN.pak', 'en-US.pak']);
let removed = 0;
if (fs.existsSync(localesDir)) {
  for (const f of fs.readdirSync(localesDir)) {
    if (!keep.has(f)) {
      fs.unlinkSync(path.join(localesDir, f));
      removed++;
    }
  }
  log('清理语言包 ' + removed + ' 个');
}
const chromiumLicenses = path.join(DIST, 'LICENSES.chromium.html');
if (fs.existsSync(chromiumLicenses)) {
  fs.unlinkSync(chromiumLicenses);
  log('删除 20MB 的 Chromium 许可证文件（保留 LICENSE）');
}

console.log('[4/7] 拷贝程序源码');
copyDir(path.join(ROOT, 'src'), path.join(DIST, 'resources', 'app'), ['data', 'runtime', 'node_modules', '.DS_Store']);
log('已拷贝到 resources\\app');

console.log('[5/7] 生成程序本体');
const srcExe = path.join(DIST, 'electron.exe');
const dstExe = path.join(DIST, 'TimeStats.exe');
try {
  fs.renameSync(srcExe, dstExe);
  log('electron.exe → TimeStats.exe');
} catch (e) {
  console.error('改名失败：程序可能正在运行，请先退出。');
  process.exit(1);
}

const assetsDir = path.join(DIST, 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
for (const f of ['app.ico', 'icon-256.png']) {
  const s = path.join(ROOT, 'src', 'assets', f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(assetsDir, f));
}
log('已放置图标');

console.log('[6/7] 写入使用说明');
const readmeSrc = path.join(ROOT, '说明.txt');
if (fs.existsSync(readmeSrc)) {
  fs.copyFileSync(readmeSrc, path.join(DIST, '使用说明.txt'));
  log('已复制 使用说明.txt');
} else {
  log('（没有找到 说明.txt，跳过）');
}

console.log('[7/7] 完成');
const mb = (dirSize(DIST) / 1024 / 1024).toFixed(1);
console.log('\n产物：' + DIST);
console.log('体积：' + mb + ' MB');
console.log('双击里面的 TimeStats.exe 即可运行。\n');
