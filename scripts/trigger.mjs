#!/usr/bin/env node
/**
 * 命令行手动触发一次总结（走设置页同一套 API，不是另一条路径）。
 *
 * 用法：node scripts/trigger.mjs [端口]
 *
 * 它会真的调用模型（如果 config.summarizer === 'llm'），因此会产生少量费用。
 */

const PORTS = process.argv[2] ? [Number(process.argv[2])] : [8784, 1402, 14802];

let base = null;
for (const port of PORTS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/qq-digest-api/state`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 200) {
      base = `http://127.0.0.1:${port}`;
      break;
    }
  } catch {
    // 换下一个端口
  }
}

if (base === null) {
  console.error('找不到在跑的 DSH（8784/1402/14802 都没响应 /qq-digest-api/state）');
  process.exit(1);
}

console.log(`目标 ${base}`);
const started = Date.now();
const res = await fetch(`${base}/qq-digest-api/run`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ trigger: 'manual' }),
  signal: AbortSignal.timeout(180_000),
});
const payload = await res.json();
console.log(`HTTP ${res.status}，耗时 ${Math.round((Date.now() - started) / 1000)}s`);

const result = payload.result ?? {};
console.log(`状态 ${result.status}`);
console.log(`产出 ${(result.summarized ?? []).length} 个群 / 跳过 ${(result.skipped ?? []).length} / 拒绝 ${(result.denied ?? []).length} / 失败 ${(result.errors ?? []).length}`);

for (const item of result.summarized ?? []) {
  console.log(`  ✓ ${item.roomTitle ?? item.roomHandle}：${item.messageCount} 条消息 → ${item.highlights} 条重点 / ${item.tasks} 项待办`);
}
for (const item of result.skipped ?? []) {
  console.log(`  - ${item.roomHandle}：${item.reason}`);
}
for (const item of result.errors ?? []) {
  console.log(`  ✗ ${item.roomHandle}：${item.code} ${item.message}`);
}

// 打印每个群最新一篇摘要的要点数量，正文留给设置页看
const state = await (await fetch(`${base}/qq-digest-api/state`, { headers: { accept: 'application/json' } })).json();
for (const room of state.rooms ?? []) {
  if (!room.hasDigest) continue;
  const digest = await (await fetch(`${base}/qq-digest-api/digest?ref=${room.ref}`, { headers: { accept: 'application/json' } })).json();
  const d = digest.digest ?? {};
  console.log(`\n[${room.title ?? room.ref}] ${room.lastDigestAt}`);
  console.log(`  ${d.overview ?? '(无概述)'}`);
  (d.tasks ?? []).slice(0, 3).forEach((task) => console.log(`  · 待办：${task.what}${task.owner && task.owner !== '未指定' ? `（${task.owner}）` : ''}`));
}
