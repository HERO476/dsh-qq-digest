/**
 * qq-bridge 的位置解析。
 *
 * 为什么要单独一层：这个插件要读本机的 qq-bridge（配置 + 控制台令牌），
 * 但「桥接装在哪」属于**部署信息**，不该硬编码进源码——写死一个绝对路径
 * 等于把作者的用户名和目录结构一起发布出去，别人装上也用不了。
 *
 * 解析优先级：
 *   1. 环境变量 QQ_DIGEST_BRIDGE_ROOT / QQ_DIGEST_BRIDGE_CONFIG / QQ_DIGEST_BRIDGE_TOKEN_FILE
 *   2. <dataDir>/bridge-root.txt（本地一行路径，install.mjs 写入，不进仓库）
 *   3. ~/AI/qq-bridge（约定俗成的默认位置）
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const BRIDGE_ROOT_FILE = 'bridge-root.txt';

/**
 * @param {{ env?: object, dataDir?: string }} [options]
 * @returns {string} 绝对路径
 */
export function resolveBridgeRoot(options = {}) {
  const env = options.env ?? process.env;

  const fromEnv = env.QQ_DIGEST_BRIDGE_ROOT;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());

  if (typeof options.dataDir === 'string' && options.dataDir !== '') {
    try {
      const text = readFileSync(join(options.dataDir, BRIDGE_ROOT_FILE), 'utf8').trim();
      if (text !== '') return resolve(text);
    } catch {
      // 没有本地记录就用默认位置
    }
  }

  return join(homedir(), 'AI', 'qq-bridge');
}

/**
 * @param {{ env?: object, dataDir?: string }} [options]
 * @returns {{ root: string, config: string, token: string }}
 */
export function resolveBridgePaths(options = {}) {
  const env = options.env ?? process.env;
  const root = resolveBridgeRoot(options);

  return {
    root,
    config: env.QQ_DIGEST_BRIDGE_CONFIG ? resolve(env.QQ_DIGEST_BRIDGE_CONFIG) : join(root, 'config.json'),
    token: env.QQ_DIGEST_BRIDGE_TOKEN_FILE ? resolve(env.QQ_DIGEST_BRIDGE_TOKEN_FILE) : join(root, 'state', 'console-token'),
  };
}
