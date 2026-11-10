/**
 * 单漏斗：定时触发与手动触发汇入同一个函数、同一道闸门。
 *
 * 两条铁律：
 *  1) trigger 只有两个合法取值；
 *  2) 入参除 trigger 外多一个键就拒绝 —— 触发只决定「何时跑」，
 *     永远不携带范围，因此「手动触发」不可能变成绕过策略的旁路。
 *
 * 换言之：想改「能看哪些群」，只能改策略文件；没有任何一次工具调用能改范围。
 */

import { VERDICT } from './gate.js';

export const TRIGGERS = Object.freeze(['scheduled', 'manual']);

const REQUIRED_DEPS = ['gate', 'getPolicy', 'listRooms', 'fetchMessages', 'summarize', 'store', 'watermark', 'lock'];

export function createRunner(deps = {}) {
  for (const name of REQUIRED_DEPS) {
    if (!deps[name]) throw new Error(`RUNNER_MISSING_DEP:${name}`);
  }

  const {
    gate,
    getPolicy,
    listRooms,
    fetchMessages,
    summarize,
    store,
    watermark,
    lock,
    now = () => new Date().toISOString(),
    maxRooms = 200,
    maxMessagesPerRoom = 200,
  } = deps;

  return async function runSummary(request = {}) {
    const trigger = request?.trigger;
    if (!TRIGGERS.includes(trigger)) {
      return { status: 'REJECTED', reason: 'INVALID_TRIGGER' };
    }

    const extraKeys = Object.keys(request ?? {}).filter((key) => key !== 'trigger');
    if (extraKeys.length > 0) {
      return { status: 'REJECTED', reason: 'SCOPE_PARAM_FORBIDDEN', keys: extraKeys };
    }

    const lease = lock.tryAcquire(trigger);
    if (!lease.ok) return { status: 'ALREADY_RUNNING', jobId: lease.jobId };

    const jobId = lease.jobId;
    const denied = [];
    const summarized = [];
    const skipped = [];
    const errors = [];

    try {
      const policy = getPolicy();
      const rooms = await listRooms();
      const allowed = [];

      for (const room of rooms.slice(0, maxRooms)) {
        const decision = gate({
          policy,
          rawId: room.rawId,
          authoritativeKind: room.authoritativeKind,
        });

        if (decision.verdict === VERDICT.ALLOW) {
          allowed.push({
            // 水位线的键也用句柄：规范 id 不出闸门，下游就不存在「原始标识」这条数据。
            roomHandle: decision.roomHandle,
            room,
          });
        } else {
          denied.push({ auditRef: decision.auditRef, reason: decision.reason, detail: decision.detail ?? null });
        }
      }

      // 存储层二次拒绝的允许集：只有本次放行的句柄才写得进去。
      store.bindAllowed(allowed.map((item) => item.roomHandle));

      for (const item of allowed) {
        try {
          const fromSeq = watermark.get(item.roomHandle);
          const fetched = await fetchMessages({
            room: item.room,
            roomHandle: item.roomHandle,
            fromSeq,
          });

          const messages = Array.isArray(fetched) ? fetched.slice(-maxMessagesPerRoom) : [];

          if (messages.length === 0) {
            skipped.push({ roomHandle: item.roomHandle, reason: 'NO_NEW_CONTENT' });
            continue;
          }

          const seqFrom = messages[0].seq;
          const seqTo = messages[messages.length - 1].seq;

          const digest = await summarize({
            roomHandle: item.roomHandle,
            roomTitle: item.room.name ?? null,
            messages,
          });

          store.put({
            roomHandle: item.roomHandle,
            roomTitle: item.room.name ?? null,
            digest,
            provenance: { seqFrom, seqTo, messageCount: messages.length },
            trigger,
            createdAt: now(),
          });

          watermark.set(item.roomHandle, seqTo);
          summarized.push({
            roomHandle: item.roomHandle,
            roomTitle: item.room.name ?? null,
            seqFrom,
            seqTo,
            messageCount: messages.length,
            highlights: Array.isArray(digest?.highlights) ? digest.highlights.length : 0,
            tasks: Array.isArray(digest?.tasks) ? digest.tasks.length : 0,
          });
        } catch (err) {
          // 单个群失败不拖垮整轮：其余群照常产出，失败如实上报。
          errors.push({
            roomHandle: item.roomHandle,
            code: err?.code ?? 'ROOM_FAILED',
            message: String(err?.message ?? err),
          });
        }
      }

      return {
        status: errors.length > 0 && summarized.length === 0 ? 'FAILED' : 'COMPLETED',
        jobId,
        trigger,
        summarized,
        skipped,
        denied,
        errors,
      };
    } catch (err) {
      return {
        status: 'FAILED',
        jobId,
        trigger,
        code: err?.code ?? 'INTERNAL_ERROR',
        message: String(err?.message ?? err),
      };
    } finally {
      store.bindAllowed([]);
      lock.release();
    }
  };
}
