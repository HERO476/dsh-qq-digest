import test from 'node:test';
import assert from 'node:assert/strict';

import { createService } from '../src/service.js';
import { createFixtureAdapter, DEFAULT_FIXTURE } from '../src/adapters/fixture.js';
import { summarizeMessages } from '../src/summarize.js';
import { defaultPolicy } from '../src/core/policy.js';
import { roomHandle } from '../src/core/gate.js';

const SECRET = 'revocation-secret-sixteen-plus';

const OPEN = {
  version: 1,
  group: { defaultEnabled: true, overrides: {} },
  private: { defaultEnabled: false, overrides: {} },
};

const ALL_CLOSED = {
  version: 1,
  group: { defaultEnabled: false, overrides: {} },
  private: { defaultEnabled: false, overrides: {} },
};

/** 策略可变的 service：用于验证「改了策略之后，读取是否立即生效」。 */
function buildService(initialPolicy) {
  let policy = initialPolicy;
  const service = createService({
    adapter: createFixtureAdapter(DEFAULT_FIXTURE),
    secret: SECRET,
    summarize: summarizeMessages,
    getPolicy: () => policy,
  });
  return { service, setPolicy: (next) => { policy = next; } };
}

test('撤销生效：关掉群聊总开关后，历史摘要立刻读不到（单句柄与全量都算）', async () => {
  const { service, setPolicy } = buildService(OPEN);

  const run = await service.runSummary({ trigger: 'manual' });
  assert.equal(run.status, 'COMPLETED');
  assert.equal(run.summarized.length, 2);

  const handle = run.summarized[0].roomHandle;
  const before = await service.getDigest(handle);
  assert.equal(before.status, 'OK', '撤销之前应该读得到');

  const beforeAll = await service.getDigest();
  assert.equal(beforeAll.count, 2);

  // 关掉总开关（等价于用户在设置页关掉「群聊读取」）
  setPolicy(ALL_CLOSED);

  const afterAll = await service.getDigest();
  assert.equal(afterAll.status, 'OK');
  assert.equal(afterAll.count, 0, '关掉之后全量读取必须为空');

  const afterOne = await service.getDigest(handle);
  // 用 NOT_FOUND 而不是 DENIED：不告诉调用方「这个句柄存在过」
  assert.equal(afterOne.status, 'NOT_FOUND', '关掉之后按句柄也读不到');
});

test('撤销生效：只关掉一个群时，另一个群的摘要仍然读得到（撤销是精确的，不是一刀切）', async () => {
  const { service, setPolicy } = buildService(OPEN);
  const run = await service.runSummary({ trigger: 'manual' });
  assert.equal(run.summarized.length, 2);

  // 句柄不可逆，但密钥与 fixture 的固定 id 都在测试里，可以直接算出目标句柄
  const closedHandle = roomHandle(SECRET, 'group:100000');
  const keptHandle = roomHandle(SECRET, 'group:70001111');
  assert.ok(run.summarized.some((item) => item.roomHandle === closedHandle));

  setPolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: { 'group:100000': { enabled: false } } },
    private: { defaultEnabled: false, overrides: {} },
  });

  assert.equal((await service.getDigest(closedHandle)).status, 'NOT_FOUND', '被关掉的群读不到');
  assert.equal((await service.getDigest(keptHandle)).status, 'OK', '没关的群照常读得到');

  const all = await service.getDigest();
  assert.equal(all.count, 1);
  assert.equal(all.items[0].roomHandle, keptHandle);
});

test('拒绝列表里拿到的 auditRef 不能用来读摘要（拒绝≠发凭据）', async () => {
  const { service } = buildService(ALL_CLOSED);
  const run = await service.runSummary({ trigger: 'manual' });

  assert.ok(run.denied.length > 0, '全关时应该有被拒绝的会话');
  const auditRef = run.denied[0].auditRef;
  assert.match(auditRef, /^[0-9a-f]{16}$/);

  // 把拒绝列表里的引用当句柄去读：必须读不到
  const attempt = await service.getDigest(auditRef);
  assert.equal(attempt.status, 'NOT_FOUND');

  // 反向：真实句柄不等于 auditRef（两个 HMAC 域）
  const realHandle = roomHandle(SECRET, 'group:100000');
  assert.notEqual(auditRef, realHandle);
});

test('数据源不可用时读取 fail-closed，不会「先读再说」', async () => {
  const brokenAdapter = {
    name: 'broken',
    async listRooms() {
      const err = new Error('bridge down');
      err.code = 'ECONNREFUSED';
      throw err;
    },
    async fetchMessages() {
      return [];
    },
  };

  const service = createService({
    adapter: brokenAdapter,
    secret: SECRET,
    summarize: summarizeMessages,
    getPolicy: () => OPEN,
  });

  const out = await service.getDigest('0123456789abcdef');
  assert.equal(out.status, 'DENIED');
  assert.equal(out.reason, 'SOURCE_UNAVAILABLE');
});

test('句柄格式非法仍然先被拒（不会去问数据源）', async () => {
  let listed = 0;
  const adapter = {
    name: 'counting',
    async listRooms() {
      listed += 1;
      return [];
    },
    async fetchMessages() {
      return [];
    },
  };
  const service = createService({
    adapter,
    secret: SECRET,
    summarize: summarizeMessages,
    getPolicy: () => OPEN,
  });

  assert.equal((await service.getDigest('nope')).status, 'REJECTED');
  assert.equal(listed, 0, '格式非法时不该触发一次数据源调用');
});

test('status 如实区分「落盘总量」与「当前读得到的量」（换密钥/关策略都要看得出来）', async () => {
  const { service, setPolicy } = buildService(OPEN);

  const empty = await service.status();
  assert.equal(empty.digestCount, 0);
  assert.equal(empty.visibleDigestCount, 0);

  await service.runSummary({ trigger: 'manual' });

  const full = await service.status();
  assert.equal(full.digestCount, 2);
  assert.equal(full.visibleDigestCount, 2);

  // 关掉之后：数据还在盘上，但一条也读不到 —— 两个数的差就是这件事的可观测形式
  setPolicy(ALL_CLOSED);
  const closed = await service.status();
  assert.equal(closed.digestCount, 2);
  assert.equal(closed.visibleDigestCount, 0);
  assert.equal(closed.secretSource, 'unknown');
});
