#!/usr/bin/env node
/**
 * 入口：解析数据目录、准备好环境变量，再拉起 MCP 服务器。
 *
 * 数据目录规则（沿用本机插件约定）：
 *   显式 $DSH_HOME（**空白视为未设置**）→ 否则 ~/.dsh
 *   → <DSH_HOME>/qq-digest/
 *
 * 刻意不用「相对进程 cwd」：从哪个目录启动 DSH，就会得到第二份空数据，
 * 表现为「摘要凭空消失」。
 */

import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));

function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

if (!process.env.QQ_DIGEST_DATA_DIR || process.env.QQ_DIGEST_DATA_DIR.trim() === '') {
  const dataDir = join(resolveDshHome(), 'qq-digest');
  mkdirSync(dataDir, { recursive: true });
  process.env.QQ_DIGEST_DATA_DIR = dataDir;
}

if (!process.env.QQ_DIGEST_SOURCE || process.env.QQ_DIGEST_SOURCE.trim() === '') {
  process.env.QQ_DIGEST_SOURCE = 'bridge';
}

// Windows 下裸盘符不是合法 ESM specifier，必须转成 file:// URL。
await import(pathToFileURL(join(here, 'mcp-server.js')).href);
