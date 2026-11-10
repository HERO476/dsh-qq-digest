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
    // 密钥来源：env | generated | file | unknown。只用于如实上报，绝不外传值。
    secretSource = 'unknown',
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
    return readDigest(handle);
  }

  /**
   * 读取已落盘摘要。
   *
   * 关键约束：**读取也必须过闸门**。
   * 句柄是不透明令牌，但它只证明「签发时策略放行过这个房间」，不证明「现在仍然放行」。
   * 因此每次读取都先按当前策略对数据源现算一遍允许集，再与存储求交 ——
   * 关掉某个群 / 关掉总开关之后，历史摘要立即读不到（撤销语义成立）。
   *
   * 数据源不可用时不允许「先读再说」：无法确认当前允许谁，就一律拒绝。
   */
  async function readDigest(handle) {
    const hasHandle = handle !== undefined && handle !== null && handle !== '';
    if (hasHandle && (typeof handle !== 'string' || !/^[0-9a-f]{16}$/.test(handle))) {
      return { status: 'REJECTED', reason: 'INVALID_HANDLE' };
    }

    const allowed = await currentAllowedHandles();
    if (!allowed.ok) {
      return {
        status: 'DENIED',
        reason: 'SOURCE_UNAVAILABLE',
        detail: allowed.error?.code ?? null,
      };
    }

    if (hasHandle) {
      // 不在允许集里，与「没有摘要」返回同一个结果：不告诉调用方它是否存在。
      if (!allowed.handles.has(handle)) return { status: 'NOT_FOUND' };
      const entry = store.latest(handle);
      return entry ? { status: 'OK', entry } : { status: 'NOT_FOUND' };
    }

    const rows = typeof store.latestPerRoom === 'function' ? store.latestPerRoom() : dedupeLatest(store.all());
    const visible = rows.filter((row) => allowed.handles.has(row.roomHandle));
    return { status: 'OK', count: visible.length, items: visible };
  }

  /** 按当前策略现算「此刻允许读」的句柄集合。数据源失败时返回 ok:false。 */
  async function currentAllowedHandles() {
    const policy = resolvePolicy();
    let rooms;
    try {
      rooms = await adapter.listRooms();
    } catch (err) {
      return { ok: false, error: { code: err?.code ?? 'ADAPTER_ERROR', message: String(err?.message ?? err) } };
    }

    const handles = new Set();
    for (const room of rooms) {
      const decision = gate({ policy, rawId: room.rawId, authoritativeKind: room.authoritativeKind });
      if (decision.verdict === 'ALLOW') handles.add(decision.roomHandle);
    }
    return { ok: true, handles, policy };
  }

  async function status() {
    let roomCount = null;
    let adapterError = null;
    // 落盘总量里有多少条「按当前策略 + 当前密钥」真的读得到。
    // 两个数差得很大通常只有两种原因：策略关掉了这些房间，或者换了句柄密钥
    // （旧摘要的 roomHandle 是用旧密钥算的，永远匹配不上）。后者必须让人看见，
    // 否则表现为「升级之后摘要凭空消失」。
    let visibleDigestCount = null;
    try {
      const rooms = await listRooms();
      roomCount = rooms.allowed.length;
      const handles = new Set(rooms.allowed.map((room) => room.roomHandle));
      const rows = typeof store.latestPerRoom === 'function' ? store.latestPerRoom() : dedupeLatest(store.all());
      visibleDigestCount = rows.filter((row) => handles.has(row.roomHandle)).length;
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
      visibleDigestCount,
      lastRun,
      // 句柄密钥只报「是否设置」与「来源」，绝不报值。
      // 注意：源码里不再有默认常量，因此 secretConfigured 不会再出现「恒真」的假保证。
      secretConfigured: typeof secret === 'string' && secret.length >= 16 && secretSource !== 'default',
      secretSource,
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
