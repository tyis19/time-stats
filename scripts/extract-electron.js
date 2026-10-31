'use strict';
/** 解压本机缓存里的 Electron 到 vendor\（只有开发/测试时才需要） */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'vendor', 'electron');
const ZIP = path.join(
  process.env.LOCALAPPDATA || '',
  'electron',
  'Cache',
  '81a88082f2544068e7b917dcf52b8e4cbfee1381073bb8b9f3c543b027d0dba5',
  'electron-v43.3.0-win32-x64.zip'
);
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

if (!fs.existsSync(ZIP)) {
  console.error('找不到 Electron 运行包：' + ZIP);
  console.error('（这个包是本机缓存，如果换电脑需要重新下载 electron-v43.3.0-win32-x64）');
  process.exit(1);
}

fs.mkdirSync(DEST, { recursive: true });
console.log('正在解压到 ' + DEST + ' …');
execFileSync(TAR, ['-xf', ZIP, '-C', DEST], { stdio: 'inherit' });
console.log('完成。现在可以运行：node scripts/dev.js');
