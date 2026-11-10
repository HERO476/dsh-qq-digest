#!/usr/bin/env node
/**
 * MCP stdio 服务器：把四个只读工具暴露给 DSH。
 *
 * 装配全部交给 runtime.js（与设置页的定时任务共用同一份），本文件只负责协议。
 *
 * 环境变量（一般不用动，run-mcp.mjs 会设好默认值）：
 *   QQ_DIGEST_SOURCE              bridge | snowluma | fixture（默认 bridge）
 *   QQ_DIGEST_SECRET              句柄 HMAC 密钥（>=16 字符）
 *   QQ_DIGEST_DATA_DIR            配置与摘要落盘目录
 *   QQ_DIGEST_BRIDGE_URL          qq-bridge 基址（默认 http://127.0.0.1:3100）
 *   QQ_DIGEST_SNOWLUMA_URL        SnowLuma OneBot HTTP 基址
 *   QQ_DIGEST_SNOWLUMA_TOKEN      （可选）OneBot accessToken
 *
 * 本进程只有读：不导入任何桥接写接口，也不导出任何发送类方法。
 * 运行总结时先抢跨进程锁：否则设置页的定时任务和这里的手动触发会同时跑。
 */

import { createInterface } from 'node:readline';

import { createRuntime } from './runtime.js';
import { withRunLock } from './run-lock.js';
import { createToolHandlers } from './tools.js';
import { TOOLS } from './core/toolSurface.js';

const runtime = createRuntime();
process.stderr.write(
  `[qq-digest] source=${runtime.source} data=${runtime.dataDir} llmKey=${runtime.llm.apiKeySource}\n`,
);

// run_summary 走跨进程锁；拿不到锁如实返回 ALREADY_RUNNING，而不是重复跑一轮。
const service = {
  ...runtime.service,
  runSummary: (request) => withRunLock(runtime.dataDir, () => runtime.service.runSummary(request)),
};

const handlers = createToolHandlers(service);

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  const text = line.trim();
  if (text.length === 0) return;

  let request;
  try {
    request = JSON.parse(text);
  } catch {
    return;
  }

  const { id, method, params } = request ?? {};

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'qq-digest', version: '0.2.0' },
        },
      });
      return;
    }

    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const handler = handlers[name];
      if (!handler) {
        send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'UNKNOWN_TOOL' }], isError: true } });
        return;
      }
      try {
        const output = await handler(params?.arguments ?? {});
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(output, null, 2) }], isError: false },
        });
      } catch (err) {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: String(err?.code ?? err?.message ?? err) }],
            isError: true,
          },
        });
      }
      return;
    }

    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'METHOD_NOT_FOUND' } });
    }
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(err?.message ?? err) } });
    }
  }
});
