/**
 * dsh-qq-digest —— 宿主半（Host）。
 *
 * 职责只有两件，都围绕「设置页要能改」：
 *
 *  1) HTTP API（/qq-digest-api）：给设置页读状态、存配置、立即跑一次。
 *     只允许回环地址访问；只接受群（group:…），私聊 id 一律 400。
 *
 *  2) 定时器：按 config.schedule 在到点时跑一轮总结。
 *     跑之前抢跨进程锁，和 MCP 工具的手动触发互斥。
 *
 * 这个文件不注册任何工具、不发送任何消息。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalize, KIND } from '../src/core/canonical.js';
import { roomHandle } from '../src/core/gate.js';
import { configPath, defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { resolveDataDir, resolveSecret, createRuntime } from '../src/runtime.js';
import { withRunLock } from '../src/run-lock.js';

export const name = 'dsh-qq-digest';
export const inject = ['webServer'];

const ROUTE = '/qq-digest-api';
const MAX_BODY_BYTES = 64 * 1024;
const TICK_MS = 30_000;
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function apply(ctx) {
  const dataDir = resolveDataDir();
  mkdirSync(dataDir, { recursive: true });

  const stateFile = join(dataDir, 'schedule-state.json');
  const secret = resolveSecret();

  let runtime = null;
  const getRuntime = () => {
    if (runtime === null) runtime = createRuntime({ dataDir, secret });
    return runtime;
  };

  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined);
  if (!webServer) {
    // 没有 Web 服务就没有设置页；定时器也就没有意义（跑不了配置）。
    ctx.logger?.warn?.('[qq-digest] 未发现 webServer，设置页与定时器均未启动');
    return;
  }

  // ── 状态 ────────────────────────────────────────────────────────────────

  async function buildState() {
    const loaded = loadConfig(configPath(dataDir));
    const config = loaded.config;
    const scheduleState = readScheduleState(stateFile);
    const clientBoot = readClientBoot(dataDir);

    let adapterError = null;
    let rooms = [];
    let privateRooms = [];
    try {
      const raw = await getRuntime().adapter.listRooms();
      const digests = latestDigestsByHandle(getRuntime().store);
      rooms = [];
      privateRooms = [];
      for (const room of raw) {
        const canon = canonicalize(room.rawId);
        if (!canon.ok) continue;

        // 私聊：单独一段，默认全关，只能逐条打开。
        if (canon.kind === KIND.PRIVATE) {
          const qq = canon.canonicalId.slice('private:'.length);
          const entry = config.private?.[qq];
          const handle = roomHandle(secret, canon.canonicalId);
          const digest = digests.get(handle) ?? null;
          privateRooms.push({
            qq,
            name: entry?.name ?? null,
            named: Boolean(entry?.name),
            enabled: entry?.enabled === true,
            hasDigest: digest !== null,
            lastDigestAt: digest?.createdAt ?? null,
          });
          continue;
        }

        if (canon.kind !== KIND.GROUP) continue;
        const entry = config.groups[canon.canonicalId];
        const handle = roomHandle(secret, canon.canonicalId);
        const digest = digests.get(handle) ?? null;
        rooms.push({
          groupId: canon.groupId,
          canonicalId: canon.canonicalId,
          title: room.name ?? entry?.name ?? null,
          enabled: entry?.enabled ?? true,
          named: Boolean(entry?.name),
          hasDigest: digest !== null,
          lastDigestAt: digest?.createdAt ?? null,
        });
      }
      rooms.sort((a, b) => String(a.title ?? a.groupId).localeCompare(String(b.title ?? b.groupId), 'zh'));
    } catch (err) {
      adapterError = { code: err?.code ?? 'ADAPTER_ERROR', message: String(err?.message ?? err) };
    }

    return {
      ok: true,
      dataDir,
      source: getRuntime().source,
      groupsEnabled: config.groupsEnabled !== false,
      privateRooms,
      configError: loaded.error,
      policyDegraded: Boolean(loaded.policy?.degraded),
      summarizer: config.summarizer,
      schedule: config.schedule,
      scheduleState,
      clientBoot,
      rooms,
      adapterError,
      limits: {
        // 群列表上限只影响展示；真正的裁决仍在闸门
        maxRooms: 200,
      },
    };
  }

  // ── 配置写入 ─────────────────────────────────────────────────────────────

  function saveFromUi(body) {
    const current = loadConfig(configPath(dataDir)).config;

    const groups = {};
    const inputGroups = body?.groups ?? {};
    if (inputGroups === null || typeof inputGroups !== 'object' || Array.isArray(inputGroups)) {
      throw badRequest('GROUPS_NOT_OBJECT');
    }
    for (const [rawId, value] of Object.entries(inputGroups)) {
      // UI 送来的是裸群号；补前缀后必须是 group:<数字>。
      const canon = canonicalize(/^\d+$/.test(rawId) ? `group:${rawId}` : rawId);
      if (!canon.ok) throw badRequest(`BAD_GROUP_ID:${canon.reason}`);
      if (canon.kind !== KIND.GROUP) throw badRequest(`ONLY_GROUPS:${canon.kind}`);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('GROUP_NOT_OBJECT');
      const enabled = value.enabled === undefined ? true : Boolean(value.enabled);
      const name = typeof value.name === 'string' ? value.name.trim().slice(0, 60) : undefined;
      groups[canon.canonicalId] = name ? { enabled, name } : { enabled };
    }

    // 私聊：UI 送来 { qq: true|false } 或 { qq: { enabled } }，只认布尔语义。
    const privateMap = {};
    const inputPrivate = body?.private ?? {};
    if (inputPrivate === null || typeof inputPrivate !== 'object' || Array.isArray(inputPrivate)) {
      throw badRequest('PRIVATE_NOT_OBJECT');
    }
    for (const [qq, value] of Object.entries(inputPrivate)) {
      if (!/^\d{5,12}$/.test(qq)) throw badRequest(`PRIVATE_BAD_QQ:${qq}`);
      const enabled = typeof value === 'object' && value !== null ? value.enabled === true : value === true;
      const rawName = typeof value === 'object' && value !== null && typeof value.name === 'string' ? value.name.trim().slice(0, 60) : '';
      privateMap[qq] = { enabled, ...(rawName ? { name: rawName } : {}) };
    }

    // 名字是给人看的：两个会话重名会让摘要列表分不清谁是谁。这里做权威拦截。
    const owners = new Map();
    const conflicts = [];
    const note = (name, owner) => {
      const key = String(name ?? '').trim().toLowerCase();
      if (key === '') return;
      const previous = owners.get(key);
      if (previous) conflicts.push({ name: String(name).trim(), a: previous, b: owner });
      else owners.set(key, owner);
    };
    for (const [id, value] of Object.entries(groups)) note(value.name, `群 ${id.replace('group:', '')}`);
    for (const [qq, value] of Object.entries(privateMap)) note(value.name, `私聊 ${qq}`);
    if (conflicts.length > 0) {
      const first = conflicts[0];
      throw badRequest(`DUPLICATE_NAME：「${first.name}」同时被${first.a}和${first.b}使用，请改成不同的名字`);
    }

    const next = {
      version: 1,
      groupsEnabled: body?.groupsEnabled === undefined ? current.groupsEnabled !== false : Boolean(body.groupsEnabled),
      groups,
      private: privateMap,
      summarizer: body?.summarizer ?? current.summarizer,
      schedule: normalizeSchedule(body?.schedule ?? current.schedule),
    };

    // 交给 config.js 的同一套校验：写坏就抛，绝不落一份「半合法」的配置。
    return saveConfig(configPath(dataDir), next);
  }

  // 归一化在模块级（见文件底部），这里只做调用。

  // ── 运行 ────────────────────────────────────────────────────────────────

  async function runOnce(trigger) {
    const result = await withRunLock(dataDir, () => getRuntime().service.runSummary({ trigger }));
    if (result.status === 'COMPLETED' || result.status === 'FAILED') {
      writeScheduleState(stateFile, { lastRunAt: new Date().toISOString(), trigger, status: result.status });
    }
    return result;
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  function handler(req, res) {
    if (denyNonLoopback(req, res)) return;

    let url;
    try {
      url = new URL(String(req.url ?? '/'), 'http://127.0.0.1');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'BAD_URL' });
    }

    const path = url.pathname;
    const method = String(req.method ?? 'GET').toUpperCase();

    Promise.resolve()
      .then(async () => {
        if (path === `${ROUTE}/state` && method === 'GET') {
          return sendJson(res, 200, await buildState());
        }

        if (path === `${ROUTE}/config` && method === 'POST') {
          const body = await readJson(req);
          const saved = saveFromUi(body);
          return sendJson(res, 200, { ok: true, config: saved, state: await buildState() });
        }

        if (path === `${ROUTE}/run` && method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          const trigger = body?.trigger === 'scheduled' ? 'scheduled' : 'manual';
          const result = await runOnce(trigger);
          return sendJson(res, 200, { ok: true, result, state: await buildState() });
        }

        if (path === `${ROUTE}/client-boot` && method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          recordClientBoot(dataDir, body);
          return sendJson(res, 200, { ok: true });
        }

        if (path === `${ROUTE}/digest` && method === 'GET') {
          const raw = String(url.searchParams.get('group') ?? '').trim();
          // 设置页送的是裸群号；补前缀后必须是群，裸数字不会被猜成群（canonical 层同样如此）。
          const canonical = canonicalize(/^\d+$/.test(raw) ? `group:${raw}` : raw);
          if (!canonical.ok || canonical.kind !== KIND.GROUP) {
            return sendJson(res, 400, { ok: false, error: 'ONLY_GROUPS' });
          }
          const handle = roomHandle(secret, canonical.canonicalId);
          const entry = getRuntime().store.latest(handle);
          return sendJson(res, 200, { ok: true, groupId: canonical.groupId, digest: entry?.digest ?? null, createdAt: entry?.createdAt ?? null });
        }

        return sendJson(res, 404, { ok: false, error: 'NOT_FOUND' });
      })
      .catch((err) => {
        const status = err?.code === 'CONFIG_INVALID' || err?.status === 400 ? 400 : 500;
        sendJson(res, status, { ok: false, error: String(err?.message ?? err) });
      });
  }

  ctx.effect(() => webServer.register({ kind: 'prefix', path: ROUTE, handler }));

  // ── 定时器 ──────────────────────────────────────────────────────────────

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const loaded = loadConfig(configPath(dataDir));
      const schedule = loaded.config.schedule;
      if (!schedule?.enabled) return;

      const now = nowIn(schedule.timeZone);
      if (!isDue(schedule, now)) return;

      const state = readScheduleState(stateFile);
      if (state.lastRunAt) {
        const last = nowIn(schedule.timeZone, new Date(state.lastRunAt));
        if (last.dateKey === now.dateKey) return; // 今天已经跑过
      }

      const result = await runOnce('scheduled');
      ctx.logger?.info?.(`[qq-digest] 定时总结 ${now.dateKey} ${now.hhmm} → ${result.status}`);
    } catch (err) {
      ctx.logger?.warn?.(`[qq-digest] 定时器异常：${String(err?.message ?? err)}`);
    } finally {
      ticking = false;
    }
  }

  const timer = setInterval(tick, TICK_MS);
  // 启动后 5 秒先试一次：DSH 刚好在到点后才起来时也能补上同一分钟内的一次。
  const bootTimer = setTimeout(tick, 5_000);
  ctx.effect(() => () => {
    clearInterval(timer);
    clearTimeout(bootTimer);
  });
}

// ── 工具函数 ──────────────────────────────────────────────────────────────

/**
 * 客户端半的心跳记录。
 *
 * 用途只有一个：让「设置里看不见」变成可判断的三种情况 ——
 *   factoryAt 有、mountedAt 空、lastError 有 → 加载了但注册失败
 *   factoryAt 空                            → 客户端 bundle 根本没执行
 *   两个都有                               → 注册成功（那是显示层的事，不在这条链上）
 */
function readClientBoot(dir) {
  const empty = { factoryAt: null, mountedAt: null, failedAt: null, lastPhase: null, lastError: null, hits: 0 };
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'client-boot.json'), 'utf8'));
    return {
      factoryAt: typeof parsed?.factoryAt === 'string' ? parsed.factoryAt : null,
      mountedAt: typeof parsed?.mountedAt === 'string' ? parsed.mountedAt : null,
      failedAt: typeof parsed?.failedAt === 'string' ? parsed.failedAt : null,
      lastPhase: typeof parsed?.lastPhase === 'string' ? parsed.lastPhase : null,
      lastError: typeof parsed?.lastError === 'string' ? parsed.lastError : null,
      hits: Number.isFinite(parsed?.hits) ? parsed.hits : 0,
    };
  } catch {
    return empty;
  }
}

function recordClientBoot(dir, body) {
  const phase = typeof body?.phase === 'string' ? body.phase.slice(0, 40) : 'unknown';
  try {
    const current = readClientBoot(dir);
    const at = new Date().toISOString();
    const next = {
      ...current,
      hits: current.hits + 1,
      lastPhase: phase,
      ...(phase === 'factory' ? { factoryAt: at } : {}),
      ...(phase === 'mounted' ? { mountedAt: at } : {}),
      ...(phase === 'mount-failed' || phase === 'slot-missing'
        ? { failedAt: at, lastError: String(body?.error ?? phase).slice(0, 200) }
        : {}),
    };
    writeFileSync(join(dir, 'client-boot.json'), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // 心跳写不进去不该影响任何功能
  }
}

function latestDigestsByHandle(store) {
  const map = new Map();
  const rows = typeof store.latestPerRoom === 'function' ? store.latestPerRoom() : store.all();
  for (const entry of rows) map.set(entry.roomHandle, entry);
  return map;
}

function nowIn(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  }).formatToParts(at);

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour') === '24' ? '00' : get('hour');
  const minute = get('minute');
  const weekdayName = get('weekday');
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekdayName);

  return {
    dateKey: `${year}-${month}-${day}`,
    hhmm: `${hour}:${minute}`,
    weekday: index >= 0 ? WEEKDAY_CODES[index] : 'MO',
  };
}

/**
 * 把设置页送来的定时配置收拾成 config.js 能接受的形状。
 * 未知频率一律回退成 weekly（而不是放行）；时间原样保留，交给 config 校验去拒。
 */
function normalizeSchedule(raw) {
  const base = defaultConfig().schedule;
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : base;
  return {
    enabled: source.enabled === undefined ? base.enabled : Boolean(source.enabled),
    kind: source.kind === 'daily' ? 'daily' : 'weekly',
    weekdays: Array.isArray(source.weekdays) && source.weekdays.length > 0 ? source.weekdays : base.weekdays,
    time: typeof source.time === 'string' ? source.time : base.time,
    timeZone: typeof source.timeZone === 'string' && source.timeZone ? source.timeZone : base.timeZone,
  };
}

function isDue(schedule, now) {
  if (now.hhmm !== schedule.time) return false;
  if (schedule.kind === 'daily') return true;
  return Array.isArray(schedule.weekdays) && schedule.weekdays.includes(now.weekday);
}

function readScheduleState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : null,
      lastStatus: typeof parsed?.lastStatus === 'string' ? parsed.lastStatus : null,
    };
  } catch {
    return { lastRunAt: null, lastStatus: null };
  }
}

function writeScheduleState(file, { lastRunAt, trigger, status }) {
  try {
    const previous = existsSync(file) ? readScheduleState(file) : { lastRunAt: null };
    const payload = { lastRunAt: lastRunAt ?? previous.lastRunAt, lastTrigger: trigger, lastStatus: status };
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // 状态文件写不进去不该让一轮总结失败
  }
}

function denyNonLoopback(req, res) {
  const address = String(req.socket?.remoteAddress ?? '');
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (loopback) return false;
  sendJson(res, 403, { ok: false, error: 'LOCAL_ONLY' });
  return true;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(badRequest('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(badRequest('BAD_JSON'));
      }
    });
    req.on('error', reject);
  });
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 仅供单元测试：时区换算与到期判定是定时逻辑里最容易错的部分。 */
export const __test = { nowIn, isDue, normalizeSchedule };
