'use strict';
/**
 * 软件库：清单的增删改查 + 添加时的信息读取（名称、图标、同目录候选进程）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJson, writeJson, ensureDir } = require('./store');
const { normalizeTagIds } = require('./tags');
const { extractIcon, runPs } = require('./icon-extract');

const JUNK_PATTERNS = [
  /^unins/i,
  /^uninstall/i,
  /setup/i,
  /^install/i,
  /^vcredist/i,
  /^dxsetup/i,
  /^dxwebsetup/i,
  /^directx/i,
  /^dotnet/i,
  /^redist/i,
  /unitycrashhandler/i,
  /crash/i,
  /^helper/i,
  /^updater/i,
  /^update\./i,
  /^config/i,
  /^launcher_setup/i,
  /^python/i,
  /^node\./i,
  /修改器/,
  /trainer/i,
  /汉化补丁/,
  /^看门狗/i,
];

function isJunkExe(fileName) {
  const base = fileName.replace(/\.exe$/i, '');
  return JUNK_PATTERNS.some((re) => re.test(base));
}

function normalizeName(name) {
  return String(name || '')
    .replace(/\.exe$/i, '')
    .trim()
    .toLowerCase();
}

function cleanText(s) {
  return String(s || '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class AppRegistry {
  constructor({ file, iconDir }) {
    this.file = file;
    this.iconDir = iconDir;
    this.apps = [];
    this.version = 0;
    ensureDir(iconDir);
  }

  load() {
    const data = readJson(this.file, { schemaVersion: 1, apps: [] });
    this.apps = Array.isArray(data.apps) ? data.apps : [];
    // 老版本的清单里没有 tagIds 这一栏：读进来补成空数组，但先不写盘。
    // 只有用户真的去改标签时才 save()，避免「打开一次程序就把文件重写一遍」。
    for (const a of this.apps) a.tagIds = normalizeTagIds(a.tagIds);
    return this;
  }

  save() {
    writeJson(this.file, { schemaVersion: 1, apps: this.apps });
    this.version++;
  }

  list() {
    return this.apps.filter((a) => !a.hidden);
  }

  get(id) {
    return this.apps.find((a) => a.id === id) || null;
  }

  /** 读 exe 的显示名、版本、大小 */
  async inspect(exePath) {
    if (!exePath || !fs.existsSync(exePath)) {
      return { ok: false, reason: '这个文件不存在' };
    }
    const st = fs.statSync(exePath);
    if (!/\.exe$/i.test(exePath)) {
      return { ok: false, reason: '请选择一个 .exe 程序' };
    }

    const base = path.basename(exePath).replace(/\.exe$/i, '');
    const info = { description: '', product: '', version: '', size: st.size, mtime: st.mtimeMs };
    const tmp = path.join(os.tmpdir(), 'ts-info-' + Date.now() + '.json');

    try {
      await runPs('exe-info.ps1', ['-ExePath', exePath, '-OutFile', tmp], 12000);
      if (fs.existsSync(tmp)) {
        const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        Object.assign(info, parsed);
      }
    } catch (e) {
      /* 读不到就用文件名 */
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch (e) {
        /* 忽略 */
      }
    }

    let name = cleanText(info.description) || cleanText(info.product) || base;
    if (name.length > 40) name = name.slice(0, 40);

    const existing = this.apps.find((a) => a.exePath.toLowerCase() === exePath.toLowerCase());
    return {
      ok: true,
      exePath,
      name,
      imageName: base,
      altNames: this.scanSiblings(exePath, normalizeName(base)),
      version: cleanText(info.version),
      size: info.size,
      mtime: info.mtime,
      existedId: existing ? existing.id : null,
    };
  }

  /** 扫同目录（最多两层）里的其它 exe，作为「启动器交接」的候选 */
  scanSiblings(exePath, selfName) {
    const root = path.dirname(exePath);
    const out = [];
    const skipDirs = ['redist', '_commonredist', 'directx', 'dotnet', 'vcredist', 'dxsetup', 'support', 'tools'];

    // 保护 1：系统目录（记事本、计算器之类）不扫，否则会把 System32 几百个程序当候选
    const winRoot = (process.env.SystemRoot || 'C:\\Windows').toLowerCase();
    if (root.toLowerCase().startsWith(winRoot)) return [];

    // 保护 2：目录里 exe 太多（像是工具合集），不做候选猜测
    try {
      const top = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && /\.exe$/i.test(e.name));
      if (top.length > 40) return [];
    } catch (e) {
      return [];
    }

    const walk = (dir, depth) => {
      if (depth > 2 || out.length >= 24) return;
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const ent of entries) {
        if (out.length >= 24) break;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          const low = ent.name.toLowerCase();
          if (skipDirs.some((x) => low.includes(x))) continue;
          if (depth < 2) walk(full, depth + 1);
        } else if (/\.exe$/i.test(ent.name)) {
          const key = normalizeName(ent.name);
          if (!key || key === selfName) continue;
          if (isJunkExe(ent.name)) continue;
          if (!out.includes(key)) out.push(key);
        }
      }
    };

    walk(root, 0);
    return out.slice(0, 20);
  }

  async add(exePath, overrides) {
    const info = await this.inspect(exePath);
    if (!info.ok) return { ok: false, reason: info.reason };
    if (info.existedId) return { ok: false, reason: '这个程序已经在库里了', existedId: info.existedId };

    const id = 'a_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    const iconFile = id + '.png';
    const iconPath = path.join(this.iconDir, iconFile);
    const icon = await extractIcon(exePath, iconPath);

    const app = {
      id,
      name: (overrides && overrides.name) || info.name,
      exePath,
      imageName: info.imageName,
      altNames: info.altNames,
      processAlias: '',
      tagIds: [],
      workDir: path.dirname(exePath),
      iconFile: icon.ok ? iconFile : null,
      iconSize: icon.ok ? icon.size : 0,
      iconSource: icon.source,
      watch: true,
      hidden: false,
      version: info.version,
      exeSize: info.size,
      exeMtimeMs: info.mtime,
      createdMs: Date.now(),
      note: '',
    };

    this.apps.push(app);
    this.save();
    return { ok: true, app };
  }

  update(id, patch) {
    const app = this.get(id);
    if (!app) return { ok: false, reason: '找不到这个软件' };

    // 自定义名称（卡片上那个中文名输入框）
    // 用户填什么，app.name 就显示什么；系统自动读到的原名备份到 autoName，
    // 这样卡片上还能显示英文原名做对照，清空输入框就能一键恢复。
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'customName')) {
      const auto = app.autoName || app.name;
      const custom = cleanText(patch.customName).slice(0, 40);
      app.autoName = auto;
      app.name = custom || auto;
    }

    const allowed = ['name', 'note', 'watch', 'hidden', 'processAlias', 'args'];
    for (const k of allowed) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) app[k] = patch[k];
    }

    // 安全网：程序是靠 exe 文件名（imageName）认进程的。
    // 万一老数据里缺这一栏，改名后可能认不出进程、记不到时长，这里从路径补回来。
    if (!app.imageName && app.exePath) {
      app.imageName = path.basename(app.exePath).replace(/\.exe$/i, '');
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'tagIds')) {
      app.tagIds = normalizeTagIds(patch.tagIds);
    }
    this.save();
    return { ok: true, app };
  }

  remove(id) {
    const idx = this.apps.findIndex((a) => a.id === id);
    if (idx < 0) return { ok: false };
    const [app] = this.apps.splice(idx, 1);
    if (app.iconFile) {
      try {
        fs.unlinkSync(path.join(this.iconDir, app.iconFile));
      } catch (e) {
        /* 忽略 */
      }
    }
    this.save();
    return { ok: true, app };
  }

  /** exe 被移动后重新指路 */
  async relocate(id, newExePath) {
    const app = this.get(id);
    if (!app) return { ok: false, reason: '找不到这个软件' };
    const info = await this.inspect(newExePath);
    if (!info.ok) return { ok: false, reason: info.reason };

    app.exePath = newExePath;
    app.imageName = info.imageName;
    app.altNames = info.altNames;
    app.workDir = path.dirname(newExePath);
    app.exeSize = info.size;
    app.exeMtimeMs = info.mtime;
    if (!app.name) app.name = info.name;

    const iconFile = id + '.png';
    const icon = await extractIcon(newExePath, path.join(this.iconDir, iconFile));
    app.iconFile = icon.ok ? iconFile : null;
    app.iconSize = icon.ok ? icon.size : 0;

    this.save();
    return { ok: true, app };
  }
}

module.exports = { AppRegistry, normalizeName, isJunkExe };
