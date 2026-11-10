import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOLS, validateToolSurface, FORBIDDEN_PARAM_NAMES } from '../src/core/toolSurface.js';

test('工具面自检通过', () => {
  const result = validateToolSurface(TOOLS);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('工具清单：只有只读四件套，没有任何发送/管理类工具', () => {
  const names = TOOLS.map((tool) => tool.name);
  assert.deepEqual(names, ['qq_digest_list_rooms', 'qq_digest_run_summary', 'qq_digest_get_digest', 'qq_digest_status']);
  for (const name of names) {
    assert.equal(/send|reply|forward|recall|delete|kick|mute/i.test(name), false, name);
  }
});

test('所有 schema 封闭（additionalProperties:false）', () => {
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
  }
});

test('没有任何工具接受原始会话标识或范围参数', () => {
  for (const tool of TOOLS) {
    for (const prop of Object.keys(tool.inputSchema.properties ?? {})) {
      assert.match(prop.toLowerCase(), /handle$/, `${tool.name}.${prop} 只能是句柄`);
      assert.equal(FORBIDDEN_PARAM_NAMES.has(prop.toLowerCase()), false, `${tool.name}.${prop}`);
    }
  }
});

test('run_summary 没有 trigger 入参（触发方式不可被注入影响）', () => {
  const runSummary = TOOLS.find((tool) => tool.name === 'qq_digest_run_summary');
  assert.deepEqual(Object.keys(runSummary.inputSchema.properties ?? {}), []);
});

test('校验器能抓到违规工具', () => {
  const bad = [
    { name: 'send_message', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_room', inputSchema: { type: 'object', properties: { group_id: { type: 'string' } }, additionalProperties: false } },
    { name: 'open_schema', inputSchema: { type: 'object', properties: {}, additionalProperties: true } },
  ];
  const result = validateToolSurface(bad);
  assert.equal(result.ok, false);
  assert.ok(result.violations.some((v) => v.startsWith('FORBIDDEN_TOOL_NAME:send_message')));
  assert.ok(result.violations.some((v) => v.startsWith('FORBIDDEN_PARAM:read_room.group_id')));
  assert.ok(result.violations.some((v) => v.startsWith('OPEN_SCHEMA:open_schema')));
});
