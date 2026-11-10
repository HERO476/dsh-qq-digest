#!/usr/bin/env node
/**
 * core 层静态检查：纯逻辑层不许碰网络、子进程、文件系统写入，
 * 也不许出现任何「发送」符号。
 *
 * 这不是风格检查，是安全边界检查：
 * core 是唯一做裁决的地方，它如果能触网或写盘，
 * 「只读」就从机制退化成一句承诺。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateToolSurface, TOOLS } from '../src/core/toolSurface.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const coreDir = join(root, 'src', 'core');

const FORBIDDEN_IMPORTS = [
  "node:fs",
  "node:child_process",
  "node:net",
  "node:http",
  "node:https",
  "node:dns",
  "node:tls",
  "node:worker_threads",
];

const FORBIDDEN_TOKENS = [
  /\bfetch\s*\(/,
  /\bsend_message\b/,
  /\bsend_group_msg\b/,
  /\bsend_private_msg\b/,
  /\bsendGroup\s*\(/,
  /\bsendPrivate\s*\(/,
  /\bmark_read\b/,
  /\/api\/send/,
  /\bwriteFileSync\b/,
  /\bappendFileSync\b/,
  /\bexecSync\b/,
  /\bspawnSync\b/,
];

const violations = [];

const files = readdirSync(coreDir).filter((name) => name.endsWith('.js'));
for (const name of files) {
  const text = readFileSync(join(coreDir, name), 'utf8');
  for (const specifier of FORBIDDEN_IMPORTS) {
    if (text.includes(`'${specifier}'`) || text.includes(`"${specifier}"`)) {
      violations.push(`${name}: 不许 import ${specifier}`);
    }
  }
  for (const pattern of FORBIDDEN_TOKENS) {
    if (pattern.test(text)) violations.push(`${name}: 命中禁止符号 ${pattern}`);
  }
}

const surface = validateToolSurface(TOOLS);
for (const violation of surface.violations) violations.push(`toolSurface: ${violation}`);

if (violations.length > 0) {
  console.error('core 纯净性检查失败：');
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`core 纯净性检查通过：${files.length} 个文件，0 违规；工具面 ${TOOLS.length} 个工具，0 违规。`);
