/**
 * 策略：谁可以被读。
 *
 * 现在的形状（2026-11 按用户要求调整过一次，别再照旧记忆写）：
 *   group   ：默认全开，可单群关
 *   private ：默认全关，只能单条显式打开
 *
 * 三条硬规矩：
 *  1) 字段白名单。出现任何未知字段 → 整份策略作废（不是忽略）。
 *  2) 键名里带 send/reply/scope/... 的，按名字直接拒，防止悄悄长出开关。
 *  3) 策略损坏 → 全关（fail-closed），不是回退默认值。
 *
 * 关于私聊：它不再是「结构上不存在」，而是「默认关 + 必须单条打开」。
 * `private.defaultEnabled = true`（一键放开所有私聊）仍然被**直接拒绝**，
 * 因为那等于把「逐条确认」这层保护整个拿掉。
 */

import { canonicalize, KIND } from './canonical.js';

export const POLICY_VERSION = 1;

const ALLOWED_TOP_KEYS = new Set(['version', 'group', 'private']);
const ALLOWED_SCOPE_KEYS = new Set(['defaultEnabled', 'overrides']);
const ALLOWED_OVERRIDE_KEYS = new Set(['enabled']);

const FORBIDDEN_KEY_HINT =
  /friend|c2c|uin|send|reply|post|forward|comment|broadcast|poke|allowall|allowprivate|scope|write|exec|shell|whitelist|override_all/i;

export function defaultPolicy() {
  return {
    version: POLICY_VERSION,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: {} },
  };
}

/** 策略损坏时的兜底：群与私聊全部关闭（fail-closed）。 */
export function failClosedPolicy(reason = 'POLICY_INVALID') {
  return {
    version: POLICY_VERSION,
    group: { defaultEnabled: false, overrides: {} },
    private: { defaultEnabled: false, overrides: {} },
    degraded: true,
    degradedReason: reason,
  };
}

/**
 * @param {unknown} raw
 * @returns {{ok:true, policy:object} | {ok:false, reason:string}}
 */
export function parsePolicy(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'NOT_OBJECT' };
  }

  for (const key of Object.keys(raw)) {
    if (ALLOWED_TOP_KEYS.has(key)) continue;
    if (FORBIDDEN_KEY_HINT.test(key)) return { ok: false, reason: `FORBIDDEN_KEY:${key}` };
    return { ok: false, reason: `UNKNOWN_KEY:${key}` };
  }

  if (raw.version !== POLICY_VERSION) return { ok: false, reason: `BAD_VERSION:${String(raw.version)}` };

  const group = parseScope(raw.group, 'GROUP', KIND.GROUP);
  if (!group.ok) return group;

  const priv = parseScope(raw.private ?? defaultPolicy().private, 'PRIVATE', KIND.PRIVATE);
  if (!priv.ok) return priv;

  // 一键放开所有私聊 = 把「逐条确认」这层保护整个拿掉，直接判策略非法。
  if (priv.scope.defaultEnabled !== false) {
    return { ok: false, reason: 'PRIVATE_DEFAULT_MUST_BE_FALSE' };
  }

  return {
    ok: true,
    policy: {
      version: POLICY_VERSION,
      group: group.scope,
      private: priv.scope,
    },
  };
}

function parseScope(rawScope, label, expectedKind) {
  const reject = (reason) => ({ ok: false, reason: `${label}_${reason}` });

  if (rawScope === null || typeof rawScope !== 'object' || Array.isArray(rawScope)) {
    return reject('NOT_OBJECT');
  }

  for (const key of Object.keys(rawScope)) {
    if (ALLOWED_SCOPE_KEYS.has(key)) continue;
    if (FORBIDDEN_KEY_HINT.test(key)) return reject(`FORBIDDEN_KEY:${key}`);
    return reject(`UNKNOWN_KEY:${key}`);
  }

  if (typeof rawScope.defaultEnabled !== 'boolean') return reject('DEFAULT_NOT_BOOLEAN');

  const rawOverrides = rawScope.overrides ?? {};
  if (rawOverrides === null || typeof rawOverrides !== 'object' || Array.isArray(rawOverrides)) {
    return reject('OVERRIDES_NOT_OBJECT');
  }

  const overrides = {};
  for (const [id, value] of Object.entries(rawOverrides)) {
    const canon = canonicalize(id);
    if (!canon.ok) return reject(`OVERRIDE_BAD_ID:${canon.reason}`);
    if (canon.kind !== expectedKind) return reject(`OVERRIDE_NOT_${label}:${canon.kind}`);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return reject('OVERRIDE_NOT_OBJECT');
    }
    for (const key of Object.keys(value)) {
      if (ALLOWED_OVERRIDE_KEYS.has(key)) continue;
      if (FORBIDDEN_KEY_HINT.test(key)) return reject(`OVERRIDE_FORBIDDEN_KEY:${key}`);
      return reject(`OVERRIDE_UNKNOWN_KEY:${key}`);
    }
    if (typeof value.enabled !== 'boolean') return reject('OVERRIDE_NOT_BOOLEAN');
    overrides[canon.canonicalId] = { enabled: value.enabled };
  }

  return { ok: true, scope: { defaultEnabled: rawScope.defaultEnabled, overrides } };
}

/**
 * 单条覆盖优先于全局默认。非群非私聊一律不准。
 * @returns {{enabled:boolean, source:'override'|'default'|'not-scoped'}}
 */
export function resolveSwitch(policy, kind, canonicalId) {
  const scope = kind === KIND.GROUP ? policy?.group : kind === KIND.PRIVATE ? policy?.private : undefined;
  if (!scope) return { enabled: false, source: 'not-scoped' };
  const override = scope.overrides?.[canonicalId];
  if (override) return { enabled: override.enabled, source: 'override' };
  return { enabled: Boolean(scope.defaultEnabled), source: 'default' };
}
