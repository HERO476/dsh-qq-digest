#!/usr/bin/env node
/**
 * 把本包挂进 DSH profile —— 不经过 pnpm。
 *
 * 为什么不用 plugin_manager 的 install_bundle：本机 profile 的 node_modules 里有
 * 文件被占用（@img/sharp-win32-x64 EPERM），pnpm 一跑就整批重装并中途失败。
 * 这里只做两件不依赖网络的事：
 *   1) 在 profile 的 node_modules 里建一个 junction 指向本仓库；
 *   2) 在 profile 的 package.json 里登记依赖与 bundle 名单。
 *
 * 用法：
 *   node scripts/link-profile.mjs            # 预览
 *   node scripts/link-profile.mjs --apply    # 写入（自动备份 package.json）
 *   node scripts/link-profile.mjs --apply --profile desktop
 *   node scripts/link-profile.mjs --apply --remove
 */

import { copyFileSync, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE_NAME = 'dsh-qq-digest';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const remove = args.includes('--remove');
const profileArg = args.find((arg) => arg.startsWith('--profile='));
const profile = profileArg ? profileArg.split('=')[1] : process.env.DSH_PROFILE || 'desktop';

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

const profileDir = join(resolveDshHome(), 'profiles', profile);
const manifestPath = join(profileDir, 'package.json');
const linkPath = join(profileDir, 'node_modules', PACKAGE_NAME);

if (!existsSync(manifestPath)) {
  console.error(`找不到 profile：${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const deps = manifest.dependencies ?? {};
const bundles = manifest.dsh?.profile?.bundles ?? [];

const linkSpec = `link:${root.replace(/\\/g, '/')}`;
const linked = existsSync(linkPath) && lstatSync(linkPath).isSymbolicLink();

console.log(`profile   = ${profile}`);
console.log(`package   = ${root}`);
console.log(`junction  = ${linkPath}${linked ? '（已存在）' : '（待创建）'}`);
console.log(`dep       = ${deps[PACKAGE_NAME] ?? '(未登记)'} → ${remove ? '(移除)' : linkSpec}`);
console.log(`bundles   = ${bundles.includes(PACKAGE_NAME) ? '已登记' : '未登记'}`);

if (!apply) {
  console.log('（预览模式：没有写入。加 --apply 才真正落盘。）');
  process.exit(0);
}

if (remove) {
  if (linked) rmSync(linkPath, { recursive: false, force: true });
  delete deps[PACKAGE_NAME];
  manifest.dependencies = deps;
  if (manifest.dsh?.profile) {
    manifest.dsh.profile.bundles = bundles.filter((name) => name !== PACKAGE_NAME);
  }
} else {
  if (!linked) {
    if (existsSync(linkPath)) {
      console.error(`目标已存在且不是 junction：${linkPath}（先手动确认再处理）`);
      process.exit(1);
    }
    symlinkSync(root, linkPath, 'junction');
    console.log('已创建 junction');
  }
  deps[PACKAGE_NAME] = linkSpec;
  manifest.dependencies = deps;
  manifest.dsh = manifest.dsh ?? {};
  manifest.dsh.profile = manifest.dsh.profile ?? {};
  const nextBundles = bundles.includes(PACKAGE_NAME) ? bundles : [...bundles, PACKAGE_NAME];
  manifest.dsh.profile.bundles = nextBundles;
}

const backup = `${manifestPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
copyFileSync(manifestPath, backup);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`已写入 ${manifestPath}`);
console.log(`备份：${backup}`);
console.log('重启 DSH 后生效（bundle 的客户端半在启动时随页加载）。');
