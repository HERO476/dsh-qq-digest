import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalize, isGroupId, KIND } from '../src/core/canonical.js';

test('群：唯一认可的形态是 group:<数字>', () => {
  const result = canonicalize('group:123456789');
  assert.equal(result.ok, true);
  assert.equal(result.kind, KIND.GROUP);
  assert.equal(result.canonicalId, 'group:123456789');
  assert.equal(result.groupId, '123456789');
});

test('群号去前导零，同一个群只可能有一个 canonicalId', () => {
  assert.equal(canonicalize('group:00123').canonicalId, 'group:123');
  assert.equal(canonicalize('GROUP:123').canonicalId, 'group:123');
  assert.equal(canonicalize('  group:123  ').canonicalId, 'group:123');
});

test('私聊：所有已知形态都归为 PRIVATE', () => {
  for (const raw of ['private:1000000001', 'user:1000000001', 'friend:1000000001', 'c2c:1000000001', 'temp:1', 'stranger:1', 'uin:1000000001']) {
    const result = canonicalize(raw);
    assert.equal(result.ok, true, raw);
    assert.equal(result.kind, KIND.PRIVATE, raw);
  }
});

test('裸数字一律 UNKNOWN，绝不猜成群', () => {
  for (const raw of ['1000000001', '123456789', '12345']) {
    const result = canonicalize(raw);
    assert.equal(result.ok, true, raw);
    assert.equal(result.kind, KIND.UNKNOWN, `${raw} 必须不能被当成群`);
  }
});

test('频道等排除形态归为 EXCLUDED', () => {
  for (const raw of ['channel:123', 'guild:123', 'guildchannel:1', 'discuss:1', 'system:notice']) {
    assert.equal(canonicalize(raw).kind, KIND.EXCLUDED, raw);
  }
});

test('畸形标识被拒绝，而不是被「修好」', () => {
  assert.equal(canonicalize(null).ok, false);
  assert.equal(canonicalize(123).ok, false);
  assert.equal(canonicalize('').reason, 'EMPTY');
  assert.equal(canonicalize('   ').reason, 'EMPTY');
  assert.equal(canonicalize(`group:${'9'.repeat(64)}`).reason, 'TOO_LONG');
  assert.equal(canonicalize('group:0').reason, 'BAD_GROUP_ID');
  assert.equal(canonicalize('group:\u0000abc').ok, false);
});

test('isGroupId 只对群返回 true', () => {
  assert.equal(isGroupId('group:123456'), true);
  assert.equal(isGroupId('private:123456'), false);
  assert.equal(isGroupId('123456'), false);
});
