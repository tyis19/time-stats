'use strict';
/** 截图裁剪小工具：node 版没有图像库，借用 Electron 的 nativeImage */

const { app, nativeImage } = require('electron');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const [src, x, y, w, h, scale, out] = process.argv.slice(2);
  try {
    const img = nativeImage.createFromPath(src);
    const size = img.getSize();
    const cropped = img.crop({ x: +x, y: +y, width: +w, height: +h });
    const resized = cropped.resize({ width: Math.round(+w * +scale), height: Math.round(+h * +scale), quality: 'best' });
    fs.writeFileSync(out, resized.toPNG());
    console.log('原图 ' + size.width + 'x' + size.height + ' → ' + out);
  } catch (e) {
    console.error('裁剪失败:', e.message);
    process.exitCode = 1;
  }
  setTimeout(() => app.quit(), 200);
});
