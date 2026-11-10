import test from 'node:test';
import assert from 'node:assert/strict';

import { createGate, REASON, VERDICT, roomHandle } from '../src/core/gate.js';
import { defaultPolicy, parsePolicy } from '../src/core/policy.js';

const SECRET = 'test-secret-at-least-sixteen-chars';
const gate = createGate({ secret: SECRET });
const policy = defaultPolicy();

test('群默认放行，并返回不透明句柄而不是群号', () => {
  const decision = gate({ policy, rawId: 'group:70001111', authoritativeKind: 'group' });
  assert.equal(decision.verdict, VERDICT.ALLOW);
  assert.match(decision.roomHandle, /^[0-9a-f]{16}$/);
  assert.equal(decision.roomHandle, roomHandle(SECRET, 'group:70001111'));
  assert.equal(JSON.stringify(decision).includes('70001111'), false);
});

test('私聊默认拒绝（逐条打开之前一律不读）', () => {
  const privateIds = ['private:1', 'private:88880001', 'user:1', 'friend:1', 'c2c:1', 'temp:1', 'stranger:1', 'uin:1'];
  for (const rawId of privateIds) {
    assert.equal(gate({ policy, rawId }).reason, REASON.PRIVATE_FORBIDDEN, rawId);
  }
});

test('被显式打开的私聊才放行，且句柄不泄漏 QQ 号', () => {
  const opened = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: { 'private:88880001': { enabled: true } } },
  });
  assert.equal(opened.ok, true);

  const decision = gate({ policy: opened.policy, rawId: 'private:88880001' });
  assert.equal(decision.verdict, VERDICT.ALLOW);
  assert.equal(decision.roomHandle, roomHandle(SECRET, 'private:88880001'));
  assert.equal(JSON.stringify(decision).includes('88880001'), false);

  // 没被打开的那条仍然拒
  assert.equal(gate({ policy: opened.policy, rawId: 'private:88880002' }).reason, REASON.PRIVATE_FORBIDDEN);
});

test('频道与未归类标识一律拒绝，且原因可区分', () => {
  assert.equal(gate({ policy, rawId: '123456789' }).reason, REASON.UNKNOWN_CHANNEL);
  assert.equal(gate({ policy, rawId: 'channel:1' }).reason, REASON.EXCLUDED_CHANNEL);
  assert.equal(gate({ policy, rawId: 'nonsense' }).reason, REASON.UNKNOWN_CHANNEL);
});

test('声明类型与权威类型不一致即拒', () => {
  const decision = gate({ policy, rawId: 'group:123', authoritativeKind: 'private' });
  assert.equal(decision.reason, REASON.TYPE_MISMATCH);
});

test('总开关关掉（group.defaultEnabled=false）时，单群覆盖也不再生效', () => {
  // toPolicy 在总开关关闭时会把 overrides 清空，这里直接用清空后的策略验证闸门行为。
  const masterOff = { version: 1, group: { defaultEnabled: false, overrides: {} }, private: { defaultEnabled: false, overrides: {} } };
  const decision = gate({ policy: masterOff, rawId: 'group:100000' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.GROUP_DISABLED);
});

test('被关掉的群拒绝，且原因可区分', () => {
  const closed = { version: 1, group: { defaultEnabled: true, overrides: { 'group:100000': { enabled: false } } }, private: { defaultEnabled: false, overrides: {} } };
  const decision = gate({ policy: closed, rawId: 'group:100000' });
  assert.equal(decision.verdict, VERDICT.DENY);
  assert.equal(decision.reason, REASON.GROUP_DISABLED);
});

test('拒绝也带 auditRef（同一个哈希），便于审计而不写原始 id', () => {
  const decision = gate({ policy, rawId: 'private:88880001' });
  assert.equal(decision.auditRef, roomHandle(SECRET, 'private:88880001'));
  assert.equal(JSON.stringify(decision).includes('88880001'), false);
});

test('密钥太短直接拒绝创建闸门', () => {
  assert.throws(() => createGate({ secret: 'short' }), /GATE_SECRET_TOO_SHORT/);
});
