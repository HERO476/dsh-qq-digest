import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withRunLock } from '../src/run-lock.js';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'qq-digest-rate-'));
}

test('手动触发在最短间隔内被拒绝（防止把 LLM 调用放大）', async () => {
  const dir = tempDir();
  try {
    let clock = 1_000_000;
    const now = () => clock;
    const opts = { trigger: 'manual', minIntervalMs: 60_000, now };

    const first = await withRunLock(dir, async () => ({ status: 'COMPLETED' }), opts);
    assert.equal(first.status, 'COMPLETED');

    clock += 5_000; // 5 秒后再点一次
    const second = await withRunLock(dir, async () => ({ status: 'COMPLETED' }), opts);
    assert.equal(second.status, 'RATE_LIMITED');
    assert.ok(second.retryAfterMs > 0 && second.retryAfterMs <= 60_000, String(second.retryAfterMs));

    clock += 60_000; // 间隔够了
    const third = await withRunLock(dir, async () => ({ status: 'COMPLETED' }), opts);
    assert.equal(third.status, 'COMPLETED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('定时触发不受限流影响（否则到点那次会被吞掉）', async () => {
  const dir = tempDir();
  try {
    let clock = 2_000_000;
    const now = () => clock;

    await withRunLock(dir, async () => ({ status: 'COMPLETED' }), { trigger: 'manual', minIntervalMs: 60_000, now });
    clock += 1_000;

    // 同一时刻的定时触发必须照常执行
    const scheduled = await withRunLock(dir, async () => ({ status: 'COMPLETED' }), { trigger: 'scheduled', minIntervalMs: 60_000, now });
    assert.equal(scheduled.status, 'COMPLETED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('minIntervalMs=0 关闭限流', async () => {
  const dir = tempDir();
  try {
    let clock = 3_000_000;
    const now = () => clock;
    const opts = { trigger: 'manual', minIntervalMs: 0, now };

    assert.equal((await withRunLock(dir, async () => ({ status: 'COMPLETED' }), opts)).status, 'COMPLETED');
    clock += 1;
    assert.equal((await withRunLock(dir, async () => ({ status: 'COMPLETED' }), opts)).status, 'COMPLETED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('限流与锁互不干扰：拿不到锁时返回 ALREADY_RUNNING，不写速率状态', async () => {
  const dir = tempDir();
  try {
    let clock = 4_000_000;
    const now = () => clock;

    // 占住锁
    const holder = await withRunLock(
      dir,
      async () => {
        // 在持锁期间再请求一次
        const nested = await withRunLock(dir, async () => ({ status: 'SHOULD_NOT_RUN' }), { trigger: 'manual', minIntervalMs: 0, now });
        assert.equal(nested.status, 'ALREADY_RUNNING');
        return { status: 'COMPLETED' };
      },
      { trigger: 'manual', minIntervalMs: 0, now },
    );
    assert.equal(holder.status, 'COMPLETED');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
