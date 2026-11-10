/**
 * 运行时装配：MCP 进程与 DSH 宿主进程共用这一份。
 *
 * 为什么要共用：如果两边各写一份「怎么读配置、怎么建适配器、怎么建 service」，
 * 迟早会漂——一边支持某个数据源、另一边不支持，症状是「工具能跑、定时不产出」。
 *
 * 数据目录：显式 QQ_DIGEST_DATA_DIR → 否则 <DSH_HOME>/qq-digest/
 *   DSH_HOME 空白视为未设置，绝不退回 cwd（否则换个目录启动就多一份空数据）。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { createBridgeAdapter } from './adapters/bridge.js';
import { createSnowLumaAdapter } from './adapters/snowluma.js';
import { createFixtureAdapter, DEFAULT_FIXTURE } from './adapters/fixture.js';
import { createFileStore, createFileWatermark } from './store-file.js';
import { configPath, loadConfig } from './config.js';
import { createSummarizerFromConfig } from './summarizer-factory.js';
import { createService } from './service.js';
import { resolveLlmConfig } from './llm-config.mjs';

export const DEFAULT_SECRET = 'qq-digest-local-dev-secret-0123456789';

const BRIDGE_CONFIG_FILE = 'D:/Users/30000/AI/qq-bridge/config.json';
const BRIDGE_TOKEN_FILE = 'D:/Users/30000/AI/qq-bridge/state/console-token';

export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(homedir(), '.dsh');
}

export function resolveDataDir(env = process.env) {
  const fromEnv = env.QQ_DIGEST_DATA_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return resolve(fromEnv.trim());
  return join(resolveDshHome(env), 'qq-digest');
}

export function resolveSecret(env = process.env) {
  const value = env.QQ_DIGEST_SECRET;
  return typeof value === 'string' && value.length >= 16 ? value : DEFAULT_SECRET;
}

export function readBridgeToken(tokenFile = BRIDGE_TOKEN_FILE) {
  try {
    return readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

export function readSnowLumaToken(env = process.env) {
  if (env.QQ_DIGEST_SNOWLUMA_TOKEN) return env.QQ_DIGEST_SNOWLUMA_TOKEN;
  try {
    const config = JSON.parse(readFileSync(BRIDGE_CONFIG_FILE, 'utf8'));
    return String(config?.snowluma?.accessToken ?? '');
  } catch {
    return '';
  }
}

export function buildAdapter(source, env = process.env) {
  const kind = String(source || 'bridge').toLowerCase();
  if (kind === 'snowluma') {
    return createSnowLumaAdapter({
      httpUrl: env.QQ_DIGEST_SNOWLUMA_URL || 'http://127.0.0.1:3000',
      accessToken: readSnowLumaToken(env),
    });
  }
  if (kind === 'fixture') return createFixtureAdapter(DEFAULT_FIXTURE);
  return createBridgeAdapter({
    baseUrl: env.QQ_DIGEST_BRIDGE_URL || 'http://127.0.0.1:3100',
    tokenFile: env.QQ_DIGEST_BRIDGE_TOKEN_FILE || BRIDGE_TOKEN_FILE,
    readToken: () => readBridgeToken(env.QQ_DIGEST_BRIDGE_TOKEN_FILE || BRIDGE_TOKEN_FILE),
  });
}

/**
 * @param {{ dataDir?: string, source?: string, env?: object, secret?: string, store?: object, watermark?: object }} [options]
 */
export function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(env);
  const source = options.source ?? env.QQ_DIGEST_SOURCE ?? 'bridge';

  const adapter = buildAdapter(source, env);
  const llm = resolveLlmConfig({ env });

  const readConfig = () => loadConfig(configPath(dataDir));

  const store = options.store ?? createFileStore({ dir: dataDir });
  const watermark = options.watermark ?? createFileWatermark({ dir: dataDir });

  const service = createService({
    adapter,
    secret: options.secret ?? resolveSecret(env),
    store,
    watermark,
    getPolicy: () => readConfig().policy,
    // 桥接不存群名：允许在 config.json 的 groups.<群号>.name 里人工命名。
    titleProvider: (rawId) => {
      const config = readConfig().config;
      if (typeof rawId === 'string' && rawId.startsWith('private:')) {
        const qq = rawId.slice('private:'.length);
        return config.private?.[qq]?.name ?? null;
      }
      return config.groups?.[rawId]?.name ?? null;
    },
    summarize: (input) => createSummarizerFromConfig(readConfig().config, { llm })(input),
  });

  return { dataDir, source, adapter, llm, store, watermark, readConfig, configPath: configPath(dataDir), service };
}
