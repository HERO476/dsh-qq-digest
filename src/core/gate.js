/**
 * 可见性闸门：全系统唯一的裁决点。
 *
 * 纯函数：无 I/O、无状态、无框架依赖。
 * 放行时返回不透明句柄 roomHandle（HMAC 前 16 位），原始会话标识到此为止不再向下传。
 *
 * 私聊不再是「无条件拒绝」，而是「按策略裁决」：
 *   - 策略默认 private.defaultEnabled = false → 拒绝
 *   - 只有配置里逐条显式打开的那一条才会放行
 *   - `private.defaultEnabled = true` 在策略解析阶段就被判非法（不允许一键全开）
 * 换句话说：私聊可以被读，但必须是「你一条一条点开的」。
 */

import { createHmac } from 'node:crypto';
import { canonicalize, KIND } from './canonical.js';
import { resolveSwitch } from './policy.js';

export const VERDICT = Object.freeze({ ALLOW: 'ALLOW', DENY: 'DENY' });

export const REASON = Object.freeze({
  INVALID_ID: 'INVALID_ID',
  TYPE_MISMATCH: 'TYPE_MISMATCH',
  EXCLUDED_CHANNEL: 'EXCLUDED_CHANNEL',
  PRIVATE_FORBIDDEN: 'PRIVATE_FORBIDDEN',
  UNKNOWN_CHANNEL: 'UNKNOWN_CHANNEL',
  GROUP_DISABLED: 'GROUP_DISABLED',
});

/** 读取句柄：拿到它意味着「当前策略放行这个房间」。 */
export function roomHandle(secret, canonicalId) {
  return createHmac('sha256', secret).update(`room:${canonicalId}`).digest('hex').slice(0, 16);
}

/**
 * 审计引用：与读取句柄**必须不同域**。
 *
 * 拒绝分支也要能回一个稳定的、可对账但不泄漏标识的引用；但如果直接复用 roomHandle，
 * 拒绝就等于把「读取凭据」发给了被拒绝的一方 —— 模型可以从 denied[] 里取到被拒绝房间的
 * 句柄，再去读该房间的历史摘要，撤销语义直接失效。
 * 因此审计引用走 `audit:` 域，它**不能**用来读任何东西。
 */
export function auditRefFor(secret, canonicalId) {
  return createHmac('sha256', secret).update(`audit:${canonicalId}`).digest('hex').slice(0, 16);
}

export function createGate({ secret }) {
  if (typeof secret !== 'string' || secret.length < 16) {
    throw new Error('GATE_SECRET_TOO_SHORT');
  }

  return function decide({ policy, rawId, authoritativeKind }) {
    const canon = canonicalize(rawId);
    if (!canon.ok) {
      return Object.freeze({
        verdict: VERDICT.DENY,
        reason: REASON.INVALID_ID,
        detail: canon.reason,
        auditRef: null,
      });
    }

    const { canonicalId, kind } = canon;
    // 审计引用与读取句柄分属两个 HMAC 域：拒绝时只发放 auditRef，它读不了任何东西。
    const auditRef = auditRefFor(secret, canonicalId);

    // 交叉校验：声明形态必须与数据源给出的权威类型一致，不一致即拒。
    if (authoritativeKind !== undefined && authoritativeKind !== null && authoritativeKind !== kind) {
      return deny(auditRef, REASON.TYPE_MISMATCH, `${kind} != ${authoritativeKind}`);
    }

    if (kind === KIND.EXCLUDED) return deny(auditRef, REASON.EXCLUDED_CHANNEL, 'excluded channel');
    if (kind === KIND.UNKNOWN) return deny(auditRef, REASON.UNKNOWN_CHANNEL, 'unclassified id');

    const sw = resolveSwitch(policy, kind, canonicalId);
    if (!sw.enabled) {
      const reason = kind === KIND.GROUP ? REASON.GROUP_DISABLED : REASON.PRIVATE_FORBIDDEN;
      return deny(auditRef, reason, sw.source);
    }

    // 只回句柄。规范 id（canonicalId）也不外传 —— 它仍是「原始标识的规范化形式」，
    // 外传就等于把群号/QQ 号泄给了下游。下游要用它做键的地方（水位线）一律改用句柄。
    return Object.freeze({
      verdict: VERDICT.ALLOW,
      kind,
      roomHandle: roomHandle(secret, canonicalId),
      auditRef,
    });
  };
}

function deny(auditRef, reason, detail) {
  return Object.freeze({ verdict: VERDICT.DENY, reason, detail: detail ?? null, auditRef });
}
