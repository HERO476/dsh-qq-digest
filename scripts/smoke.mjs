#!/usr/bin/env node
/**
 * 冒烟测试：用真实子进程跑一遍 MCP 协议，验证「装进去能用」而不只是「单元测试绿」。
 *
 * 用法：
 *   node scripts/smoke.mjs                 # fixture 源（零副作用）
 *   node scripts/smoke.mjs bridge          # 真桥接（只读；不会发消息）
 *   node scripts/smoke.mjs snowluma        # 直连 SnowLuma（需网关在线）
 *
 * 它只发 tools/list 与三个只读工具的调用；run_summary 在 fixture 源下用本地启发式摘要，
 * 不消耗模型额度。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = process.argv[2] || 'fixture';
const summarizer = process.argv[3] || 'heuristic';

const dataDir = mkdtempSync(join(tmpdir(), 'qq-digest-smoke-'));
// 把本机记录的 qq-bridge 位置带进临时数据目录，否则 bridge 源会退回 ~/AI/qq-bridge 而找不到令牌
const realBridgeRoot = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'qq-digest', 'bridge-root.txt');
if (existsSync(realBridgeRoot)) writeFileSync(join(dataDir, 'bridge-root.txt'), readFileSync(realBridgeRoot, 'utf8'), 'utf8');
writeFileSync(
  join(dataDir, 'config.json'),
  `${JSON.stringify(
    {
      version: 1,
      groups: {},
      summarizer,
      schedule: { enabled: false, kind: 'daily', weekdays: ['MO'], time: '09:00', timeZone: 'Asia/Shanghai' },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const child = spawn(process.execPath, [join(root, 'src', 'run-mcp.mjs')], {
  env: { ...process.env, QQ_DIGEST_SOURCE: source, QQ_DIGEST_DATA_DIR: dataDir },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdout = '';
let stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdout += chunk;
});
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});

const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'qq_digest_status', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'qq_digest_list_rooms', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'qq_digest_run_summary', arguments: {} } },
  { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'qq_digest_get_digest', arguments: {} } },
];

for (const request of requests) {
  child.stdin.write(`${JSON.stringify(request)}\n`);
  await new Promise((resolve) => setTimeout(resolve, 400));
}
child.stdin.end();

await new Promise((resolve) => {
  const timer = setTimeout(() => {
    child.kill();
    resolve();
  }, 25_000);
  child.on('exit', () => {
    clearTimeout(timer);
    resolve();
  });
});

const responses = new Map();
for (const line of stdout.split('\n')) {
  const trimmed = line.trim();
  if (trimmed === '') continue;
  try {
    const message = JSON.parse(trimmed);
    if (message.id !== undefined) responses.set(message.id, message);
  } catch {
    // 忽略非 JSON 行
  }
}

function text(id) {
  const message = responses.get(id);
  if (!message) return '(无响应)';
  if (message.error) return `ERROR ${message.error.message}`;
  if (message.result?.tools) return message.result.tools.map((tool) => tool.name).join(', ');
  return String(message.result?.content?.[0]?.text ?? '').replace(/\s+/g, ' ').slice(0, 700);
}

console.log(`source = ${source} / summarizer = ${summarizer}`);
console.log(`stderr = ${stderr.trim().split('\n').slice(0, 2).join(' | ')}`);
console.log(`tools  = ${text(2)}`);
console.log(`status = ${text(3)}`);
console.log(`rooms  = ${text(4)}`);
console.log(`run    = ${text(5)}`);
console.log(`digest = ${text(6)}`);

const all = [...responses.values()].map((message) => JSON.stringify(message)).join('\n');
const leaks = ['PRIVATE_SENTINEL', 'private:', '男人', 'EXCLUDED_SENTINEL'].filter((needle) => all.includes(needle));
console.log(`private 泄漏检查 = ${leaks.length === 0 ? '通过（无 private 痕迹）' : `失败：${leaks.join(',')}`}`);
