#!/usr/bin/env node
/**
 * 把 qq-digest 接进 DSH profile。
 *
 * 做法和本机既有的 snowluma / wechat-digest 两条 MCP 行完全一致：
 * 在 profile 的 cordis.patch.yml 里维护一段带标记的区块，整体替换、可重复执行。
 *
 * 用法：
 *   node scripts/install.mjs                 # 预览（不写）
 *   node scripts/install.mjs --apply         # 写入（自动备份）
 *   node scripts/install.mjs --apply --profile desktop
 *   node scripts/install.mjs --apply --remove
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const remove = args.includes('--remove');
const profileArg = args.find((arg) => arg.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1] : process.env.DSH_PROFILE || 'desktop';

const BEGIN = '# === qq-digest MCP BEGIN ===';
const END = '# === qq-digest MCP END ===';

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

const dshHome = resolveDshHome();
const patchFile = join(dshHome, 'profiles', profile, 'cordis.patch.yml');

if (!existsSync(patchFile)) {
  console.error(`找不到 profile 配置：${patchFile}`);
  process.exit(1);
}

const block = readFileSync(join(root, 'install', 'cordis.patch.fragment.yml'), 'utf8').trimEnd();
const current = readFileSync(patchFile, 'utf8');

function stripBlock(text) {
  const begin = text.indexOf(BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(END);
  if (end === -1) return text;
  return `${text.slice(0, begin)}${text.slice(end + END.length)}`.replace(/\n{3,}/g, '\n\n').trimEnd();
}

const withoutBlock = stripBlock(current);
const next = remove ? `${withoutBlock}\n` : `${withoutBlock}\n\n${block}\n`;

const changed = next !== current;

console.log(`profile   = ${profile}`);
console.log(`patch     = ${patchFile}`);
console.log(`action    = ${remove ? '移除 qq-digest 行' : '写入/更新 qq-digest 行'}`);
console.log(`changed   = ${changed ? 'yes' : 'no（已是目标状态）'}`);

if (!apply) {
  console.log('（预览模式：没有写入。加 --apply 才真正落盘。）');
  process.exit(0);
}

if (!changed) process.exit(0);

const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(patchFile, backup);
writeFileSync(patchFile, next, 'utf8');
console.log(`已写入。备份：${backup}`);
console.log('重启 DSH 后生效（desktop profile 下 MCP 行通常可热加载，若工具未出现请重启）。');
