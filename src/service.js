/**
 * 服务层：把适配器、策略、闸门、单漏斗、存储装配起来，对外只暴露四个动作。
 *
 * 对外接口刻意很小：
 *   listRooms()              列出策略允许的群（只给不透明句柄，不给群号）
 *   runSummary({trigger})    跑一次总结
 *   getDigest(roomHandle?)   按句柄读摘要
 *   status()                 看状态
 *
 * 注意：这里没有、也不会有任何「发送」「回复」「转发」方法。
 */

import { createGate } from './core/gate.js';
import { defaultPolicy, parsePolicy, failClosedPolicy } from './core/policy.js';
import { createRunner } from './core/funnel.js';
import { createGuardStore } from './core/store.js';
import { createMemoryWatermark } from './core/watermark.js';
import { createMemoryLock } from './core/lock.js';
import { summarizeMessages } from './summarize.js';

/**
 * @param {{
 *   adapter: {listRooms:Function, fetchMessages:Function, stateless?:boolean, name?:string},
 *   secret: string,
 *   policy?: object,
 *   getPolicy?: Function,
 *   summarize?: Function,
 *   store?: object,
 *   watermark?: object,
 * }} options
 */
export function createService(options = {}) {
  const {
    adapter,
    secret,
    policy: rawPolicy,
    summarize = summarizeMessages,
    store: injectedStore,
    watermark: injectedWatermark,
    getPolicy: externalPolicyProvider,
    // 桥接不提供群名，允许外部按 rawId 补一个显示名（只用于展示，不参与裁决）。
    titleProvider = null,
  } = options;

  if (!adapter) throw new Error('SERVICE_MISSING_ADAPTER');
  if (typeof secret !== 'string' || secret.length < 16) throw new Error('SERVICE_SECRET_TOO_SHORT');

  // 策略解析失败 → 全关。不是回退默认值。
  const parsed = rawPolicy === undefined ? { ok: true, policy: defaultPolicy() } : parsePolicy(rawPolicy);
  let currentPolicy = parsed.ok ? parsed.policy : failClosedPolicy(parsed.reason);
  let policyError = parsed.ok ? null : parsed.reason;

  function resolvePolicy() {
    if (typeof externalPolicyProvider !== 'function') return currentPolicy;
    try {
      const next = externalPolicyProvider();
      if (!next || typeof next !== 'object') throw new Error('POLICY_PROVIDER_BAD_RETURN');
      currentPolicy = next;
      policyError = next.degraded === true ? String(next.degradedReason ?? 'POLICY_DEGRADED') : null;
      return currentPolicy;
    } catch (err) {
      currentPolicy = failClosedPolicy(String(err?.message ?? err));
      policyError = currentPolicy.degradedReason;
      return currentPolicy;
    }
  }

  const gate = createGate({ secret });
  const store = injectedStore ?? createGuardStore();
  const lock = createMemoryLock();

  // stateless 适配器（如 SnowLuma 历史窗口）每轮全量重算，因此不走增量水位线；
  // 否则第二轮会把整份窗口当成「已经摘要过」而全部跳过。
  const baseWatermark = injectedWatermark ?? createMemoryWatermark();
  const watermark = adapter.stateless ? { get: () => 0, set: () => {}, keys: () => [] } : baseWatermark;

  /** 数据源不给名字时用配置里的名字补上（群和私聊都适用）。 */
  function titledRoom(room) {
    if (room?.name) return room;
    const fallback = typeof titleProvider === 'function' ? safeTitle(titleProvider, room?.rawId) : null;
    return fallback ? { ...room, name: fallback } : room;
  }

  const runner = createRunner({
    gate,
    getPolicy: resolvePolicy,
    listRooms: async () => (await adapter.listRooms()).map(titledRoom),
    fetchMessages,
    summarize,
    store,
    watermark,
    lock,
  });

  let lastRun = null;

  async function fetchMessages({ room, fromSeq }) {
    return adapter.fetchMessages({ room, fromSeq });
  }

  async function listRooms() {
    const policy = resolvePolicy();
    const rooms = await adapter.listRooms();
    const allowed = [];
    const denied = [];

    for (const room of rooms) {
      const decision = gate({ policy, rawId: room.rawId, authoritativeKind: room.authoritativeKind });
      if (decision.verdict === 'ALLOW') {
        allowed.push({
          roomHandle: decision.roomHandle,
          roomTitle: titledRoom(room).name ?? null,
          kind: decision.kind,
        });
      } else {
        denied.push({ auditRef: decision.auditRef, reason: decision.reason });
      }
    }

    return {
      source: adapter.name ?? 'unknown',
      policyDegraded: Boolean(policy?.degraded),
      policyError,
      allowed,
      deniedCount: denied.length,
      deniedReasons: countReasons(denied),
    };
  }

  async function runSummary(request) {
    const result = await runner(request);
    lastRun = {
      at: new Date().toISOString(),
      status: result.status,
      trigger: result.trigger ?? null,
      summarized: Array.isArray(result.summarized) ? result.summarized.length : 0,
      skipped: Array.isArray(result.skipped) ? result.skipped.length : 0,
      denied: Array.isArray(result.denied) ? result.denied.length : 0,
      errors: Array.isArray(result.errors) ? result.errors.length : 0,
    };
    return result;
  }

  function getDigest(handle) {
    if (handle !== undefined && handle !== null && handle !== '') {
      if (typeof handle !== 'string' || !/^[0-9a-f]{16}$/.test(handle)) {
        return { status: 'REJECTED', reason: 'INVALID_HANDLE' };
      }
      const entry = store.latest(handle);
      return entry ? { status: 'OK', entry } : { status: 'NOT_FOUND' };
    }

    const rows = typeof store.latestPerRoom === 'function' ? store.latestPerRoom() : dedupeLatest(store.all());
    return { status: 'OK', count: rows.length, items: rows };
  }

  async function status() {
    let roomCount = null;
    let adapterError = null;
    try {
      const rooms = await listRooms();
      roomCount = rooms.allowed.length;
    } catch (err) {
      adapterError = { code: err?.code ?? 'ADAPTER_ERROR', message: String(err?.message ?? err) };
    }

    return {
      source: adapter.name ?? 'unknown',
      stateless: Boolean(adapter.stateless),
      policyDegraded: Boolean(currentPolicy?.degraded),
      policyError,
      roomCount,
      adapterError,
      digestCount: store.all().length,
      lastRun,
      // 句柄密钥只报「是否设置」，绝不报值。
      secretConfigured: typeof secret === 'string' && secret.length >= 16,
    };
  }

  return {
    adapterName: adapter.name ?? 'unknown',
    listRooms,
    runSummary,
    getDigest,
    status,
    get policy() {
      return currentPolicy;
    },
    get policyError() {
      return policyError;
    },
    store,
  };
}

function safeTitle(provider, rawId) {
  try {
    const value = provider(rawId);
    return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 60) : null;
  } catch {
    return null;
  }
}

function countReasons(denied) {
  const counts = {};
  for (const item of denied) counts[item.reason] = (counts[item.reason] ?? 0) + 1;
  return counts;
}

function dedupeLatest(entries) {
  const map = new Map();
  for (const entry of entries) map.set(entry.roomHandle, entry);
  return [...map.values()];
}
