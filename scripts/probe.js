'use strict';
/**
 * 环境自检（用系统 node 跑，不需要界面）：
 *   node scripts/probe.js
 * 验证：进程列表能不能读、解析对不对、中文编码有没有问题、耗时多少。
 */

const path = require('path');
const scanMod = require(path.join(__dirname, '..', 'src', 'main', 'services', 'process-scan.js'));

function line(t) {
  console.log('\n=== ' + t + ' ===');
}

(async () => {
  line('1. CSV 解析（模拟带逗号、带引号的行）');
  const ascii1 = Buffer.from('"System","4","Services","0","8,656 K"\r\n"', 'latin1');
  const gbkName = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xbd, 0xf8, 0xb3, 0xcc]); // 「中文进程」的 GBK 字节
  const ascii2 = Buffer.from('.EXE","1234","Console","1","1,024 K"\r\n', 'latin1');
  const tricky = Buffer.concat([ascii1, gbkName, ascii2]);
  const snap0 = scanMod.parseTasklistBuffer(tricky);
  console.log('进程数:', snap0.count);
  console.log('是否识别 pid 1234:', snap0.byPid.has(1234));
  console.log('是否能按中文名查到:', snap0.byName.has('中文进程'));
  console.log('splitCsvLine 字段数应为 5:', scanMod.splitCsvLine('"System","4","Services","0","8,656 K"').length);

  line('2. GBK 解码');
  // "中文" 的 GBK 字节
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  let gbkOk = false;
  try {
    gbkOk = new TextDecoder('gbk').decode(gbkBytes) === '中文';
  } catch (e) {
    gbkOk = false;
  }
  console.log('TextDecoder(gbk) 可用:', gbkOk);

  line('3. 真实进程列表');
  const t0 = Date.now();
  const snap = await scanMod.scan({ force: true });
  const cost = Date.now() - t0;
  console.log('进程数:', snap.count, '| 耗时:', cost + 'ms', '| 命令内耗时:', snap.costMs + 'ms');
  console.log('报错:', snap.error || '无');

  const samples = Array.from(snap.byName.keys()).slice(0, 8);
  console.log('前 8 个进程名:', samples.join(', '));

  line('4. 找自己');
  console.log('node 在运行吗:', scanMod.hasName(snap, 'node'), '| 实例数:', scanMod.countByName(snap, 'node'));
  console.log('explorer 在运行吗:', scanMod.hasName(snap, 'explorer'));

  line('5. 中文进程名在真实列表里的表现');
  const cn = Array.from(snap.byName.keys()).filter((n) => /[\u4e00-\u9fa5]/.test(n));
  console.log('中文名进程数量:', cn.length, cn.slice(0, 5).join(' / '));

  line('结论');
  const pass = snap.count > 50 && snap.byPid.has(4) && gbkOk && snap0.count === 2;
  console.log(pass ? 'P0 通过：进程扫描可用' : 'P0 未通过，需要排查');
  process.exit(pass ? 0 : 1);
})();
