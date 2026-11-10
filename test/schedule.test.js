import test from 'node:test';
import assert from 'node:assert/strict';

import { __test } from '../lib/index.js';

const { nowIn, isDue, normalizeSchedule } = __test;

test('时区换算：用配置里的 IANA 时区，而不是进程本地时区', () => {
  // 2026-11-10T02:30:00Z → 上海 10:30
  const at = new Date('2026-11-10T02:30:00.000Z');
  const shanghai = nowIn('Asia/Shanghai', at);
  assert.equal(shanghai.dateKey, '2026-11-10');
  assert.equal(shanghai.hhmm, '10:30');
  assert.equal(shanghai.weekday, 'TU');

  // 同一时刻在 UTC 是 02:30
  assert.equal(nowIn('UTC', at).hhmm, '02:30');
});

test('跨日边界：上海 00:10 属于新的一天，不是 UTC 的前一天', () => {
  const at = new Date('2026-11-10T16:10:00.000Z'); // 上海 11-11 00:10
  const shanghai = nowIn('Asia/Shanghai', at);
  assert.equal(shanghai.dateKey, '2026-11-11');
  assert.equal(shanghai.hhmm, '00:10');
  assert.equal(shanghai.weekday, 'WE');
});

test('午夜小时不会变成 24:xx', () => {
  const at = new Date('2026-11-10T16:00:00.000Z');
  assert.equal(nowIn('Asia/Shanghai', at).hhmm, '00:00');
});

test('daily 只在指定分钟命中', () => {
  const schedule = { kind: 'daily', time: '09:00', weekdays: [] };
  assert.equal(isDue(schedule, { hhmm: '09:00', weekday: 'SA' }), true);
  assert.equal(isDue(schedule, { hhmm: '09:01', weekday: 'SA' }), false);
});

test('weekly 还要匹配星期', () => {
  const schedule = { kind: 'weekly', time: '09:00', weekdays: ['MO', 'WE'] };
  assert.equal(isDue(schedule, { hhmm: '09:00', weekday: 'WE' }), true);
  assert.equal(isDue(schedule, { hhmm: '09:00', weekday: 'TU' }), false);
});

test('normalizeSchedule 把脏输入收拾成合法值', () => {
  const base = normalizeSchedule(null);
  assert.equal(base.kind, 'weekly');
  assert.equal(base.timeZone, 'Asia/Shanghai');

  const cleaned = normalizeSchedule({ enabled: 'yes', kind: 'hourly', time: '8:00', weekdays: [], timeZone: '' });
  assert.equal(cleaned.enabled, true);
  assert.equal(cleaned.kind, 'weekly', '未知频率回退成 weekly，而不是放行 hourly');
  assert.equal(cleaned.time, '8:00', '时间原样保留，交给 config 校验去拒');
  assert.equal(cleaned.weekdays.length > 0, true);
  assert.equal(cleaned.timeZone, 'Asia/Shanghai');
});
