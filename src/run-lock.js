/**
 * 跨进程运行锁：目录级互斥，防止「定时任务」和「手动触发」同时跑同一轮。
 *
 * 为什么不能只靠 core/lock.js：那是进程内内存锁，MCP 进程和 DSH 宿主进程是
 * 两个不同的进程，各自的内存锁互不可见。两边同时写 watermarks.json 会互相覆盖。
 *
 * 用 mkdir 做原子占位（Windows 上 mkdir 也是原子的），里面写 pid + 时间戳；
 * 超过 lease 时限视为陈旧锁并抢占，避免进程崩溃后永久卡死。
 */

import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_LEASE_MS = 10 * 60_000;
/**
 * 心跳间隔。租期只有 10 分钟，而一轮最坏可能跑几个小时
 * （200 个房间上限 × LLM 单次 60s 超时 + 桥接 15s），所以必须续租：
 * 否则「还在跑」的锁会被下一个触发者判成陈旧锁抢占，两轮并发写水位线，
 * 表现为重复摘要与水位线互相覆盖 —— 也就是锁存在的唯一理由失效。
 */
const DEFAULT_HEARTBEAT_MS = 60_000;
/** 手动触发的最短间隔（毫秒）。可用 QQ_DIGEST_MIN_RUN_INTERVAL_MS 覆盖，0 表示关闭。 */
const DEFAULT_MIN_INTERVAL_MS = 60_000;

export function lockPath(dir) {
  return join(dir, 'run.lock');
}

/**
 * @param {string} dir 数据目录
 * @param {{ leaseMs?: number, now?: () => number }} [options]
 */
export function acquireRunLock(dir, options = {}) {
  const {
    leaseMs = DEFAULT_LEASE_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    now = () => Date.now(),
  } = options;
  const path = lockPath(dir);
  const owner = { pid: process.pid, at: now() };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(path);
      const ownerFile = join(path, 'owner.json');
      writeFileSync(ownerFile, `${JSON.stringify(owner)}\n`, 'utf8');

      // 续租：age 判定看的是**目录** mtime，所以心跳除了刷新 owner.json 还要 touch 目录本身。
      let timer = null;
      if (heartbeatMs > 0) {
        const period = Math.max(1_000, Math.min(heartbeatMs, Math.floor(leaseMs / 2)));
        timer = setInterval(() => {
          try {
            const beat = { pid: process.pid, at: now() };
            writeFileSync(ownerFile, `${JSON.stringify(beat)}\n`, 'utf8');
            const at = new Date();
            utimesSync(path, at, at);
          } catch {
            // 心跳失败不该让整轮失败：下一轮最多被判成陈旧锁，行为与没有心跳时相同。
          }
        }, period);
        timer.unref?.();
      }

      return {
        ok: true,
        path,
        owner,
        release() {
          if (timer) clearInterval(timer);
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
  const {
    trigger = 'manual',
    // 手动触发的最短间隔：防止连点「立即总结」或反复调 run_summary 把 LLM 费用放大。
    // 定时触发不受限（它本身已有每日去重，再限流会让「到点那次」被吞掉）。
    minIntervalMs = Number(process.env.QQ_DIGEST_MIN_RUN_INTERVAL_MS ?? DEFAULT_MIN_INTERVAL_MS),
    now = () => Date.now(),
  } = options;

  if (trigger === 'manual' && Number.isFinite(minIntervalMs) && minIntervalMs > 0) {
    const last = Number(readRate(dir).lastManualAt ?? 0);
    const elapsed = now() - last;
    if (last > 0 && elapsed >= 0 && elapsed < minIntervalMs) {
      return { status: 'RATE_LIMITED', retryAfterMs: Math.round(minIntervalMs - elapsed) };
    }
  }

  const lease = acquireRunLock(dir, options);
  if (!lease.ok) return { status: 'ALREADY_RUNNING', holder: lease.holder, ageMs: lease.ageMs };

  // 记录点在「开始」而不是「结束」：一轮可能跑几分钟，从开始算才是真正的调用频率。
  if (trigger === 'manual') writeRate(dir, { lastManualAt: now() });

  try {
    return await fn();
  } finally {
    lease.release();
  }
}

const RATE_FILE = 'rate.json';

function readRate(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, RATE_FILE), 'utf8')) ?? {};
  } catch {
    return {};
  }
}

function writeRate(dir, payload) {
  try {
    writeFileSync(join(dir, RATE_FILE), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // 速率状态写不进去不该让整轮失败：最多是限流失效
  }
}
