/**
 * 跨进程运行锁：目录级互斥，防止「定时任务」和「手动触发」同时跑同一轮。
 *
 * 为什么不能只靠 core/lock.js：那是进程内内存锁，MCP 进程和 DSH 宿主进程是
 * 两个不同的进程，各自的内存锁互不可见。两边同时写 watermarks.json 会互相覆盖。
 *
 * 用 mkdir 做原子占位（Windows 上 mkdir 也是原子的），里面写 pid + 时间戳；
 * 超过 lease 时限视为陈旧锁并抢占，避免进程崩溃后永久卡死。
 */

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LEASE_MS = 10 * 60_000;

export function lockPath(dir) {
  return join(dir, 'run.lock');
}

/**
 * @param {string} dir 数据目录
 * @param {{ leaseMs?: number, now?: () => number }} [options]
 */
export function acquireRunLock(dir, options = {}) {
  const { leaseMs = DEFAULT_LEASE_MS, now = () => Date.now() } = options;
  const path = lockPath(dir);
  const owner = { pid: process.pid, at: now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
      return {
        ok: true,
        path,
        release() {
          try {
            rmSync(path, { recursive: true, force: true });
          } catch {
            // 释放失败不该让整轮结果变成失败
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;

      // 已有锁：判断是否陈旧
      let age = 0;
      try {
        const stat = statSync(path);
        age = now() - stat.mtimeMs;
      } catch {
        age = 0;
      }

      if (age > leaseMs) {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch {
          // 抢不到就让下一轮再试
        }
        continue;
      }

      let holder = null;
      try {
        holder = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
      } catch {
        holder = null;
      }
      return { ok: false, reason: 'ALREADY_RUNNING', holder, ageMs: Math.round(age) };
    }
  }

  return { ok: false, reason: 'ALREADY_RUNNING', holder: null, ageMs: null };
}

/** 拿锁跑一段工作；拿不到就返回 ALREADY_RUNNING，不排队。 */
export async function withRunLock(dir, fn, options = {}) {
  const lease = acquireRunLock(dir, options);
  if (!lease.ok) return { status: 'ALREADY_RUNNING', holder: lease.holder, ageMs: lease.ageMs };
  try {
    return await fn();
  } finally {
    lease.release();
  }
}
