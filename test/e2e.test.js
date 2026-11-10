import test from 'node:test';
import assert from 'node:assert/strict';

import { createService } from '../src/service.js';
import { createFixtureAdapter, DEFAULT_FIXTURE, SENTINELS } from '../src/adapters/fixture.js';
import { summarizeMessages } from '../src/summarize.js';
import { defaultPolicy, failClosedPolicy } from '../src/core/policy.js';

const SECRET = 'e2e-secret-at-least-sixteen-chars';

function buildService(overrides = {}) {
  return createService({
    adapter: createFixtureAdapter(DEFAULT_FIXTURE),
    secret: SECRET,
    summarize: summarizeMessages,
    ...overrides,
  });
}

test('端到端：群被摘要，私聊与频道被拒，且哨兵不外泄', async () => {
  const service = buildService();

  const rooms = await service.listRooms();
  assert.equal(rooms.allowed.length, 2);
  assert.equal(rooms.deniedCount, 2);
  assert.equal(rooms.deniedReasons.PRIVATE_FORBIDDEN, 1);
  assert.equal(rooms.deniedReasons.EXCLUDED_CHANNEL, 1);

  const result = await service.runSummary({ trigger: 'manual' });
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.summarized.length, 2);

  const serialized = JSON.stringify(result);
  // 阳性对照：群内容确实进来了
  assert.equal(serialized.includes(SENTINELS.GROUP_A), false, '摘要里不该有群消息原文');
  // 阴性对照：私聊与频道内容一个字符都不出现
  assert.equal(serialized.includes(SENTINELS.PRIVATE), false);
  assert.equal(serialized.includes(SENTINELS.EXCLUDED), false);
  assert.equal(serialized.includes('private:'), false);
  assert.equal(serialized.includes('88880001'), false);

  const all = service.getDigest();
  assert.equal(all.status, 'OK');
  assert.equal(all.count, 2);
  const digestText = JSON.stringify(all);
  assert.equal(digestText.includes(SENTINELS.PRIVATE), false);
  assert.equal(digestText.includes(SENTINELS.EXCLUDED), false);
  // 群的正文（作为摘要素材）应该出现在 highlight/task 里
  assert.ok(digestText.includes('评审交互稿') || digestText.includes(SENTINELS.GROUP_A));
});

test('摘要结构包含重点活动 / 任务 / 结论三类', async () => {
  const service = buildService();
  await service.runSummary({ trigger: 'manual' });
  const { items } = service.getDigest();
  assert.ok(items.length >= 2);

  for (const item of items) {
    assert.ok(Array.isArray(item.digest.highlights));
    assert.ok(Array.isArray(item.digest.tasks));
    assert.ok(Array.isArray(item.digest.decisions));
    assert.match(item.roomHandle, /^[0-9a-f]{16}$/);
    assert.equal(typeof item.provenance.seqFrom, 'number');
  }

  const flat = items.flatMap((item) => item.digest.tasks.map((task) => task.what));
  assert.ok(flat.length >= 1, '应该识别出至少一项待办');
});

test('getDigest 只认 16 位十六进制句柄', () => {
  const service = buildService();
  assert.equal(service.getDigest('group:123').status, 'REJECTED');
  assert.equal(service.getDigest('../../etc/passwd').status, 'REJECTED');
  assert.equal(service.getDigest('0123456789abcdef').status, 'NOT_FOUND');
});

test('策略降级（全关）时不产出任何摘要', async () => {
  const service = buildService({
    policy: undefined,
    getPolicy: () => failClosedPolicy('PARSE:broken'),
  });
  const rooms = await service.listRooms();
  assert.equal(rooms.allowed.length, 0);
  assert.equal(rooms.policyDegraded, true);

  const result = await service.runSummary({ trigger: 'manual' });
  assert.equal(result.summarized.length, 0);
  // 两个群都因为策略降级被关掉（私聊/频道另有各自的拒绝原因，不在本条断言范围内）
  const groupDenied = result.denied.filter((item) => item.reason === 'GROUP_DISABLED');
  assert.equal(groupDenied.length, 2);
});

test('策略提供方抛错 → fail-closed，不是 fail-open', async () => {
  const service = buildService({
    getPolicy: () => {
      throw new Error('config exploded');
    },
  });
  const rooms = await service.listRooms();
  assert.equal(rooms.allowed.length, 0);
  assert.equal(rooms.policyDegraded, true);
});

test('status 不泄漏密钥值', async () => {
  const service = buildService();
  const status = await service.status();
  assert.equal(status.source, 'fixture');
  assert.equal(status.secretConfigured, true);
  assert.equal(JSON.stringify(status).includes(SECRET), false);
});

test('默认策略：群全开、私聊全关', () => {
  const policy = defaultPolicy();
  assert.equal(policy.group.defaultEnabled, true);
  assert.equal(policy.private.defaultEnabled, false);
});

test('显式打开某条私聊后，它会被摘要（默认态之外的阳性对照）', async () => {
  const service = buildService({
    policy: {
      version: 1,
      group: { defaultEnabled: true, overrides: {} },
      private: { defaultEnabled: false, overrides: { 'private:88880001': { enabled: true } } },
    },
  });

  const rooms = await service.listRooms();
  assert.equal(rooms.allowed.filter((room) => room.kind === 'private').length, 1);
  assert.equal(rooms.allowed.length, 3);

  const result = await service.runSummary({ trigger: 'manual' });
  assert.equal(result.summarized.length, 3);

  const all = JSON.stringify(service.getDigest());
  assert.ok(all.includes(SENTINELS.PRIVATE), '打开后私聊内容才会出现在摘要里');
});

test('私聊起名后，名字会进摘要的 roomTitle', async () => {
  const service = createService({
    adapter: createFixtureAdapter(DEFAULT_FIXTURE),
    secret: SECRET,
    summarize: summarizeMessages,
    policy: {
      version: 1,
      group: { defaultEnabled: true, overrides: {} },
      private: { defaultEnabled: false, overrides: { 'private:88880001': { enabled: true } } },
    },
    titleProvider: (rawId) => (rawId === 'private:88880001' ? '老婆' : null),
  });

  const result = await service.runSummary({ trigger: 'manual' });
  const named = (result.summarized ?? []).find((item) => item.roomTitle === '老婆');
  assert.ok(named, '摘要条目应带上私聊名字');

  const digest = service.getDigest();
  assert.ok(digest.items.some((item) => item.roomTitle === '老婆'), '落盘的摘要也要带名字');
});

test('群起名后同样进 roomTitle；没起名的群保持 null', async () => {
  // 注意：fixture 里的群自带名字，所以这里用一个「数据源不提供名字」的适配器，
  // 才能验证「配置里的名字」这条路径确实生效。
  const namelessAdapter = {
    name: 'nameless',
    stateless: true,
    async listRooms() {
      return [
        { rawId: 'group:100000', authoritativeKind: 'group', name: null },
        { rawId: 'group:70001111', authoritativeKind: 'group', name: null },
      ];
    },
    async fetchMessages({ room }) {
      return room.rawId === 'group:100000'
        ? [{ seq: 1, time: 1762746000000, isSelf: false, nickname: '小林', text: '明天上午十点评审交互稿' }]
        : [{ seq: 1, time: 1762746000000, isSelf: false, nickname: '老王', text: '收到' }];
    },
  };

  const service = createService({
    adapter: namelessAdapter,
    secret: SECRET,
    summarize: summarizeMessages,
    titleProvider: (rawId) => (rawId === 'group:100000' ? '研发群' : null),
  });

  const result = await service.runSummary({ trigger: 'manual' });
  const titles = (result.summarized ?? []).map((item) => item.roomTitle);
  assert.ok(titles.includes('研发群'), '起名的群用配置里的名字');
  assert.ok(titles.includes(null), '没起名的群仍然是 null（不编造）');
});
