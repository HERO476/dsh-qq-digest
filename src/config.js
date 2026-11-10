/**
 * 插件配置：哪些群可读、用哪个摘要器、定时参数。
 *
 * 存在 <DSH_HOME>/qq-digest/config.json。
 * 校验失败 → **全关**（fail-closed），绝不回退到「默认允许」。
 *
 * 顶层没有 private 字段，也不允许出现：写了就整份配置作废。
 * 这不是「默认关」，是「没有这个概念」。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalize, KIND } from './core/canonical.js';
import { failClosedPolicy } from './core/policy.js';

export const CONFIG_VERSION = 1;
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const TOP_KEYS = new Set(['version', 'groupsEnabled', 'groups', 'private', 'summarizer', 'schedule']);
const GROUP_KEYS = new Set(['enabled', 'name']);
const SCHEDULE_KEYS = new Set(['enabled', 'kind', 'weekdays', 'time', 'timeZone']);

/** 这些词出现在键名里，就不是「写错了」，而是「想开个不该有的口子」。 */
const FORBIDDEN_KEY_HINT = /friend|c2c|uin|send|reply|post|forward|comment|broadcast|allowall|allowprivate|scope|write/i;

export function defaultConfig() {
  return {
    version: CONFIG_VERSION,
    groupsEnabled: true,
    groups: {},
    private: {},
    summarizer: 'llm',
    schedule: {
      enabled: true,
      kind: 'weekly',
      weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'],
      time: '09:00',
      timeZone: 'Asia/Shanghai',
    },
  };
}

function bad(reason) {
  return { ok: false, reason };
}

export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('NOT_OBJECT');

  for (const key of Object.keys(raw)) {
    if (TOP_KEYS.has(key)) continue;
    if (FORBIDDEN_KEY_HINT.test(key)) return bad(`FORBIDDEN_KEY:${key}`);
    return bad(`UNKNOWN_KEY:${key}`);
  }
  if (raw.version !== CONFIG_VERSION) return bad(`BAD_VERSION:${String(raw.version)}`);

  const groups = {};
  const rawGroups = raw.groups ?? {};
  if (rawGroups === null || typeof rawGroups !== 'object' || Array.isArray(rawGroups)) {
    return bad('GROUPS_NOT_OBJECT');
  }
  for (const [id, value] of Object.entries(rawGroups)) {
    const canon = canonicalize(id);
    if (!canon.ok) return bad(`GROUP_BAD_ID:${canon.reason}`);
    if (canon.kind !== KIND.GROUP) return bad(`GROUP_NOT_GROUP:${canon.kind}`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bad('GROUP_NOT_OBJECT');
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEY_HINT.test(key)) return bad(`GROUP_FORBIDDEN_KEY:${key}`);
      if (!GROUP_KEYS.has(key)) return bad(`GROUP_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return bad('GROUP_ENABLED_NOT_BOOLEAN');
    groups[canon.canonicalId] = {
      enabled: value.enabled,
      ...(value.name === undefined ? {} : { name: String(value.name).slice(0, 60) }),
    };
  }

  const groupsEnabled = raw.groupsEnabled === undefined ? true : raw.groupsEnabled;
  if (typeof groupsEnabled !== 'boolean') return bad('GROUPS_ENABLED_NOT_BOOLEAN');

  // 私聊：默认全关，只能逐条打开。
  const privateMap = {};
  const rawPrivate = raw.private ?? {};
  if (rawPrivate === null || typeof rawPrivate !== 'object' || Array.isArray(rawPrivate)) {
    return bad('PRIVATE_NOT_OBJECT');
  }
  for (const [qq, value] of Object.entries(rawPrivate)) {
    if (!/^\d{5,12}$/.test(qq)) return bad(`PRIVATE_BAD_QQ:${qq}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return bad('PRIVATE_ENTRY_NOT_OBJECT');
    for (const key of Object.keys(value)) {
      if (key !== 'enabled' && key !== 'name') return bad(`PRIVATE_ENTRY_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return bad('PRIVATE_ENTRY_NOT_BOOLEAN');
    if (value.name !== undefined && typeof value.name !== 'string') return bad('PRIVATE_NAME_NOT_STRING');
    const privateName = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
    privateMap[qq] = { enabled: value.enabled, ...(privateName ? { name: privateName } : {}) };
  }

  if (raw.summarizer !== 'llm' && raw.summarizer !== 'heuristic') return bad('SUMMARIZER_INVALID');

  const rawSchedule = raw.schedule ?? defaultConfig().schedule;
  if (rawSchedule === null || typeof rawSchedule !== 'object' || Array.isArray(rawSchedule)) {
    return bad('SCHEDULE_NOT_OBJECT');
  }
  for (const key of Object.keys(rawSchedule)) {
    if (!SCHEDULE_KEYS.has(key)) return bad(`SCHEDULE_UNKNOWN_KEY:${key}`);
  }
  if (typeof rawSchedule.enabled !== 'boolean') return bad('SCHEDULE_ENABLED_NOT_BOOLEAN');
  if (rawSchedule.kind !== 'daily' && rawSchedule.kind !== 'weekly') return bad('SCHEDULE_KIND_INVALID');
  if (!TIME_RE.test(String(rawSchedule.time))) return bad('SCHEDULE_TIME_INVALID');

  const weekdays = rawSchedule.weekdays ?? WEEKDAYS.slice(0, 5);
  if (!Array.isArray(weekdays) || weekdays.length === 0) return bad('SCHEDULE_WEEKDAYS_EMPTY');
  for (const day of weekdays) {
    if (!WEEKDAYS.includes(day)) return bad(`SCHEDULE_WEEKDAY_INVALID:${day}`);
  }
  if (typeof rawSchedule.timeZone !== 'string' || rawSchedule.timeZone.length === 0) {
    return bad('SCHEDULE_TIMEZONE_INVALID');
  }

  return {
    ok: true,
    config: {
      version: CONFIG_VERSION,
      groupsEnabled,
      groups,
      private: privateMap,
      summarizer: raw.summarizer,
      schedule: {
        enabled: rawSchedule.enabled,
        kind: rawSchedule.kind,
        weekdays: [...weekdays],
        time: String(rawSchedule.time),
        timeZone: rawSchedule.timeZone,
      },
    },
  };
}

/** 配置 → core 的策略对象（gate 直接吃这个）。这里没有 private 分支，也没有它的位置。 */
export function toPolicy(config) {
  const overrides = {};
  for (const [id, value] of Object.entries(config.groups ?? {})) {
    overrides[id] = { enabled: value.enabled };
  }

  // 总开关关掉时单群覆盖一律作废：否则「全局关 + 单群开」会把总开关变成摆设。
  const groupDefault = config.groupsEnabled !== false;

  // 私聊只有显式 enabled: true 的条目才进策略；默认一律不读。
  const privateOverrides = {};
  for (const [qq, value] of Object.entries(config.private ?? {})) {
    if (value?.enabled === true) privateOverrides[`private:${qq}`] = { enabled: true };
  }

  return {
    version: 1,
    group: { defaultEnabled: groupDefault, overrides: groupDefault ? overrides : {} },
    private: { defaultEnabled: false, overrides: privateOverrides },
  };
}

export function configPath(dataDir) {
  return join(dataDir, 'config.json');
}

/**
 * 读配置。
 *  - 文件不存在 → 默认配置（首次启动的正常路径）
 *  - 文件损坏   → config 退回空设置，且 policy 为 **fail-closed（全关）**
 *
 * policy 与 config 一并返回，避免调用方忘记处理 error 而按「群默认开」放行。
 *
 * @returns {{config:object, error:string|null, policy:object}}
 */
export function loadConfig(path) {
  if (!existsSync(path)) {
    const config = defaultConfig();
    return { config, error: null, policy: toPolicy(config) };
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const config = { ...defaultConfig(), groups: {} };
    return { config, error: `PARSE:${err.message}`, policy: failClosedPolicy(`PARSE:${err.message}`) };
  }

  const parsed = parseConfig(raw);
  if (!parsed.ok) {
    const config = { ...defaultConfig(), groups: {} };
    return { config, error: parsed.reason, policy: failClosedPolicy(parsed.reason) };
  }

  return { config: parsed.config, error: null, policy: toPolicy(parsed.config) };
}

export function saveConfig(path, config) {
  const parsed = parseConfig(config);
  if (!parsed.ok) {
    const err = new Error(parsed.reason);
    err.code = 'CONFIG_INVALID';
    throw err;
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed.config, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
  return parsed.config;
}
