#!/usr/bin/env node
/**
 * 发布前/后的全量自检：仓库、脱敏、测试、npm、GitHub、DSH 运行态，一次跑完。
 *
 * 用法：node scripts/final-check.mjs
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let failures = 0;
const ok = (label, detail) => console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
const bad = (label, detail) => { console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`); failures += 1; };
const info = (label, detail) => console.log(`INFO  ${label}${detail ? `  ${detail}` : ''}`);

function run(cmd, args, options = {}) {
  try {
    return {
      ok: true,
      out: execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim(),
    };
  } catch (err) {
    return { ok: false, out: String(err.stdout ?? '').trim(), err: String(err.stderr ?? err.message).trim() };
  }
}

// ── 1. 仓库 ──────────────────────────────────────────────────────────────
const log = run('git', ['log', '--oneline']);
if (log.ok && log.out) {
  const commits = log.out.split('\n');
  ok('git 提交', `${commits.length} 个：${commits[0]}`);
} else bad('git 提交读不到');

const status = run('git', ['status', '--porcelain']);
if (status.ok) {
  if (status.out === '') ok('工作区干净');
  else bad('工作区有未提交改动', status.out.split('\n').slice(0, 3).join(' | '));
}

const tracked = run('git', ['ls-files']);
const fileCount = tracked.ok ? tracked.out.split('\n').filter(Boolean).length : 0;
info('跟踪文件', `${fileCount} 个`);

const remote = run('git', ['remote', '-v']);
info('remote', remote.ok && remote.out ? remote.out.split('\n')[0] : '(未配置)');

// ── 2. 脱敏 ──────────────────────────────────────────────────────────────
// 敏感词**不能写在这个文件里**：本文件随 npm 包一起发布（package.json files 含 scripts），
// 把真实 QQ 号/群号写进来，等于用「检查泄漏的脚本」本身泄漏一遍，而且它还会命中自己，
// 于是永远报 4 项 FAIL。现在改为外部注入：
//   QQ_DIGEST_SENSITIVE_PATTERNS="123456,88888888" node scripts/final-check.mjs
const PATTERNS = String(process.env.QQ_DIGEST_SENSITIVE_PATTERNS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter((value) => value !== '');

// 排除检查器自身：否则只要配了词，就必然命中这个文件。
const GREP_EXCLUDE = [':(exclude)scripts/final-check.mjs'];

let leak = 0;
if (PATTERNS.length === 0) {
  info('脱敏', '未设置 QQ_DIGEST_SENSITIVE_PATTERNS，已跳过（仓库内不得残留个人标识）');
} else {
  for (const pattern of PATTERNS) {
    const hit = run('git', ['grep', '-n', pattern, '--', '.', ...GREP_EXCLUDE]);
    if (hit.ok && hit.out !== '') {
      bad(`仓库里仍有 ${pattern}`, hit.out.split('\n').slice(0, 2).join(' | '));
      leak += 1;
    }
  }
  if (leak === 0) ok('仓库内无个人标识（QQ/群号/用户名）');
}

const bridgePath = join(root, 'src', 'adapters', 'bridge.js');
const bridgeSrc = run('node', ['-e', `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(bridgePath)},'utf8'))`]);
if (bridgeSrc.ok && /resolveBridgePaths/.test(bridgeSrc.out)) ok('桥接路径可解析（无硬编码目录）');
else bad('bridge.js 仍在硬编码路径');

// ── 3. 测试 ──────────────────────────────────────────────────────────────
const tests = run('node', ['--test']);
const summary = (tests.out.match(/# tests (\d+)/) ?? tests.out.match(/ℹ tests (\d+)/) ?? [])[1];
const failed = (tests.out.match(/# fail (\d+)/) ?? tests.out.match(/ℹ fail (\d+)/) ?? [])[1];
if (tests.ok && failed === '0') ok('单元/集成测试', `${summary} 用例全过`);
else bad('测试失败', `fail=${failed ?? '?'}`);

const purity = run('node', ['scripts/check-core-purity.mjs']);
if (purity.ok) ok('core 纯净性', purity.out.split('\n')[0].slice(0, 60));
else bad('core 纯净性检查失败', purity.out);

const smoke = run('node', ['scripts/host-smoke.mjs']);
const smokeLine = (smoke.out.match(/(\d+)\/(\d+) 通过/) ?? []).slice(1).join('/');
if (smoke.ok && smokeLine && smokeLine.split('/')[0] === smokeLine.split('/')[1]) ok('宿主冒烟', `${smokeLine} 通过`);
else bad('宿主冒烟失败', smokeLine || smoke.out.slice(-200));

// ── 4. npm ──────────────────────────────────────────────────────────────
const whoami = run('npm', ['whoami'], { shell: true });
info('npm 登录', whoami.ok ? whoami.out : '(未登录)');

try {
  const res = await fetch('https://registry.npmjs.org/dsh-qq-digest', { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) {
    info('npm 包', '尚未创建');
  } else {
    const meta = await res.json();
    const versions = Object.keys(meta.versions ?? {});
    const latest = meta['dist-tags']?.latest;
    info('npm 版本', versions.join(', ') || '(无)');
    info('npm latest', String(latest));
    info('npm maintainer', (meta.maintainers ?? []).map((m) => `${m.name}<${m.email}>`).join(', ') || '(无)');

    if (versions.some((v) => v !== '0.0.0-stage')) {
      ok('npm 已有正式版本', versions.filter((v) => v !== '0.0.0-stage').join(', '));
    } else {
      bad('npm 只有占位版 0.0.0-stage —— 暂存版本仍未批准', String(latest));
    }
  }
} catch (err) {
  bad('npm registry 查询失败', String(err.message));
}

// ── 5. GitHub ───────────────────────────────────────────────────────────
const lsRemote = run('git', ['ls-remote', 'origin'], {
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  timeout: 20000,
});
if (lsRemote.ok && lsRemote.out !== '') {
  const heads = lsRemote.out.split('\n').filter((line) => line.includes('refs/heads/'));
  ok('GitHub 仓库可达', heads.length ? heads.map((h) => h.split('refs/heads/')[1]).join(',') : '(空仓库)');
} else if (lsRemote.ok) {
  info('GitHub 仓库', '存在但为空，可以直接 push');
} else {
  bad('GitHub 仓库不可达', lsRemote.err.split('\n').slice(0, 2).join(' '));
}

/**
 * 猜不出端口就等于误报。这里从 DSH 自己留下的痕迹里取：
 *  1) QQ_DIGEST_PORT（显式）
 *  2) ~/.dsh/dsh-process.json 里记录的端口
 *  3) 几个历史默认端口兜底
 */
function detectDshPorts() {
  const ports = new Set([8784, 1402, 14802]);
  try {
    const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh');
    const parsed = JSON.parse(readFileSync(join(home, 'dsh-process.json'), 'utf8'));
    for (const value of [parsed?.port, parsed?.webPort, parsed?.web?.port]) {
      if (Number.isInteger(value) && value > 0) ports.add(value);
    }
  } catch {
    // 没有就只试兜底端口
  }
  return [...ports];
}

// ── 6. DSH 运行态 ───────────────────────────────────────────────────────
// DSH 的 Web 端口每次重启都可能变（同一台机器实测过 4845 / 1875 / 4260），
// 因此优先用显式指定，其次才试历史端口，最后直接问 DSH 的进程信息。
const explicitPort = process.env.QQ_DIGEST_PORT
  || (process.argv.find((arg) => arg.startsWith('--port=')) ?? '').split('=')[1]
  || '';
const candidatePorts = [
  ...(explicitPort === '' ? [] : [Number(explicitPort)]),
  ...detectDshPorts(),
];
let base = null;
for (const port of candidatePorts) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/qq-digest-api/state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200) { base = `http://127.0.0.1:${port}`; break; }
  } catch { /* 下一个端口 */ }
}

if (base === null) {
  bad('DSH 里插件没在跑', `试过端口：${candidatePorts.join(', ') || '(无)'}；可用 QQ_DIGEST_PORT=<端口> 指定`);
} else {
  const state = await (await fetch(`${base}/qq-digest-api/state`, { headers: { accept: 'application/json' } })).json();
  ok('宿主半在线', base);
  if (typeof state.groupsEnabled === 'boolean') ok('群聊总开关在位', String(state.groupsEnabled));
  else bad('宿主半是旧版本（缺 groupsEnabled）—— 需要重启 DSH');
  if (Array.isArray(state.privateRooms)) {
    ok('私聊列表中', `${state.privateRooms.length} 条，打开 ${state.privateRooms.filter((r) => r.enabled).length} 条`);
  } else bad('宿主半是旧版本（缺 privateRooms）');
  info('群数', String((state.rooms ?? []).length));
  info('客户端心跳', state.clientBoot ? (state.clientBoot.mountedAt ? '已注册设置页' : `未注册（${state.clientBoot.lastError ?? state.clientBoot.lastPhase}）`) : '(旧版宿主无此字段)');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
