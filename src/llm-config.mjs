/**
 * 模型配置解析：优先环境变量，其次 DSH 凭据文件。
 *
 * 设计原则：**密钥不进仓库、不进日志、不进配置文件**。
 * 这个模块只负责「去哪拿」，拿到的值只存在进程内存里，任何地方都不打印它。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_MODEL = 'deepseek-chat';

export function defaultCredentialsPath() {
  return join(homedir(), '.dsh', '.credentials.yaml');
}

/**
 * 从 DSH 凭据文件里取一个 refs.* 的值。只做窄匹配，不解析整份 YAML。
 * @returns {string|null}
 */
export function readCredential(name, { credentialsPath = defaultCredentialsPath() } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name))) return null;

  let text;
  try {
    text = readFileSync(credentialsPath, 'utf8');
  } catch {
    return null;
  }

  const match = new RegExp(`^\\s{2}${name}:\\s*(.+)$`, 'm').exec(text);
  if (!match) return null;

  const value = match[1].trim().replace(/^["']/, '').replace(/["']$/, '');
  return value.length > 0 ? value : null;
}

/**
 * @returns {{baseUrl:string, model:string, apiKey:string|null, apiKeySource:string}}
 */
export function resolveLlmConfig({ env = process.env, credentialsPath } = {}) {
  const baseUrl = env.QQ_DIGEST_LLM_BASE_URL || DEFAULT_BASE_URL;
  const model = env.QQ_DIGEST_LLM_MODEL || DEFAULT_MODEL;

  let apiKey = env.QQ_DIGEST_LLM_API_KEY || null;
  let apiKeySource = apiKey ? 'env' : 'none';

  if (!apiKey) {
    apiKey = readCredential('DEEPSEEK_API_KEY', credentialsPath ? { credentialsPath } : {});
    if (apiKey) apiKeySource = 'credentials';
  }

  return { baseUrl, model, apiKey, apiKeySource };
}
