import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 客户端半的加载契约测试。
 *
 * 两次真实故障都在这里锁住：
 *  1) 写成无参 IIFE → 浏览器里 `require is not defined`，web boot 记
 *     「1 entry did not activate / dsh-qq-digest: import failed」。
 *  2) `slots` 服务晚于 apply 发布时**直接 return** → 插件显示已安装，
 *     设置页里却没有这一项，且没有任何报错。现在改成重试。
 */

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadBundle() {
  const calls = [];
  let spec = null;
  const window = { __ModuleLoader__: { load(value) { spec = value; } } };
  const document = { querySelectorAll: () => [], baseURI: 'http://127.0.0.1:1/' };
  const location = { href: 'http://127.0.0.1:1/' };
  const fetchStub = (url, init) => {
    calls.push({ url: String(url), init });
    return { catch: () => {} };
  };

  const run = new Function('window', 'document', 'location', 'fetch', SOURCE);
  run(window, document, location, fetchStub);
  return { spec, calls };
}

function reactStub() {
  return {
    Fragment: 'Fragment',
    createElement: (...args) => ({ type: args[0] }),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

function makeSlots() {
  const registered = [];
  const slots = {
    inject(name, callback) {
      callback();
      return () => {};
    },
    register(options, render) {
      registered.push({ options, render });
      return () => {};
    },
  };
  return { slots, registered };
}

test('用 { id, factory } 形式注册，id 等于包名', () => {
  const { spec } = loadBundle();
  assert.ok(spec && typeof spec === 'object', '必须是对象形式，不能是无参 IIFE 的返回值');
  assert.equal(spec.id, 'dsh-qq-digest');
  assert.equal(typeof spec.factory, 'function');
});

test('React 从 factory 的 require 参数拿，而不是全局 require', () => {
  const { spec } = loadBundle();
  const asked = [];
  const mod = spec.factory((name) => {
    asked.push(name);
    return name === 'react' ? reactStub() : {};
  });

  assert.deepEqual(asked, ['react']);
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots'], '客户端半必须导出 inject = [slots]');
});

test('factory 执行时就发一次心跳（证明客户端 bundle 真的跑了）', () => {
  const { spec, calls } = loadBundle();
  spec.factory(() => reactStub());

  const boot = calls.find((call) => call.url.includes('/qq-digest-api/client-boot'));
  assert.ok(boot, '必须打 /client-boot，否则「没加载」和「加载了没注册」分不清');
  const body = JSON.parse(boot.init.body);
  assert.equal(body.phase, 'factory');
});

test('apply 在 slots 立即可用时注册「QQ 群摘要」', () => {
  const { spec, calls } = loadBundle();
  const mod = spec.factory(() => reactStub());
  const { slots, registered } = makeSlots();

  mod.apply({ get: (name) => (name === 'slots' ? slots : undefined) });

  assert.equal(registered.length, 1);
  assert.equal(registered[0].options.name, 'settings.section');
  assert.equal(registered[0].options.id, 'qq-digest');
  assert.equal(registered[0].options.label, 'QQ 群摘要');
  assert.equal(typeof registered[0].render, 'function');

  const mounted = calls.filter((call) => call.url.includes('/client-boot'))
    .map((call) => JSON.parse(call.init.body).phase);
  assert.ok(mounted.includes('mounted'), '注册成功后应打 mounted 心跳');
});

test('slots 晚于 apply 发布时重试并最终注册（不能直接放弃）', async () => {
  const { spec, calls } = loadBundle();
  const mod = spec.factory(() => reactStub());
  const { slots, registered } = makeSlots();

  let lookups = 0;
  const ctx = {
    get: () => {
      lookups += 1;
      return lookups > 2 ? slots : undefined;
    },
  };

  mod.apply(ctx);
  assert.equal(registered.length, 0, '首次读不到时还没有注册');

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(registered.length, 1, '重试之后必须注册上');
  assert.equal(registered[0].options.id, 'qq-digest');

  const phases = calls.filter((call) => call.url.includes('/client-boot'))
    .map((call) => JSON.parse(call.init.body).phase);
  assert.ok(phases.includes('mounted'));
});

test('slots 始终不出现：重试到上限后如实报错，不抛异常', async () => {
  const { spec, calls } = loadBundle();
  const mod = spec.factory(() => reactStub());

  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));

  try {
    mod.apply({ get: () => undefined });
    await new Promise((resolve) => setTimeout(resolve, 1400));
  } finally {
    console.error = originalError;
  }

  assert.ok(logged.some((line) => line.includes('slots')), '必须留下可查的错误日志');
  const phases = calls.filter((call) => call.url.includes('/client-boot'))
    .map((call) => JSON.parse(call.init.body).phase);
  assert.ok(phases.includes('slot-missing'), '应上报 slot-missing');
});

test('注册抛错时被抓成 mount-failed 心跳，而不是让整页 boot 崩掉', () => {
  const { spec, calls } = loadBundle();
  const mod = spec.factory(() => reactStub());

  const throwingSlots = {
    inject() {
      throw new Error('boom');
    },
    register() {
      return () => {};
    },
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => mod.apply({ get: () => throwingSlots }));
  } finally {
    console.error = originalError;
  }

  const phases = calls.filter((call) => call.url.includes('/client-boot'))
    .map((call) => JSON.parse(call.init.body).phase);
  assert.ok(phases.includes('mount-failed'));
});

test('草稿转换：只有关掉的群和改过名的群才写进配置', () => {
  const { spec } = loadBundle();
  const mod = spec.factory(() => reactStub());
  const { toDraft, buildGroupsPayload, buildPrivatePayload } = mod.__test;

  const state = {
    groupsEnabled: true,
    rooms: [
      { groupId: '100000', title: '默认开', enabled: true, named: false },
      { groupId: '70001111', title: '客户群', enabled: true, named: true },
      { groupId: '200000', title: '关掉的群', enabled: false, named: false },
    ],
    privateRooms: [
      { qq: '88880001', enabled: true },
      { qq: '88880002', enabled: false },
    ],
    summarizer: 'heuristic',
    schedule: { enabled: true, kind: 'daily', time: '08:30', weekdays: ['MO'], timeZone: 'Asia/Shanghai' },
  };

  const draft = toDraft(state);
  assert.equal(draft.summarizer, 'heuristic');
  assert.equal(draft.schedule.time, '08:30');
  assert.equal(draft.groups['100000'].name, '');
  assert.equal(draft.groups['70001111'].name, '客户群');

  const payload = buildGroupsPayload(draft);
  assert.deepEqual(Object.keys(payload).sort(), ['200000', '70001111']);
  assert.equal(payload['200000'].enabled, false);
  assert.equal(payload['100000'], undefined, '默认开的群不该产生覆盖项');

  assert.equal(draft.groupsEnabled, true);
  assert.equal(draft.private['88880001'].enabled, true);
  assert.equal(draft.private['88880001'].name, '');
  assert.equal(draft.private['88880002'].enabled, false);

  const priv = buildPrivatePayload(draft);
  assert.deepEqual(priv['88880001'], { enabled: true });
  assert.deepEqual(priv['88880002'], { enabled: false }, '关掉的私聊也要显式写 false，否则旧配置还留着 true');

  // 私聊起名：名字要跟着带上，没名字就不写空串
  draft.private['88880001'].name = '  老婆  ';
  const named = buildPrivatePayload(draft);
  assert.deepEqual(named['88880001'], { enabled: true, name: '老婆' }, '名字要 trim 后写入');
  assert.deepEqual(named['88880002'], { enabled: false }, '空名字不落盘');
});

test('重名检测：群和私聊合并判定，忽略大小写与首尾空格', () => {
  const { spec } = loadBundle();
  const mod = spec.factory(() => reactStub());
  const { findDuplicateNames } = mod.__test;

  // 群 A 与私聊 B 同名 → 检出
  const cross = findDuplicateNames(['老婆', ''], [' 老婆 ']);
  assert.equal(cross.has('老婆'), true);

  // 只有自己一个不算重复
  assert.equal(findDuplicateNames(['研发群'], ['']).size, 0);

  // 大小写 + 空格归一
  const mixed = findDuplicateNames(['Alice'], ['ALICE  ']);
  assert.equal(mixed.has('alice'), true);

  // 空名字不算重复（默认全空不该报错）
  assert.equal(findDuplicateNames(['', '  '], ['', null]).size, 0);

  // 三个同名也只是一个冲突项
  const triple = findDuplicateNames(['x', 'X'], [' x']);
  assert.equal(triple.size, 1);
});
