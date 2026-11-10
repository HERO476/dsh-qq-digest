/**
 * 摘要存储层（内存实现，测试与无落盘场景用）。
 *
 * 三层自我保护：
 *  1) 只接受本次运行中被闸门放行的 roomHandle —— 二次拒绝，不依赖调用方自觉；
 *  2) 缺 provenance 一律不写 —— 保证每条要点都能回溯到来源群与消息范围；
 *  3) 只存摘要与溯源定位，永不存聊天原文、永不存原始会话 id。
 *     写入是**白名单重建**（从 record 里逐字段挑），不是「过滤掉敏感字段」——
 *     后者漏一个字段就泄漏，前者多一个字段就自动丢弃。
 */

/** 摘要记录允许落盘的字段。改这个集合等于改安全边界，必须同步改测试。 */
export const RECORD_FIELDS = Object.freeze(['roomHandle', 'roomTitle', 'digest', 'provenance', 'trigger', 'createdAt']);

export function createGuardStore() {
  const entries = [];
  let allowed = new Set();

  return {
    bindAllowed(handles) {
      allowed = new Set(Array.isArray(handles) ? handles : []);
    },
    /** @param {object} record */
    put(record) {
      if (!record || typeof record !== 'object') throw fail('STORE_BAD_RECORD');
      if (!allowed.has(record.roomHandle)) throw fail('STORE_SCOPE_DENIED');

      const p = record.provenance;
      if (!p || typeof p.seqFrom !== 'number' || typeof p.seqTo !== 'number') {
        throw fail('STORE_PROVENANCE_REQUIRED');
      }

      const stored = Object.freeze({
        roomHandle: record.roomHandle,
        roomTitle: typeof record.roomTitle === 'string' ? record.roomTitle : null,
        digest: record.digest,
        provenance: Object.freeze({
          roomHandle: record.roomHandle,
          seqFrom: p.seqFrom,
          seqTo: p.seqTo,
          ...(typeof p.messageCount === 'number' ? { messageCount: p.messageCount } : {}),
        }),
        trigger: record.trigger,
        createdAt: record.createdAt ?? null,
      });

      entries.push(stored);
      return stored;
    },
    all() {
      return entries.slice();
    },
    latest(roomHandle) {
      const rows = entries.filter((entry) => entry.roomHandle === roomHandle);
      return rows.length > 0 ? rows[rows.length - 1] : null;
    },
    dump() {
      return JSON.stringify(entries);
    },
  };
}

export function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}
