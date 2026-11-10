import test from 'node:test';
import assert from 'node:assert/strict';

import { defaultConfig, parseConfig, toPolicy } from '../src/config.js';
import { resolveSwitch } from '../src/core/policy.js';
import { KIND } from '../src/core/canonical.js';

test('默认配置：群总开关开、私聊空表', () => {
  const config = defaultConfig();
  assert.equal(config.groupsEnabled, true);
  assert.deepEqual(config.private, {});
  assert.equal(parseConfig(config).ok, true);
});

test('总开关关掉 → 所有群都不读，单群覆盖被忽略', () => {
  const parsed = parseConfig({
    ...defaultConfig(),
    groupsEnabled: false,
    groups: { 'group:100000': { enabled: true } },
  });
  assert.equal(parsed.ok, true);
  const policy = toPolicy(parsed.config);
  assert.equal(resolveSwitch(policy, KIND.GROUP, 'group:100000').enabled, false, '总开关关掉时单群覆盖必须失效');
  assert.equal(resolveSwitch(policy, KIND.GROUP, 'group:999').enabled, false);
});

test('总开关开着 → 单群覆盖照常生效', () => {
  const parsed = parseConfig({ ...defaultConfig(), groups: { 'group:100000': { enabled: false } } });
  const policy = toPolicy(parsed.config);
  assert.equal(resolveSwitch(policy, KIND.GROUP, 'group:100000').enabled, false);
  assert.equal(resolveSwitch(policy, KIND.GROUP, 'group:999').enabled, true);
});

test('私聊逐条开关映射到策略覆盖', () => {
  const parsed = parseConfig({
    ...defaultConfig(),
    private: { '1000000001': { enabled: true }, '1000000002': { enabled: false } },
  });
  assert.equal(parsed.ok, true);
  const policy = toPolicy(parsed.config);
  assert.equal(resolveSwitch(policy, KIND.PRIVATE, 'private:1000000001').enabled, true);
  assert.equal(resolveSwitch(policy, KIND.PRIVATE, 'private:1000000002').enabled, false);
  assert.equal(resolveSwitch(policy, KIND.PRIVATE, 'private:1000000').enabled, false, '没提到的私聊默认关');
  assert.equal(policy.private.defaultEnabled, false);
});

test('私聊键必须是 QQ 号', () => {
  const bad = parseConfig({ ...defaultConfig(), private: { 'private:1000000001': { enabled: true } } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /PRIVATE_BAD_QQ/);

  const short = parseConfig({ ...defaultConfig(), private: { '12': { enabled: true } } });
  assert.equal(short.ok, false);
});

test('私聊条目只认 enabled / name 两个字段', () => {
  const bad = parseConfig({ ...defaultConfig(), private: { '1000000001': { enabled: true, readAll: true } } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /PRIVATE_ENTRY_UNKNOWN_KEY/);

  const notBool = parseConfig({ ...defaultConfig(), private: { '1000000001': { enabled: 'yes' } } });
  assert.equal(notBool.ok, false);

  const badName = parseConfig({ ...defaultConfig(), private: { '1000000001': { enabled: true, name: 42 } } });
  assert.equal(badName.ok, false);
  assert.match(badName.reason, /PRIVATE_NAME_NOT_STRING/);
});

test('私聊可以起名字，名字只用于展示不影响开关', () => {
  const parsed = parseConfig({
    ...defaultConfig(),
    private: { '1000000001': { enabled: true, name: '  老婆  ' } },
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.config.private['1000000001'].name, '老婆', '名字要去空白');
  assert.equal(parsed.config.private['1000000001'].enabled, true);

  const policy = toPolicy(parsed.config);
  assert.equal(resolveSwitch(policy, KIND.PRIVATE, 'private:1000000001').enabled, true);
});

test('「一键全开私聊」这种写法被拒', () => {
  const bad = parseConfig({ ...defaultConfig(), privateAll: true });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /UNKNOWN_KEY|FORBIDDEN_KEY/);
});

test('群字段仍然只认 enabled/name', () => {
  const bad = parseConfig({ ...defaultConfig(), groups: { 'group:1': { enabled: true, send: true } } });
  assert.equal(bad.ok, false);
});

test('总开关必须是布尔', () => {
  const bad = parseConfig({ ...defaultConfig(), groupsEnabled: 'yes' });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /GROUPS_ENABLED_NOT_BOOLEAN/);
});
