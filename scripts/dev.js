'use strict';
/** 开发模式启动（改完源码直接看效果，不用打包） */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'vendor', 'electron', 'electron.exe');

if (!fs.existsSync(EXE)) {
  console.error('缺少运行环境，请先执行：node scripts/extract-electron.js');
  process.exit(1);
}

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE; // 有些终端会设置它，会让 Electron 变成纯 Node

const child = spawn(EXE, [path.join(ROOT, 'src')].concat(process.argv.slice(2)), {
  stdio: 'inherit',
  env,
});
child.on('exit', (code) => process.exit(code || 0));
