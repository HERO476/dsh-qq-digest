/**
 * 数据源适配器：假数据，用来验证链路与三态可见性。
 *
 * 刻意包含三个哨兵：
 *  - 群 A / 群 B 的正常消息
 *  - 一个**私聊**会话（正文含 PRIVATE_SENTINEL），用来证明它永远到不了输出
 *  - 一个**频道**（guild:），用来证明未归类形态 fail-closed
 */

export const SENTINELS = Object.freeze({
  GROUP_A: 'GROUP_A_SENTINEL_甲',
  GROUP_B: 'GROUP_B_SENTINEL_乙',
  PRIVATE: 'PRIVATE_SENTINEL_丙_不该出现',
  EXCLUDED: 'EXCLUDED_SENTINEL_丁_不该出现',
});

export function createFixtureAdapter(fixture = DEFAULT_FIXTURE) {
  return {
    name: 'fixture',
    stateless: false,

    async listRooms() {
      return fixture.rooms.map((room) => ({ ...room }));
    },

    async fetchMessages({ room, fromSeq = 0 }) {
      const rows = fixture.messages[room.rawId] ?? [];
      return rows
        .filter((message) => message.seq > fromSeq)
        .map((message) => ({ ...message }));
    },
  };
}

export const DEFAULT_FIXTURE = Object.freeze({
  rooms: Object.freeze([
    Object.freeze({ rawId: 'group:100000', authoritativeKind: 'group', name: '产品研发群', groupId: '100000' }),
    Object.freeze({ rawId: 'group:70001111', authoritativeKind: 'group', name: '客户对接群', groupId: '70001111' }),
    Object.freeze({ rawId: 'private:88880001', name: null }),
    Object.freeze({ rawId: 'guild:123456', name: '某频道' }),
  ]),
  messages: Object.freeze({
    'group:100000': Object.freeze([
      Object.freeze({
        seq: 1,
        time: 1762746000000,
        isSelf: false,
        nickname: '小林',
        text: `${SENTINELS.GROUP_A} 明天上午十点评审交互稿，请把走查问题整理到看板。`,
      }),
      Object.freeze({
        seq: 2,
        time: 1762746120000,
        isSelf: false,
        nickname: '阿May',
        text: '决定：这一版先不做深色模式，等 11 月底再说。我负责补一下需求文档。',
      }),
      Object.freeze({
        seq: 3,
        time: 1762746240000,
        isSelf: false,
        nickname: '小林',
        text: '收到，今天下班前把问题清单发群里。',
      }),
    ]),
    'group:70001111': Object.freeze([
      Object.freeze({
        seq: 1,
        time: 1762746400000,
        isSelf: false,
        nickname: '客户-王工',
        text: `${SENTINELS.GROUP_B} 下周三前需要一份接口联调时间表，麻烦确认。`,
      }),
      Object.freeze({
        seq: 2,
        time: 1762746520000,
        isSelf: false,
        nickname: '老陈',
        text: '联调时间表我来排，明天下班前给。',
      }),
    ]),
    'private:88880001': Object.freeze([
      Object.freeze({
        seq: 1,
        time: 1762746600000,
        isSelf: false,
        nickname: '某人',
        text: `${SENTINELS.PRIVATE} 这条私聊绝不能被读。`,
      }),
    ]),
    'guild:123456': Object.freeze([
      Object.freeze({
        seq: 1,
        time: 1762746700000,
        isSelf: false,
        nickname: '频道用户',
        text: `${SENTINELS.EXCLUDED} 频道消息不属于本插件范围。`,
      }),
    ]),
  }),
});
