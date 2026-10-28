#!/usr/bin/env node
// 原文库一键备份 / 校验。
//
// 为什么单独写：原文库是「资产」，events/*.jsonl 一旦丢了就真没了
// （桥接侧只有 40 条滑动窗口，DSH 侧会被 compaction 改写）。
// 所以备份要能：打包、算哈希、事后自证完整、并且能直接恢复到另一台机器。
//
// 用法：
//   node scripts/memory-backup.mjs                    # 备份到 state/memory/backups/
//   node scripts/memory-backup.mjs --out D:\备份       # 备份到指定目录（推荐放到网盘/移动盘）
//   node scripts/memory-backup.mjs --keep 30          # 保留最近 30 份（默认 14）
//   node scripts/memory-backup.mjs --verify <dir>     # 校验一份已有备份
//
// 备份格式（刻意保持简单，任何解压工具都能打开）：
//   <dir>/manifest.json
//   <dir>/events/2026-10.jsonl.gz
//
// manifest.json 里每个文件都有 sha256（针对**解压后**的原文），
// 校验时重新解压再算一次，能发现"压缩包坏了但看起来还在"的情况。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_ROOT = path.resolve(HERE, '..');
const STATE_DIR = path.join(BRIDGE_ROOT, 'state');
const MEMORY_DIR = path.join(STATE_DIR, 'memory');
const EVENTS_DIR = path.join(MEMORY_DIR, 'events');

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(name);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

function listEventFiles() {
  if (!fs.existsSync(EVENTS_DIR)) return [];
  return fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.jsonl')).sort();
}

function verifyBackup(dir) {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`不是有效备份（缺 manifest.json）：${dir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let ok = 0, bad = 0;
  const problems = [];
  for (const f of manifest.files || []) {
    const p = path.join(dir, 'events', f.name.replace(/\.jsonl$/, '.jsonl.gz'));
    if (!fs.existsSync(p)) { bad++; problems.push(`${f.name}: 文件缺失`); continue; }
    try {
      const raw = zlib.gunzipSync(fs.readFileSync(p));
      const got = sha256(raw);
      if (got !== f.sha256) { bad++; problems.push(`${f.name}: 哈希不匹配`); }
      else if (raw.toString('utf8').split('\n').filter(Boolean).length !== f.lines) { bad++; problems.push(`${f.name}: 行数不匹配`); }
      else ok++;
    } catch (e) { bad++; problems.push(`${f.name}: 解压失败 ${e.message}`); }
  }
  return { manifest, ok, bad, problems };
}

function backup() {
  const outRoot = path.resolve(flag('--out', path.join(MEMORY_DIR, 'backups')));
  const keep = Number(flag('--keep', '14')) || 14;
  const files = listEventFiles();
  if (!files.length) {
    console.error(`没有可备份的数据：${EVENTS_DIR}`);
    process.exit(1);
  }

  const dir = path.join(outRoot, `backup-${stamp()}`);
  fs.mkdirSync(path.join(dir, 'events'), { recursive: true });

  const entries = [];
  for (const name of files) {
    const src = path.join(EVENTS_DIR, name);
    const raw = fs.readFileSync(src);
    const gz = zlib.gzipSync(raw, { level: 9 });
    const gzName = name.replace(/\.jsonl$/, '.jsonl.gz');
    fs.writeFileSync(path.join(dir, 'events', gzName), gz);
    entries.push({
      name,
      sha256: sha256(raw),
      bytes: raw.length,
      gzBytes: gz.length,
      lines: raw.toString('utf8').split('\n').filter(Boolean).length,
      firstLinePreview: raw.toString('utf8').split('\n')[0].slice(0, 120)
    });
  }

  const manifest = {
    version: 1,
    kind: 'qq-bridge-memory',
    createdAt: Date.now(),
    createdAtText: new Date().toLocaleString('zh-CN', { hour12: false }),
    sourceDir: EVENTS_DIR,
    files: entries,
    totals: {
      files: entries.length,
      bytes: entries.reduce((a, b) => a + b.bytes, 0),
      gzBytes: entries.reduce((a, b) => a + b.gzBytes, 0),
      lines: entries.reduce((a, b) => a + b.lines, 0)
    }
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 立刻自证一次：备份写完马上校验，避免"以为备份好了"。
  const v = verifyBackup(dir);
  console.log(`备份完成：${dir}`);
  console.log(`  文件 ${manifest.totals.files} 个，原文 ${(manifest.totals.bytes / 1024).toFixed(0)} KB → ${(manifest.totals.gzBytes / 1024).toFixed(0)} KB，共 ${manifest.totals.lines} 行`);
  console.log(`  自检：${v.ok} 通过，${v.bad} 失败`);
  if (v.bad) { for (const p of v.problems) console.log(`    ! ${p}`); process.exitCode = 2; }

  // 轮转：只保留最近 keep 份。
  const all = fs.readdirSync(outRoot).filter((n) => n.startsWith('backup-')).sort();
  const excess = all.slice(0, Math.max(0, all.length - keep));
  for (const n of excess) fs.rmSync(path.join(outRoot, n), { recursive: true, force: true });
  if (excess.length) console.log(`  清理旧备份 ${excess.length} 份（保留最近 ${keep} 份）`);

  console.log('\n换机恢复：把该目录整体拷到新机器，解压 events/*.jsonl.gz 回 state/memory/events/，再跑');
  console.log('  node scripts/memory-import.mjs --rebuild');
}

function main() {
  if (has('--verify')) {
    const dir = flag('--verify');
    const v = verifyBackup(dir);
    console.log(`备份目录：${dir}`);
    console.log(`创建时间：${v.manifest.createdAtText || '-'}`);
    console.log(`文件 ${v.manifest.totals?.files ?? v.manifest.files?.length} 个，行数 ${v.manifest.totals?.lines ?? '-'}`);
    console.log(`校验：${v.ok} 通过，${v.bad} 失败`);
    for (const p of v.problems) console.log(`  ! ${p}`);
    if (v.bad) process.exitCode = 2;
    return;
  }
  backup();
}

main();