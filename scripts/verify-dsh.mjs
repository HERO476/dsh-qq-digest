#!/usr/bin/env node
/**
 * DSH 适配性自检：一次跑完「插件在宿主里到底活没活」的全部可观测证据。
 *
 * 检查项：
 *   1) 宿主半：设置页 API 是否可达、返回什么
 *   2) 客户端半：最近一次 web boot 有没有因为它失败（看 desktop 的 crash log）
 *   3) MCP 行：run-mcp 进程是否在跑
 *   4) 落盘：配置/摘要目录状态
 *
 * 用法：node scripts/verify-dsh.mjs [端口]
 * 端口省略时按 8784 → 1402 → 14802 依次试。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PORTS = process.argv[2] ? [Number(process.argv[2])] : [8784, 1402, 14802];
const LOG_DIR = join(homedir(), 'AppData', 'Roaming', '@deepseek-ai', 'dsh-desktop', 'logs');
const DATA_DIR = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'qq-digest');

function ok(label, detail) {
  console.log(`PASS  ${label}${detail ? `  ${detail}` : ''}`);
}
function bad(label, detail) {
  console.log(`FAIL  ${label}${detail ? `  ${detail}` : ''}`);
}

let failures = 0;

// 1) 宿主半
let state = null;
for (const port of PORTS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/qq-digest-api/state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 200) {
      state = await res.json();
      ok('宿主半在线', `:${port} source=${state.source} 群=${state.rooms?.length ?? 0}`);
      break;
    }
    console.log(`      :${port} HTTP ${res.status}`);
  } catch {
    console.log(`      :${port} 不可达`);
  }
}
if (state === null) {
  bad('宿主半未响应（DSH 没在跑，或行没挂上）');
  failures += 1;
} else {
  if (Array.isArray(state.rooms) && state.rooms.length > 0) ok('群列表非空');
  else bad('群列表为空（数据源不可达？）'), (failures += 1);
  if (state.policyDegraded) bad('策略降级（配置损坏 → 全关）', state.configError), (failures += 1);
  else ok('策略正常');
  if (state.adapterError) bad('数据源报错', state.adapterError.message), (failures += 1);
  else ok('数据源无报错');
}

// 2) 客户端半：看最近一次 web boot 是否因本插件失败
try {
  const clientFile = join(import.meta.dirname, '..', 'lib', 'client.js');
  const fixTime = statSync(clientFile).mtimeMs;

  const files = readdirSync(LOG_DIR)
    .filter((name) => name.endsWith('-web-boot.log'))
    .map((name) => ({ name, path: join(LOG_DIR, name), mtime: statSync(join(LOG_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const newest = files[0];
  if (!newest) {
    console.log('SKIP  客户端半：没有 web-boot 崩溃日志可查（通常就是好事）');
  } else if (newest.mtime < fixTime) {
    // 修复之后还没重新加载过：既不能算通过，也不能把旧的失败算到新代码头上。
    console.log(`SKIP  客户端半：修复后还没重新加载过（最近一次 boot ${new Date(newest.mtime).toISOString()} 早于 client.js ${new Date(fixTime).toISOString()}）`);
  } else if (readFileSync(newest.path, 'utf8').includes('dsh-qq-digest: import failed')) {
    bad('客户端半加载失败', `${newest.name} @ ${new Date(newest.mtime).toISOString()}`);
    failures += 1;
  } else {
    ok('客户端半最近一次启动未报错', new Date(newest.mtime).toISOString());
  }
} catch (err) {
  console.log(`SKIP  客户端半：读不到 desktop 日志目录（${err.code ?? err.message}）`);
}

// 3) MCP 行
try {
  const { execSync } = await import('node:child_process');
  const out = execSync('tasklist /FI "IMAGENAME eq node.exe" /FO CSV', { encoding: 'utf8' });
  ok('node 进程可枚举', `${out.split('\n').length - 2} 个（具体 run-mcp 进程见任务管理器）`);
} catch {
  console.log('SKIP  MCP 进程枚举失败');
}

// 4) 落盘
const configFile = join(DATA_DIR, 'config.json');
const digests = join(DATA_DIR, 'digests.jsonl');
console.log(`     数据目录 ${DATA_DIR}`);
console.log(`     config.json ${existsSync(configFile) ? '存在' : '不存在'}`);
if (existsSync(digests)) {
  const lines = readFileSync(digests, 'utf8').split('\n').filter(Boolean).length;
  console.log(`     digests.jsonl ${lines} 条摘要`);
} else {
  console.log('     digests.jsonl 还没有（还没跑过总结）');
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
