/**
 * 运行时装配：MCP 进程与 DSH 宿主进程共用这一份。
 *
 * 为什么要共用：如果两边各写一份「怎么读配置、怎么建适配器、怎么建 service」，
 * 迟早会漂——一边支持某个数据源、另一边不支持，症状是「工具能跑、定时不产出」。
 *
 * 数据目录：显式 QQ_DIGEST_DATA_DIR → 否则 <DSH_HOME>/qq-digest/
 *   DSH_HOME 空白视为未设置，绝不退回 cwd（否则换个目录启动就多一份空数据）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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
import { resolveBridgePaths } from './bridge-paths.js';

export const HANDLE_SECRET_FILE = 'handle-secret';
export const MIN_SECRET_LENGTH = 16;

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

export function secretPath(dataDir) {
  return join(dataDir, HANDLE_SECRET_FILE);
}

/**
 * 解析句柄 HMAC 密钥，并如实说明来源。
 *
 * 为什么不再有「默认常量」：常量写死在源码里，等于句柄可离线计算 ——
 * 知道群号/QQ 号的人就能算出 handle 去定向读摘要，不透明句柄这层保护归零。
 *
 * 优先级：QQ_DIGEST_SECRET（>=16 字符）→ <dataDir>/handle-secret → 首次启动随机生成并落盘。
 * 必须落盘：只存内存会让每次重启都换密钥，水位线（按句柄作键）全部作废，等于每次重启全量重跑。
 */
export function resolveSecretInfo(env = process.env, dataDir = resolveDataDir(env)) {
  const fromEnv = env.QQ_DIGEST_SECRET;
  if (typeof fromEnv === 'string' && fromEnv.trim().length >= MIN_SECRET_LENGTH) {
    return { secret: fromEnv.trim(), source: 'env' };
  }

  const file = secretPath(dataDir);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length >= MIN_SECRET_LENGTH) return { secret: existing, source: 'file' };
  } catch {
    // 文件不存在 → 下面生成
  }

  const generated = randomBytes(32).toString('hex');
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    // 写不进去就拒绝启动：宁可工具不可用，也不要用一个「一看就知道」的密钥继续跑。
    const failure = new Error(`HANDLE_SECRET_UNWRITABLE:${file}:${err?.message ?? err}`);
    failure.code = 'HANDLE_SECRET_UNWRITABLE';
    throw failure;
  }
  return { secret: generated, source: 'generated' };
}

export function resolveSecret(env = process.env, dataDir = resolveDataDir(env)) {
  return resolveSecretInfo(env, dataDir).secret;
}

export function readBridgeToken(tokenFile) {
  const resolved = tokenFile || resolveBridgePaths({ env: process.env }).token;
  try {
    return readFileSync(resolved, 'utf8').trim();
  } catch {
    return '';
  }
}

export function readSnowLumaToken(env = process.env, dataDir) {
  if (env.QQ_DIGEST_SNOWLUMA_TOKEN) return env.QQ_DIGEST_SNOWLUMA_TOKEN;
  try {
    const config = JSON.parse(readFileSync(resolveBridgePaths({ env, dataDir }).config, 'utf8'));
    return String(config?.snowluma?.accessToken ?? '');
  } catch {
    return '';
  }
}

export function buildAdapter(source, env = process.env, dataDir) {
  const kind = String(source || 'bridge').toLowerCase();
  if (kind === 'snowluma') {
    return createSnowLumaAdapter({
      httpUrl: env.QQ_DIGEST_SNOWLUMA_URL || 'http://127.0.0.1:3000',
      accessToken: readSnowLumaToken(env, dataDir),
    });
  }
  if (kind === 'fixture') return createFixtureAdapter(DEFAULT_FIXTURE);
  const paths = resolveBridgePaths({ env, dataDir });
  return createBridgeAdapter({
    baseUrl: env.QQ_DIGEST_BRIDGE_URL || 'http://127.0.0.1:3100',
    tokenFile: paths.token,
    readToken: () => readBridgeToken(paths.token),
  });
}

/**
 * @param {{ dataDir?: string, source?: string, env?: object, secret?: string, store?: object, watermark?: object }} [options]
 */
export function createRuntime(options = {}) {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? resolveDataDir(env);
  const source = options.source ?? env.QQ_DIGEST_SOURCE ?? 'bridge';

  const adapter = buildAdapter(source, env, dataDir);
  const llm = resolveLlmConfig({ env });

  const readConfig = () => loadConfig(configPath(dataDir));

  const store = options.store ?? createFileStore({ dir: dataDir });
  const watermark = options.watermark ?? createFileWatermark({ dir: dataDir });
  const secretInfo = options.secret
    ? { secret: options.secret, source: 'explicit' }
    : resolveSecretInfo(env, dataDir);

  const service = createService({
    adapter,
    secret: secretInfo.secret,
    secretSource: secretInfo.source,
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

  return {
    dataDir,
    source,
    adapter,
    llm,
    store,
    watermark,
    readConfig,
    configPath: configPath(dataDir),
    service,
    secret: secretInfo.secret,
    secretSource: secretInfo.source,
  };
}
