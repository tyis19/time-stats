'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const { initPaths } = require(path.join(__dirname, '..', 'src', 'main', 'paths.js'));
  const P = initPaths();
  const { AppRegistry } = require(path.join(__dirname, '..', 'src', 'main', 'services', 'apps.js'));
  const reg = new AppRegistry({ file: P.appsFile, iconDir: P.iconDir }).load();

  const out = {
    env_TS_DATA_DIR: process.env.TS_DATA_DIR || '(未设置)',
    appPath: app.getAppPath(),
    exePath: app.getPath('exe'),
    isPackaged: app.isPackaged,
    dataDir: P.dataDir,
    appsFile: P.appsFile,
    appsFileExists: fs.existsSync(P.appsFile),
    appsCount: reg.apps.length,
    names: reg.apps.map((a) => a.name),
    userData: app.getPath('userData'),
  };
  console.log(JSON.stringify(out, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'tmp-test', 'diag.json'), JSON.stringify(out, null, 2));
  setTimeout(() => app.quit(), 200);
});
