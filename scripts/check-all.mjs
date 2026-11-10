#!/usr/bin/env node
/**
 * 全量自检：把「插件在 DSH 里到底通不通」一次跑完。
 *
 * 只做只读探测 + 三个必然失败的写入（用来验证拒绝路径），不改动你的真实配置。
 *
 * 用法：node scripts/check-all.mjs [端口]
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORTS = process.argv[2] ? [Number(process.argv[2])] : [4845, 8784, 1402, 14802];
const DATA_DIR = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'qq-digest');

let failures = 0;
const ok = (label, detail) => console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail) => { console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`); failures += 1; };
const info = (label, detail) => console.log(`INFO  ${label}${detail ? `  ${detail}` : ''}`);

// ── 1. 静态：源码完整性 ───────────────────────────────────────────────────
for (const file of ['lib/index.js', 'lib/client.js', 'src/config.js', 'src/runtime.js', 'src/service.js', 'package.json', 'cordis.patch.yml']) {
  if (existsSync(join(root, file))) ok(`文件存在 ${file}`);
  else bad(`缺文件 ${file}`);
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.dsh?.bundle?.patch) ok('manifest: dsh.bundle.patch', manifest.dsh.bundle.patch);
else bad('manifest 缺 dsh.bundle.patch');
if (manifest.dsh?.client?.platform === 'web') ok('manifest: dsh.client.platform', 'web');
else bad('manifest 缺 dsh.client.platform');
if (Array.isArray(manifest.dsh?.client?.inject) && manifest.dsh.client.inject.length > 0) {
  ok('manifest: dsh.client.inject', manifest.dsh.client.inject.length + ' 个依赖');
} else bad('manifest 缺 dsh.client.inject');

const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
if (/-\s*insert:/.test(patch) && /name:\s*dsh-qq-digest/.test(patch)) ok('bundle patch 形态正确');
else bad('bundle patch 形态不对');

// ── 2. profile 接线 ──────────────────────────────────────────────────────
const profileDir = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', 'desktop');
try {
  const profilePkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'));
  if (profilePkg.dsh?.profile?.bundles?.includes('dsh-qq-digest')) ok('profile 已登记 bundle');
  else bad('profile 未登记 bundle');
  if (profilePkg.dependencies?.['dsh-qq-digest']) ok('profile 已登记依赖', profilePkg.dependencies['dsh-qq-digest']);
  else bad('profile 未登记依赖');

  const linkPath = join(profileDir, 'node_modules', 'dsh-qq-digest');
  if (existsSync(linkPath)) ok('junction 存在');
  else bad('junction 不存在');
} catch (err) {
  bad('读不到 profile', String(err.message));
}

// ── 3. 宿主半在线与状态形状 ──────────────────────────────────────────────
let base = null;
for (const port of PORTS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/qq-digest-api/state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 200) { base = `http://127.0.0.1:${port}`; break; }
  } catch { /* 下一个端口 */ }
}

if (base === null) {
  bad('宿主半不在线（DSH 没跑，或 bundle 没加载）');
} else {
  ok('宿主半在线', base);
  const state = await (await fetch(`${base}/qq-digest-api/state`, { headers: { accept: 'application/json' } })).json();
  const newHost = typeof state.groupsEnabled === 'boolean';

  if (typeof state.groupsEnabled === 'boolean') ok('状态含群聊总开关', String(state.groupsEnabled));
  else bad('状态缺 groupsEnabled —— 宿主半还是旧版本，需要重启');

  if (Array.isArray(state.privateRooms)) {
    ok('状态含私聊列表', `${state.privateRooms.length} 条，打开 ${state.privateRooms.filter((r) => r.enabled).length} 条`);
    const named = state.privateRooms.filter((r) => r.named);
    info('已命名的私聊', named.length ? named.map((r) => `${r.qq}→${r.name}`).join(', ') : '(无)');
  } else bad('状态缺 privateRooms —— 宿主半还是旧版本');

  info('群列表', (state.rooms ?? []).map((r) => `${r.title ?? r.groupId}${r.enabled ? '' : '(关)'}`).join(' / ') || '(空)');
  info('摘要器', state.summarizer);
  info('定时', JSON.stringify(state.schedule));
  info('客户端心跳', JSON.stringify(state.clientBoot ?? null));

  if (state.clientBoot === undefined) {
    info('clientBoot', '旧版宿主没有这个字段（重启后才有），不代表客户端有问题');
  } else if (state.clientBoot?.mountedAt) {
    ok('客户端半已注册设置页');
  } else if (state.clientBoot?.factoryAt) {
    bad('客户端半执行了但没注册上', state.clientBoot.lastError ?? state.clientBoot.lastPhase);
  } else {
    bad('客户端半没有任何心跳（bundle 没执行）');
  }

  if (state.policyDegraded) bad('策略降级（配置损坏 → 全关）', state.configError);
  else ok('策略正常（未降级）');

  if (state.adapterError) bad('数据源报错', state.adapterError.message);
  else ok('数据源无报错');

  // 拒绝路径：这三个都必须在落盘前被拒
  const post = async (path, body) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  };

  const badGroup = await post('/qq-digest-api/config', { groups: { 'private:1000000001': { enabled: true } } });
  if (badGroup.status === 400) ok('群列表里塞私聊 id → 400');
  else bad('群列表里塞私聊 id 没被拒', badGroup.status);

  const badTime = await post('/qq-digest-api/config', { schedule: { enabled: true, kind: 'daily', time: '25:99', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } });
  if (badTime.status === 400) ok('非法定时时间 → 400');
  else bad('非法定时时间没被拒', badTime.status);

  const badPrivate = newHost
    ? await post('/qq-digest-api/config', { private: { abc: { enabled: true } } })
    : null;
  if (badPrivate === null) info('跳过私聊键校验', '宿主半是旧版本，还没有 private 字段');
  else if (badPrivate.status === 400) ok('私聊键不是 QQ 号 → 400');
  else bad('非法私聊键没被拒', badPrivate.status);

  const badDigest = await fetch(`${base}/qq-digest-api/digest?group=private:1`);
  if (badDigest.status === 400) ok('按私聊取摘要 → 400');
  else bad('按私聊取摘要没被拒', badDigest.status);

  const notFound = await fetch(`${base}/qq-digest-api/nope`);
  if (notFound.status === 404) ok('未知路径 → 404');
  else bad('未知路径返回异常', notFound.status);
}

// ── 4. 落盘 ──────────────────────────────────────────────────────────────
for (const [name, label] of [['config.json', '配置'], ['digests.jsonl', '摘要'], ['watermarks.json', '水位线'], ['client-boot.json', '客户端心跳']]) {
  const file = join(DATA_DIR, name);
  if (!existsSync(file)) { info(`${label}文件`, `${name} 不存在`); continue; }
  const size = statSync(file).size;
  if (name.endsWith('.jsonl')) {
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    info(`${label}文件`, `${name} ${lines} 行 / ${size}B`);
  } else {
    info(`${label}文件`, `${name} ${size}B`);
  }
}

if (existsSync(join(DATA_DIR, 'config.json'))) {
  const cfg = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8'));
  info('配置内容', JSON.stringify({
    groupsEnabled: cfg.groupsEnabled,
    groups: Object.keys(cfg.groups ?? {}).length,
    private: Object.entries(cfg.private ?? {}).filter(([, v]) => v.enabled).length + ' 条打开',
    summarizer: cfg.summarizer,
  }));
  if (cfg.private && Object.values(cfg.private).some((v) => v.enabled === true)) {
    info('注意', '有私聊处于打开状态（这是你显式设的，不是默认）');
  }
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
