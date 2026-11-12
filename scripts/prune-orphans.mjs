#!/usr/bin/env node
/**
 * 清理「孤儿摘要」：`digests.jsonl` 里句柄匹配不上任何**当前存在的会话**的记录。
 *
 * 最常见的来源：换过句柄密钥（0.1.x 的公开常量 → 0.2.x 的随机密钥）。
 * 这类记录读不到（读取路径会按当前策略 + 当前密钥复核），但会让
 * `digestCount` 比 `visibleDigestCount` 大，看着像「摘要丢了」。
 *
 * 判定口径（重要）：
 *   - 孤儿 = 句柄匹配不上**数据源当前列出的任何会话**（与策略无关）；
 *   - 「被策略关掉」的会话**不算孤儿** —— 那是隐藏，不是失效，策略改回来就能读。
 *
 * 用法：
 *   node scripts/prune-orphans.mjs              # 只看，不写
 *   node scripts/prune-orphans.mjs --apply      # 真正重写 digests.jsonl / watermarks.json
 *
 * 注意：数据源不可用时会直接退出，不会「看不见就当孤儿删掉」。
 */

import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createRuntime } from '../src/runtime.js';
import { canonicalize } from '../src/core/canonical.js';
import { roomHandle } from '../src/core/gate.js';
import { DIGEST_FILE, WATERMARK_FILE } from '../src/store-file.js';

const apply = process.argv.includes('--apply');

const runtime = createRuntime({});
const { dataDir, secret, adapter } = runtime;

process.stdout.write(`数据目录 = ${dataDir}\n`);
process.stdout.write(`数据源   = ${runtime.source}\n`);

let rooms;
try {
  rooms = await adapter.listRooms();
} catch (err) {
  console.error(`数据源不可用，拒绝清理（避免把「看不见」当成「不存在」）：${err?.message ?? err}`);
  process.exit(2);
}

const live = new Set();
for (const room of rooms) {
  const canon = canonicalize(room.rawId);
  if (!canon.ok) continue;
  live.add(roomHandle(secret, canon.canonicalId));
}

process.stdout.write(`当前会话 ${rooms.length} 个 → 有效句柄 ${live.size} 个\n`);

// ── 摘要 ────────────────────────────────────────────────────────────────
const digestPath = join(dataDir, DIGEST_FILE);
const kept = [];
const dropped = [];
if (existsSync(digestPath)) {
  for (const line of readFileSync(digestPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      dropped.push({ raw: trimmed.slice(0, 80), reason: 'BAD_JSON' });
      continue;
    }
    if (typeof record?.roomHandle === 'string' && live.has(record.roomHandle)) kept.push(trimmed);
    else dropped.push({ roomHandle: record?.roomHandle, roomTitle: record?.roomTitle ?? null, createdAt: record?.createdAt ?? null, reason: 'ORPHAN' });
  }
}

process.stdout.write(`\n摘要：保留 ${kept.length} 条，待清理 ${dropped.length} 条\n`);
for (const item of dropped) {
  process.stdout.write(`  - ${item.reason} ${item.roomHandle ?? item.raw} ${item.createdAt ?? ''} ${item.roomTitle ?? ''}\n`);
}

// ── 水位线 ──────────────────────────────────────────────────────────────
const watermarkPath = join(dataDir, WATERMARK_FILE);
let watermarkKept = null;
let watermarkDropped = [];
if (existsSync(watermarkPath)) {
  try {
    const parsed = JSON.parse(readFileSync(watermarkPath, 'utf8'));
    watermarkKept = {};
    for (const [key, value] of Object.entries(parsed?.marks ?? {})) {
      if (live.has(key)) watermarkKept[key] = value;
      else watermarkDropped.push(key);
    }
    process.stdout.write(`水位线：保留 ${Object.keys(watermarkKept).length} 个，待清理 ${watermarkDropped.length} 个\n`);
    for (const key of watermarkDropped) process.stdout.write(`  - ${key}\n`);
  } catch (err) {
    process.stdout.write(`水位线文件解析失败，跳过：${err?.message ?? err}\n`);
    watermarkKept = null;
  }
}

if (!apply) {
  process.stdout.write('\n（预览模式：没有写入。加 --apply 才真正清理。）\n');
  process.exit(0);
}

if (dropped.length === 0 && watermarkDropped.length === 0) {
  process.stdout.write('\n没有需要清理的内容。\n');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

if (existsSync(digestPath)) {
  const backup = `${digestPath}.bak-${stamp}`;
  copyFileSync(digestPath, backup);
  const tmp = `${digestPath}.tmp`;
  writeFileSync(tmp, kept.length > 0 ? `${kept.join('\n')}\n` : '', 'utf8');
  renameSync(tmp, digestPath);
  process.stdout.write(`\n已重写 ${DIGEST_FILE}（备份：${backup}）\n`);
}

if (watermarkKept !== null && watermarkDropped.length > 0) {
  const backup = `${watermarkPath}.bak-${stamp}`;
  copyFileSync(watermarkPath, backup);
  const tmp = `${watermarkPath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, marks: watermarkKept }, null, 2)}\n`, 'utf8');
  renameSync(tmp, watermarkPath);
  process.stdout.write(`已重写 ${WATERMARK_FILE}（备份：${backup}）\n`);
}
