#!/usr/bin/env node
/**
 * 把 qq-digest 接进 DSH profile —— 只做**本机接线**，不改任何源码。
 *
 * 做三件事：
 *   1) 在 profile 的 cordis.patch.yml 里维护一段带标记的区块，插入 MCP 行；
 *   2) 把本仓库的真实路径替换进安装片段（模板里是 __PACKAGE_ROOT__ 占位符，
 *      这样仓库本身不携带作者机器的绝对路径）；
 *   3) 把本机 qq-bridge 的位置写进 <DSH_HOME>/qq-digest/bridge-root.txt，
 *      插件运行时靠它找到桥接（源码里不硬编码任何绝对路径）。
 *
 * 用法：
 *   node scripts/install.mjs                      # 预览
 *   node scripts/install.mjs --apply              # 写入（自动备份）
 *   node scripts/install.mjs --apply --profile desktop
 *   node scripts/install.mjs --apply --remove     # 移除 MCP 行
 *   node scripts/install.mjs --apply --bridge-root=D:/path/to/qq-bridge
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
const bridgeArg = args.find((arg) => arg.startsWith('--bridge-root='));
const profile = profileArg ? profileArg.split('=')[1] : process.env.DSH_PROFILE || 'desktop';

const BEGIN = '# === qq-digest MCP BEGIN ===';
const END = '# === qq-digest MCP END ===';
const BRIDGE_ROOT_FILE = 'bridge-root.txt';

function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

/** 找一个真实存在的 qq-bridge 目录（有 state/console-token 才算）。 */
function detectBridgeRoot(explicit) {
  const candidates = [
    explicit,
    process.env.QQ_DIGEST_BRIDGE_ROOT,
    join(homedir(), 'AI', 'qq-bridge'),
    process.env.USERNAME ? `D:/Users/${process.env.USERNAME}/AI/qq-bridge` : null,
    process.env.USERNAME ? `C:/Users/${process.env.USERNAME}/AI/qq-bridge` : null,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'state', 'console-token'))) return resolve(candidate);
  }
  return null;
}

const dshHome = resolveDshHome();
const dataDir = join(dshHome, 'qq-digest');
const patchFile = join(dshHome, 'profiles', profile, 'cordis.patch.yml');
const bridgeRoot = detectBridgeRoot(bridgeArg ? bridgeArg.split('=').slice(1).join('=') : null);

if (!existsSync(patchFile)) {
  console.error(`找不到 profile 配置：${patchFile}`);
  process.exit(1);
}

const fragment = readFileSync(join(root, 'install', 'cordis.patch.fragment.yml'), 'utf8');
const block = fragment
  .replace(/__PACKAGE_ROOT__/g, root.replace(/\\/g, '/'))
  // node 可执行文件必须取当前这台机器上的真实路径：写死任何一台机器的路径，
  // 换机安装都会 spawn ENOENT，而症状是「工具全部消失、插件却像是装好了」。
  .replace(/__NODE_EXE__/g, process.execPath.replace(/\\/g, '/'))
  .trimEnd();

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

console.log(`profile     = ${profile}`);
console.log(`patch       = ${patchFile}`);
console.log(`packageRoot = ${root.replace(/\\/g, '/')}`);
console.log(`bridgeRoot  = ${bridgeRoot ?? '(没找到；插件会退回 ~/AI/qq-bridge)'}`);
console.log(`action      = ${remove ? '移除 qq-digest 行' : '写入/更新 qq-digest 行'}`);
console.log(`patch 变化  = ${changed ? 'yes' : 'no（已是目标状态）'}`);

if (!apply) {
  console.log('（预览模式：没有写入。加 --apply 才真正落盘。）');
  process.exit(0);
}

if (changed) {
  const backup = `${patchFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  copyFileSync(patchFile, backup);
  writeFileSync(patchFile, next, 'utf8');
  console.log(`已写入。备份：${backup}`);
} else {
  console.log('profile patch 无需改动。');
}

// 本机桥接位置：只写一次，不覆盖用户已有设置
if (!remove) {
  const bridgeFile = join(dataDir, BRIDGE_ROOT_FILE);
  if (bridgeRoot === null) {
    console.log(`跳过 ${BRIDGE_ROOT_FILE}：没检测到 qq-bridge（可用 --bridge-root=... 指定）`);
  } else if (existsSync(bridgeFile)) {
    console.log(`${BRIDGE_ROOT_FILE} 已存在，保持不动：${bridgeFile}`);
  } else {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(bridgeFile, `${bridgeRoot.replace(/\\/g, '/')}\n`, 'utf8');
    console.log(`已记录桥接位置：${bridgeFile}`);
  }
}

console.log('重启 DSH 后生效（MCP 行通常可热加载，bundle 行需要重启）。');
