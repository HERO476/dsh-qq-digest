import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultPolicy, failClosedPolicy, parsePolicy, resolveSwitch } from '../src/core/policy.js';
import { KIND } from '../src/core/canonical.js';

test('默认策略：群全开、私聊全关', () => {
  const parsed = parsePolicy(defaultPolicy());
  assert.equal(parsed.ok, true);
  assert.equal(resolveSwitch(parsed.policy, KIND.GROUP, 'group:1').enabled, true);
  assert.equal(resolveSwitch(parsed.policy, KIND.PRIVATE, 'private:1000000001').enabled, false);
});

test('私聊可以逐条打开', () => {
  const parsed = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: { 'private:1000000001': { enabled: true } } },
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(resolveSwitch(parsed.policy, KIND.PRIVATE, 'private:1000000001'), { enabled: true, source: 'override' });
  assert.equal(resolveSwitch(parsed.policy, KIND.PRIVATE, 'private:999999').enabled, false);
});

test('「一键放开所有私聊」直接判策略非法', () => {
  const parsed = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: true, overrides: {} },
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /PRIVATE_DEFAULT_MUST_BE_FALSE/);
});

test('私聊覆盖键必须真的是私聊', () => {
  const parsed = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: {} },
    private: { defaultEnabled: false, overrides: { 'group:123': { enabled: true } } },
  });
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /OVERRIDE_NOT_PRIVATE/);
});

test('任何可疑键名按名字直接拒', () => {
  for (const key of ['allowAll', 'sendText', 'scope', 'write', 'friendList', 'allowPrivate']) {
    const result = parsePolicy({ version: 1, group: { defaultEnabled: true, overrides: {} }, [key]: true });
    assert.equal(result.ok, false, key);
  }
});

test('未知字段 → 作废', () => {
  assert.equal(parsePolicy({ version: 1, group: { defaultEnabled: true, overrides: {} }, extra: 1 }).ok, false);
  assert.equal(parsePolicy({ version: 2, group: { defaultEnabled: true, overrides: {} } }).ok, false);
});

test('群覆盖键必须是群', () => {
  const bad = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: { 'private:123456': { enabled: true } } },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /OVERRIDE_NOT_GROUP/);
});

test('单群覆盖优先于默认', () => {
  const parsed = parsePolicy({
    version: 1,
    group: { defaultEnabled: true, overrides: { 'group:100000': { enabled: false } } },
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(resolveSwitch(parsed.policy, KIND.GROUP, 'group:100000'), { enabled: false, source: 'override' });
  assert.deepEqual(resolveSwitch(parsed.policy, KIND.GROUP, 'group:999'), { enabled: true, source: 'default' });
});

test('resolveSwitch 对未归类通道一律 false', () => {
  const parsed = parsePolicy(defaultPolicy());
  assert.equal(resolveSwitch(parsed.policy, KIND.UNKNOWN, 'whatever').enabled, false);
  assert.equal(resolveSwitch(parsed.policy, KIND.EXCLUDED, 'channel:1').enabled, false);
});

test('failClosedPolicy 群与私聊全部关闭', () => {
  const policy = failClosedPolicy('PARSE:boom');
  assert.equal(resolveSwitch(policy, KIND.GROUP, 'group:1').enabled, false);
  assert.equal(resolveSwitch(policy, KIND.PRIVATE, 'private:1').enabled, false);
  assert.equal(policy.degraded, true);
  assert.equal(policy.degradedReason, 'PARSE:boom');
});
