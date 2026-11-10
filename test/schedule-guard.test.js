import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { __test } from '../lib/index.js';

const { alreadyRanToday, isDue, nowIn, readScheduleState, writeScheduleState, normalizeSchedule, denyUntrustedRequest } = __test;

const TZ = 'Asia/Shanghai';
const DAILY = { enabled: true, kind: 'daily', time: '09:00', weekdays: [], timeZone: TZ };

/** 构造一个「本地时区某天某时」的 now 形状，保持与 nowIn 同样的字段。 */
function at(dateKey, hhmm, weekday) {
  return { dateKey, hhmm, weekday };
}

test('手动跑过之后，当天的定时仍然会执行（这是最容易静默失效的一条）', () => {
  const state = { lastRunAt: '2026-11-10T00:59:00.000Z', lastTrigger: 'manual', lastStatus: 'COMPLETED' };
  // 2026-11-10T00:59Z = 上海 08:59，同一天
  assert.equal(alreadyRanToday(state, DAILY, at('2026-11-10', '09:00', 'TU')), false);
});

test('定时跑过之后，当天不再重复跑', () => {
  const state = { lastRunAt: '2026-11-10T01:00:30.000Z', lastTrigger: 'scheduled', lastStatus: 'COMPLETED' };
  assert.equal(alreadyRanToday(state, DAILY, at('2026-11-10', '09:00', 'TU')), true);
});

test('昨天定时跑过，不影响今天', () => {
  const state = { lastRunAt: '2026-11-09T01:00:00.000Z', lastTrigger: 'scheduled', lastStatus: 'COMPLETED' };
  assert.equal(alreadyRanToday(state, DAILY, at('2026-11-10', '09:00', 'TU')), false);
});

test('没有历史状态时不会误判为「今天跑过」', () => {
  assert.equal(alreadyRanToday({ lastRunAt: null, lastTrigger: null }, DAILY, at('2026-11-10', '09:00', 'TU')), false);
  assert.equal(alreadyRanToday(undefined, DAILY, at('2026-11-10', '09:00', 'TU')), false);
});

test('schedule-state 往返保留 lastTrigger（读的时候不能把它丢了）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-digest-sched-'));
  try {
    const file = join(dir, 'schedule-state.json');
    writeScheduleState(file, { lastRunAt: '2026-11-10T00:59:00.000Z', trigger: 'manual', status: 'COMPLETED' });
    const read = readScheduleState(file);
    assert.equal(read.lastTrigger, 'manual');
    assert.equal(read.lastRunAt, '2026-11-10T00:59:00.000Z');
    assert.equal(read.lastStatus, 'COMPLETED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('周几不可判定时不跑（不猜周一）', () => {
  const weekly = { enabled: true, kind: 'weekly', time: '09:00', weekdays: ['MO'], timeZone: TZ };
  assert.equal(isDue(weekly, at('2026-11-10', '09:00', null)), false);
  assert.equal(isDue(weekly, at('2026-11-10', '09:00', 'MO')), true);
  assert.equal(isDue(weekly, at('2026-11-10', '09:01', 'MO')), false);
});

test('nowIn 在真实时区下能给出 dateKey / hhmm / weekday', () => {
  const now = nowIn(TZ, new Date('2026-11-10T01:00:00.000Z'));
  assert.equal(now.dateKey, '2026-11-10');
  assert.equal(now.hhmm, '09:00');
  assert.equal(now.weekday, 'TU');
});

test('normalizeSchedule 把脏输入收成合法值', () => {
  const out = normalizeSchedule({ kind: 'hourly', time: '09:00' });
  assert.equal(out.kind, 'weekly', '未知频率一律回退 weekly，而不是放行');
  assert.equal(out.time, '09:00');
});

// ── 管理面来源校验（不启动 HTTP，直接喂 req）───────────────────────────────
function req({ method = 'GET', headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, headers, socket: { remoteAddress } };
}
function fakeRes() {
  return {
    status: null,
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
}

test('管理面：非回环来源一律拒绝', () => {
  const res = fakeRes();
  assert.equal(denyUntrustedRequest(req({ remoteAddress: '10.0.0.5' }), res), true);
  assert.equal(res.status, 403);
});

test('管理面：回环 + 正常浏览器头 → 放行', () => {
  const res = fakeRes();
  assert.equal(
    denyUntrustedRequest(req({ headers: { host: '127.0.0.1:4260', origin: 'http://127.0.0.1:4260' } }), res),
    false,
  );
});

test('管理面：跨站 Origin / 伪造 Host / cross-site 一律拒绝', () => {
  const crossOrigin = fakeRes();
  assert.equal(denyUntrustedRequest(req({ headers: { host: '127.0.0.1:4260', origin: 'https://evil.example' } }), crossOrigin), true);
  assert.equal(crossOrigin.status, 403);

  const badHost = fakeRes();
  assert.equal(denyUntrustedRequest(req({ headers: { host: 'evil.example:4260' } }), badHost), true);
  assert.equal(badHost.status, 403);

  const crossSite = fakeRes();
  assert.equal(
    denyUntrustedRequest(req({ headers: { host: '127.0.0.1:4260', 'sec-fetch-site': 'cross-site' } }), crossSite),
    true,
  );
});

test('管理面：写操作必须是 application/json（挡住 text/plain 简单请求 CSRF）', () => {
  const textPlain = fakeRes();
  assert.equal(
    denyUntrustedRequest(req({ method: 'POST', headers: { host: '127.0.0.1:4260', 'content-type': 'text/plain' } }), textPlain),
    true,
  );
  assert.equal(textPlain.status, 415);

  const json = fakeRes();
  assert.equal(
    denyUntrustedRequest(req({ method: 'POST', headers: { host: '127.0.0.1:4260', 'content-type': 'application/json' } }), json),
    false,
  );
});
