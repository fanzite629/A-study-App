'use strict';
// Small JSON persistence helpers with crash-safe (atomic) writes:
// write to a temp file, flush it to disk, then rename over the target.
const fs = require('node:fs');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  if (fs.existsSync(file)) {
    // Preserve the last valid document; never replace a good backup with corrupt data.
    try { JSON.parse(fs.readFileSync(file, 'utf8')); fs.copyFileSync(file, file+'.backup'); } catch {}
  }
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // On Windows a rename can briefly fail with EPERM/EBUSY when antivirus or
  // the indexer holds the target open; retry a few times before giving up.
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 20 * (i + 1);
      while (Date.now() < until) { /* short synchronous back-off */ }
    }
  }
}

function readState(file) {
  let broken = false;
  for (const candidate of [file, file+'.backup']) {
    try { return JSON.parse(fs.readFileSync(candidate,'utf8')); }
    catch(e) { if(e.code !== 'ENOENT') broken = true; }
  }
  if (broken) throw new Error('学习数据和备份均无法读取，请保留 state.json 文件后恢复。');
  return null;
}
module.exports = { readJson, readState, writeJsonAtomic };
