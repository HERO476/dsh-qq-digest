import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuardStore, RECORD_FIELDS } from '../src/core/store.js';

test('未绑定的句柄写不进去（存储层二次拒绝）', () => {
  const store = createGuardStore();
  assert.throws(
    () => store.put({ roomHandle: 'aaaaaaaaaaaaaaaa', digest: {}, provenance: { seqFrom: 1, seqTo: 2 }, trigger: 'manual' }),
    /STORE_SCOPE_DENIED/,
  );
});

test('缺 provenance 不写', () => {
  const store = createGuardStore();
  store.bindAllowed(['aaaaaaaaaaaaaaaa']);
  assert.throws(
    () => store.put({ roomHandle: 'aaaaaaaaaaaaaaaa', digest: {}, trigger: 'manual' }),
    /STORE_PROVENANCE_REQUIRED/,
  );
});

test('只存白名单字段：多塞的 text / rawId 被丢弃', () => {
  const store = createGuardStore();
  store.bindAllowed(['aaaaaaaaaaaaaaaa']);
  const stored = store.put({
    roomHandle: 'aaaaaaaaaaaaaaaa',
    roomTitle: '甲群',
    digest: { overview: 'ok' },
    provenance: { seqFrom: 1, seqTo: 9, messageCount: 4 },
    trigger: 'manual',
    createdAt: '2026-11-10T00:00:00.000Z',
    text: '不该被存下来的聊天原文',
    rawId: 'group:123',
  });

  assert.deepEqual(Object.keys(stored).sort(), [...RECORD_FIELDS].sort());
  assert.equal(JSON.stringify(stored).includes('不该被存下来的聊天原文'), false);
  assert.equal(JSON.stringify(stored).includes('group:123'), false);
});

test('latest 取同一句柄最近一篇', () => {
  const store = createGuardStore();
  store.bindAllowed(['aaaaaaaaaaaaaaaa']);
  store.put({ roomHandle: 'aaaaaaaaaaaaaaaa', digest: { overview: 'first' }, provenance: { seqFrom: 1, seqTo: 2 }, trigger: 'manual' });
  store.put({ roomHandle: 'aaaaaaaaaaaaaaaa', digest: { overview: 'second' }, provenance: { seqFrom: 3, seqTo: 4 }, trigger: 'manual' });
  assert.equal(store.latest('aaaaaaaaaaaaaaaa').digest.overview, 'second');
});
