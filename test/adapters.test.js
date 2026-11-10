import test from 'node:test';
import assert from 'node:assert/strict';

import { createBridgeAdapter, normalizeText } from '../src/adapters/bridge.js';
import { createSnowLumaAdapter, segmentToText } from '../src/adapters/snowluma.js';

function fakeFetch(routes) {
  return async (url) => {
    const key = typeof url === 'string' ? url : url.toString();
    for (const [match, payload] of Object.entries(routes)) {
      if (key.includes(match)) {
        return {
          ok: payload.status === undefined || payload.status === 200,
          status: payload.status ?? 200,
          json: async () => payload.body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('bridge：群与私聊都上行，类型声明只在群上', async () => {
  const adapter = createBridgeAdapter({
    readToken: () => 'tok',
    fetchImpl: fakeFetch({
      '/api/conversations': {
        body: {
          ok: true,
          items: [
            { key: 'group:70001111', unread: 0 },
            { key: 'private:88880001', unread: 3 },
          ],
        },
      },
    }),
  });

  const rooms = await adapter.listRooms();
  assert.equal(rooms.length, 2);
  assert.equal(rooms[0].authoritativeKind, 'group');
  assert.equal(rooms[0].groupId, '70001111');
  assert.equal(rooms[1].authoritativeKind, undefined);
  assert.equal(rooms[1].rawId, 'private:88880001');
});

test('bridge：fetchMessages 按 fromSeq 过滤并排序', async () => {
  const adapter = createBridgeAdapter({
    readToken: () => 'tok',
    fetchImpl: fakeFetch({
      '/api/messages': {
        body: {
          ok: true,
          items: [
            { seq: 3, time: 3000, isSelf: false, nickname: 'b', text: '第三条' },
            { seq: 1, time: 1000, isSelf: false, nickname: 'a', text: '第一条' },
            { seq: 2, time: 2000, isSelf: true, nickname: '', text: '第二条' },
          ],
        },
      },
    }),
  });

  const messages = await adapter.fetchMessages({ room: { rawId: 'group:1' }, fromSeq: 1 });
  assert.deepEqual(messages.map((m) => m.seq), [2, 3]);
  assert.equal(messages[0].isSelf, true);
});

test('bridge：缺令牌/不可达会抛带错误码的异常，而不是静默空数组', async () => {
  const unauthorized = createBridgeAdapter({
    readToken: () => '',
    fetchImpl: fakeFetch({ '/api/conversations': { status: 401, body: { ok: false } } }),
  });
  await assert.rejects(() => unauthorized.listRooms(), /BRIDGE_UNAUTHORIZED/);

  const broken = createBridgeAdapter({
    readToken: () => 'tok',
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await assert.rejects(() => broken.listRooms(), /BRIDGE_UNAVAILABLE/);
});

test('normalizeText 去掉控制字符并截断', () => {
  assert.equal(normalizeText('  a\u0000b  '), 'ab');
  assert.equal(normalizeText(null), '');
  assert.ok(normalizeText('x'.repeat(2000)).length <= 600);
});

test('snowluma：OneBot 消息段压成纯文本', () => {
  const text = segmentToText([
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'at', data: { qq: '88880001' } },
    { type: 'image', data: { file: 'x.jpg' } },
    { type: 'mface', data: { summary: '摸鱼' } },
  ]);
  assert.match(text, /看这个/);
  assert.match(text, /@88880001/);
  assert.match(text, /\[图片\]/);
  assert.match(text, /摸鱼/);
});

test('snowluma：群列表补 group: 前缀，裸数字绝不上行', async () => {
  const adapter = createSnowLumaAdapter({
    accessToken: 't',
    fetchImpl: fakeFetch({
      get_group_list: { body: { status: 'ok', retcode: 0, data: [{ group_id: 70001111, group_name: '客户群' }, { group_id: 'bad' }] } },
    }),
  });
  const rooms = await adapter.listRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].rawId, 'group:70001111');
  assert.equal(rooms[0].authoritativeKind, 'group');
  assert.equal(rooms[0].name, '客户群');
  assert.equal(adapter.stateless, true);
});
