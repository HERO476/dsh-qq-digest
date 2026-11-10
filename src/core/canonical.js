/**
 * 会话标识归一化与分类：全系统唯一的解析点。
 *
 * 铁律：原始会话标识只在这里解析一次。下游（闸门 / 漏斗 / 存储 / 日志）
 * 一律不得再对原始串做 split / endsWith / 正则判断，只能使用本函数返回的
 * { canonicalId, kind }。这样同一个会话不可能得到两种裁决。
 *
 * QQ 的标识空间和微信不同，因此规则重写（不是照抄）：
 *   group:<数字>      → 群聊（唯一可读形态）
 *   private:/user:/   → 私聊（读 = 结构上禁止，见 gate.js）
 *   channel:/guild:   → 频道等非本插件目标，显式排除
 *   裸数字             → UNKNOWN（绝不猜成群）
 *
 * 「裸数字一律 UNKNOWN」是刻意的：QQ 号与群号是两个编号空间但在数值上有重叠，
 * 任何把裸数字当群的推断都可能把一个私聊 ID 读成群。适配器必须自己补 `group:`
 * 前缀，补错前缀的责任落在适配器，而不是靠这里的猜测兜底。
 */

export const KIND = Object.freeze({
  GROUP: 'group',
  PRIVATE: 'private',
  EXCLUDED: 'excluded',
  UNKNOWN: 'unknown',
});

/** 群聊唯一认可的形态：group:<纯数字>。 */
const GROUP_ID_RE = /^group:(\d{1,20})$/;

/** 私聊形态。命中即 PRIVATE —— 由闸门无条件拒绝，不看任何配置。 */
const PRIVATE_PREFIXES = ['private:', 'user:', 'friend:', 'c2c:', 'temp:', 'stranger:', 'uin:'];

/** 既不是群也不是人：频道、子频道、讨论组、系统会话。 */
const EXCLUDED_PREFIXES = ['channel:', 'guild:', 'guildchannel:', 'xiaoqin:', 'discuss:', 'system:', 'service:', 'group_notice:', 'friend_notice:'];

const MAX_ID_LENGTH = 64;
const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/;

/**
 * @param {unknown} rawId
 * @returns {{ok:true, canonicalId:string, kind:string, groupId?:string} | {ok:false, reason:string}}
 */
export function canonicalize(rawId) {
  if (typeof rawId !== 'string') return { ok: false, reason: 'NOT_STRING' };

  const trimmed = rawId.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'EMPTY' };
  if (trimmed.length > MAX_ID_LENGTH) return { ok: false, reason: 'TOO_LONG' };
  if (CONTROL_OR_INVISIBLE.test(trimmed)) return { ok: false, reason: 'CONTROL_OR_INVISIBLE' };

  const lower = trimmed.toLowerCase();

  const groupMatch = GROUP_ID_RE.exec(lower);
  if (groupMatch) {
    // 去前导零：group:00123 与 group:123 是同一个群，必须归一到同一个 canonicalId，
    // 否则策略覆盖会漏、水位线会分叉。
    const digits = normalizeDigits(groupMatch[1]);
    if (!digits) return { ok: false, reason: 'BAD_GROUP_ID' };
    return { ok: true, canonicalId: `group:${digits}`, kind: KIND.GROUP, groupId: digits };
  }

  for (const prefix of PRIVATE_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { ok: true, canonicalId: lower, kind: KIND.PRIVATE };
    }
  }

  for (const prefix of EXCLUDED_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { ok: true, canonicalId: lower, kind: KIND.EXCLUDED };
    }
  }

  // 裸数字、纯字母、其它一切：不猜，交给闸门 fail-closed。
  return { ok: true, canonicalId: lower, kind: KIND.UNKNOWN };
}

/**
 * 把数字串归一化为无前导零的十进制串。
 * 用 BigInt 而不是 Number：Number 在超过 2^53 时会静默丢精度，
 * 那会让两个不同的群得到同一个 canonicalId —— 这正是最不该发生的事。
 * @returns {string|null} 非法或零值时返回 null
 */
function normalizeDigits(raw) {
  try {
    const value = BigInt(raw);
    if (value <= 0n) return null;
    return value.toString();
  } catch {
    return null;
  }
}

/** 便捷判断：这个原始标识是不是一个可读的群。 */
export function isGroupId(rawId) {
  const result = canonicalize(rawId);
  return result.ok && result.kind === KIND.GROUP;
}
