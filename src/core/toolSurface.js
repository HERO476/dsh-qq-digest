/**
 * 工具面即策略：接口形状决定能力边界。
 *
 *  - 不存在发送类工具。发送能力在代码里就不存在，不是靠开关关掉。
 *  - 不存在任何接收原始会话标识的入参。读取用不透明句柄；
 *    范围只能通过策略文件改变，不能通过一次调用改变。
 *  - run_summary 刻意**没有** trigger 入参：多一个可被注入影响的维度都是风险。
 *  - 所有 schema 都 additionalProperties:false，防止「多塞一个参数」被接受。
 */

export const FORBIDDEN_TOOL_NAME =
  /send|reply|post|forward|comment|broadcast|poke|invite|kick|mute|add_member|remove_member|write|recall|delete/i;

export const FORBIDDEN_PARAM_NAMES = new Set([
  'key',
  'chatid',
  'chat_id',
  'chatroomid',
  'chatroom_id',
  'groupid',
  'group_id',
  'conversationid',
  'conversation_id',
  'qq',
  'uin',
  'userid',
  'user_id',
  'scope',
  'target',
  'to',
  'receiver',
  'peer',
  'username',
  'nickname',
  'talker',
  'trigger',
  'source',
  'adapter',
]);

export const TOOLS = Object.freeze([
  Object.freeze({
    name: 'qq_digest_list_rooms',
    description:
      '列出当前策略下可读的 QQ 群聊（默认所有群）。只返回不透明句柄与群名，不返回 QQ 号；私聊永不出现。只读。',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
  }),
  Object.freeze({
    name: 'qq_digest_run_summary',
    description:
      '立即执行一次增量总结，按群产出「重点活动 / 任务待办 / 决定结论」。只读；不接受任何范围参数，范围由策略文件决定。',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
  }),
  Object.freeze({
    name: 'qq_digest_get_digest',
    description: '按不透明句柄读取已生成的摘要与溯源定位；不传句柄则返回每个群的最新一篇。',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        roomHandle: Object.freeze({
          type: 'string',
          pattern: '^[0-9a-f]{16}$',
          description: 'qq_digest_list_rooms 返回的句柄',
        }),
      }),
      additionalProperties: false,
    }),
  }),
  Object.freeze({
    name: 'qq_digest_status',
    description: '查看插件状态：数据源、策略是否降级、可用群数、已生成摘要数。只读。',
    inputSchema: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
  }),
]);

export function validateToolSurface(tools = TOOLS) {
  const violations = [];

  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || tool.name.length === 0) {
      violations.push('TOOL_NAME_MISSING');
      continue;
    }
    if (FORBIDDEN_TOOL_NAME.test(tool.name)) violations.push(`FORBIDDEN_TOOL_NAME:${tool.name}`);

    const schema = tool.inputSchema ?? {};
    if (schema.type !== 'object') violations.push(`SCHEMA_NOT_OBJECT:${tool.name}`);
    if (schema.additionalProperties !== false) violations.push(`OPEN_SCHEMA:${tool.name}`);

    for (const prop of Object.keys(schema.properties ?? {})) {
      const lower = prop.toLowerCase();
      const isOpaqueHandle = /handle$/.test(lower);
      if (!isOpaqueHandle && FORBIDDEN_PARAM_NAMES.has(lower)) {
        violations.push(`FORBIDDEN_PARAM:${tool.name}.${prop}`);
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
