import test from 'node:test';
import assert from 'node:assert/strict';

import { createRunner } from '../src/core/funnel.js';
import { createGate } from '../src/core/gate.js';
import { defaultPolicy } from '../src/core/policy.js';
import { createGuardStore } from '../src/core/store.js';
import { createMemoryWatermark } from '../src/core/watermark.js';
import { createMemoryLock } from '../src/core/lock.js';

const SECRET = 'test-secret-at-least-sixteen-chars';

function buildRunner(overrides = {}) {
  const store = createGuardStore();
  const watermark = createMemoryWatermark();
  const lock = createMemoryLock();
  const rooms = [
    { rawId: 'group:1', authoritativeKind: 'group', name: '甲群' },
    { rawId: 'private:2', name: null },
  ];
  const data = {
    'group:1': [
      { seq: 1, time: 1, isSelf: false, nickname: 'a', text: '明天交周报' },
      { seq: 2, time: 2, isSelf: false, nickname: 'b', text: '收到' },
    ],
  };

  const runner = createRunner({
    gate: createGate({ secret: SECRET }),
    getPolicy: () => defaultPolicy(),
    listRooms: async () => rooms,
    fetchMessages: async ({ room, fromSeq }) => (data[room.rawId] ?? []).filter((m) => m.seq > fromSeq),
    summarize: async ({ messages }) => ({ summarizer: 'heuristic', overview: `共 ${messages.length} 条`, highlights: [], tasks: [], decisions: [], questions: [], participants: [] }),
    store,
    watermark,
    lock,
    ...overrides,
  });

  return { runner, store, watermark, lock };
}

test('trigger 非法即拒', async () => {
  const { runner } = buildRunner();
  assert.equal((await runner({})).reason, 'INVALID_TRIGGER');
  assert.equal((await runner({ trigger: 'cron' })).reason, 'INVALID_TRIGGER');
});

test('除 trigger 外多一个键就拒 —— 触发不能携带范围', async () => {
  const { runner } = buildRunner();
  const result = await runner({ trigger: 'manual', roomHandle: 'deadbeefdeadbeef' });
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.reason, 'SCOPE_PARAM_FORBIDDEN');
  assert.deepEqual(result.keys, ['roomHandle']);
});

test('私聊进入 denied，群产出摘要', async () => {
  const { runner } = buildRunner();
  const result = await runner({ trigger: 'manual' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summarized.length, 1);
  assert.equal(result.summarized[0].roomTitle, '甲群');
  assert.equal(result.denied.length, 1);
  assert.equal(result.denied[0].reason, 'PRIVATE_FORBIDDEN');
  assert.equal(JSON.stringify(result).includes('private:2'), false);
});

test('水位线生效：第二轮没有新消息就跳过，不产出空摘要', async () => {
  const { runner } = buildRunner();
  await runner({ trigger: 'manual' });
  const second = await runner({ trigger: 'manual' });
  assert.equal(second.summarized.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0].reason, 'NO_NEW_CONTENT');
});

test('互斥：运行中再次触发返回 ALREADY_RUNNING', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const { runner } = buildRunner({
    summarize: async () => {
      await gate;
      return { overview: '', highlights: [], tasks: [], decisions: [], questions: [], participants: [] };
    },
  });

  const first = runner({ trigger: 'manual' });
  // 让第一个 run 走到 summarize 之前
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = await runner({ trigger: 'manual' });
  assert.equal(second.status, 'ALREADY_RUNNING');
  release();
  const done = await first;
  assert.equal(done.status, 'COMPLETED');
});

test('单个群失败不拖垮整轮，失败如实上报', async () => {
  const { runner } = buildRunner({
    fetchMessages: async ({ room }) => {
      if (room.rawId === 'group:1') {
        const err = new Error('boom');
        err.code = 'ROOM_BOOM';
        throw err;
      }
      return [];
    },
  });
  const result = await runner({ trigger: 'manual' });
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].code, 'ROOM_BOOM');
  assert.equal(result.status, 'FAILED');
});
