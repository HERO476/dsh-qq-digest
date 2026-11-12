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
import { roomHandle, uiRef } from '../src/core/gate.js';
import { configPath, defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import { resolveDataDir, createRuntime } from '../src/runtime.js';
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

  let runtime = null;
  const getRuntime = () => {
    // createRuntime 自己解析密钥（env → <dataDir>/handle-secret → 首次生成），
    // 与 MCP 半走同一份实现，保证两边算出的句柄一致。
    if (runtime === null) runtime = createRuntime({ dataDir });
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
    const secret = getRuntime().secret;
    const loaded = loadConfig(configPath(dataDir));
    const config = loaded.config;
    const scheduleState = readScheduleState(stateFile);
    const clientBoot = readClientBoot(dataDir);

    let adapterError = null;
    let rooms = [];
    let privateRooms = [];
    let visibleDigestCount = null;
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
            ref: uiRef(secret, canon.canonicalId),
            qqMasked: maskId(qq),
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
          ref: uiRef(secret, canon.canonicalId),
          groupIdMasked: maskId(canon.groupId),
          title: room.name ?? entry?.name ?? null,
          enabled: entry?.enabled ?? true,
          named: Boolean(entry?.name),
          hasDigest: digest !== null,
          lastDigestAt: digest?.createdAt ?? null,
        });
      }
      rooms.sort((a, b) => String(a.title ?? a.groupIdMasked).localeCompare(String(b.title ?? b.groupIdMasked), 'zh'));

      // 与 MCP 半 status.visibleDigestCount 同一口径：当前策略下真的读得到的摘要条数。
      // 与 digestCount 的差值 = 策略关掉的 + 换过密钥而失效的（后者在设置页里表现为「摘要凭空消失」）。
      const groupsOpen = config.groupsEnabled !== false;
      visibleDigestCount =
        (groupsOpen ? rooms.filter((room) => room.hasDigest && room.enabled !== false).length : 0) +
        privateRooms.filter((room) => room.hasDigest && room.enabled === true).length;
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
      // 密钥来源如实上报（env / generated / file / explicit）。值本身永不下发。
      secretSource: getRuntime().secretSource,
      // 落盘总量 vs 当前读得到的量：两个数不一致就是「有摘要存在但看不见」。
      digestCount: getRuntime().store.all().length,
      visibleDigestCount,
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

  /**
   * ref → 会话。每次保存时重新枚举数据源现算，不落任何映射表。
   * 数据源不可用时返回空表：此时只接受原始 id（不会把对的请求误判成错）。
   */
  async function resolveRefs() {
    const map = new Map();
    try {
      const secret = getRuntime().secret;
      const rooms = await getRuntime().adapter.listRooms();
      for (const room of rooms) {
        const canon = canonicalize(room.rawId);
        if (!canon.ok) continue;
        map.set(uiRef(secret, canon.canonicalId), { canonicalId: canon.canonicalId, kind: canon.kind });
      }
    } catch {
      // 数据源不可用：只能按原始 id 保存
    }
    return map;
  }

  async function saveFromUi(body) {
    const refs = await resolveRefs();
    const loaded = loadConfig(configPath(dataDir));
    // 配置文件本身坏了时 loadConfig 会回退成默认值；拿这个默认值当 current 再保存，
    // 会把用户原有的 groups 静默清空。宁可明确拒绝，让人先修好文件。
    if (loaded.error) throw badRequest(`CONFIG_UNREADABLE:${loaded.error}`);
    const current = loaded.config;

    const groups = {};
    const inputGroups = body?.groups ?? {};
    if (inputGroups === null || typeof inputGroups !== 'object' || Array.isArray(inputGroups)) {
      throw badRequest('GROUPS_NOT_OBJECT');
    }
    for (const [rawId, value] of Object.entries(inputGroups)) {
      // UI 可能送 ref（脱敏后的引用）、裸群号或 group:<数字>，三种都认。
      const resolvedId = refs.has(rawId) ? refs.get(rawId).canonicalId : rawId;
      const canon = canonicalize(/^\d+$/.test(resolvedId) ? `group:${resolvedId}` : resolvedId);
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
    for (const [key, value] of Object.entries(inputPrivate)) {
      const resolvedKey = refs.has(key) ? refs.get(key).canonicalId : key;
      const qq = resolvedKey.startsWith('private:') ? resolvedKey.slice('private:'.length) : resolvedKey;
      if (!/^\d{5,12}$/.test(qq)) throw badRequest(`PRIVATE_BAD_QQ:${key}`);
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
    const result = await withRunLock(dataDir, () => getRuntime().service.runSummary({ trigger }), { trigger });
    if (result.status === 'COMPLETED' || result.status === 'FAILED') {
      writeScheduleState(stateFile, { lastRunAt: new Date().toISOString(), trigger, status: result.status });
    }
    return result;
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  function handler(req, res) {
    if (denyUntrustedRequest(req, res)) return;

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
          const saved = await saveFromUi(body);
          return sendJson(res, 200, { ok: true, config: saved, state: await buildState() });
        }

        if (path === `${ROUTE}/run` && method === 'POST') {
          await readJson(req).catch(() => ({}));
          // trigger 由服务端定值：允许调用方声明 'scheduled' 会让审计失真，
          // 更糟的是会把它写进 schedule-state，把当天的真定时判定成「已经跑过」。
          const result = await runOnce('manual');
          return sendJson(res, 200, { ok: true, result, state: await buildState() });
        }

        if (path === `${ROUTE}/client-boot` && method === 'POST') {
          const body = await readJson(req).catch(() => ({}));
          recordClientBoot(dataDir, body);
          return sendJson(res, 200, { ok: true });
        }

        if (path === `${ROUTE}/digest` && method === 'GET') {
          const refRaw = String(url.searchParams.get('ref') ?? '').trim();
          const raw = String(url.searchParams.get('group') ?? '').trim();
          let canonical = null;
          if (refRaw !== '') {
            const hit = (await resolveRefs()).get(refRaw);
            canonical = hit && hit.kind === KIND.GROUP ? canonicalize(hit.canonicalId) : null;
          } else {
            // 兼容脚本：也认裸群号与 group:<数字>
            canonical = canonicalize(/^\d+$/.test(raw) ? `group:${raw}` : raw);
          }
          if (!canonical || !canonical.ok || canonical.kind !== KIND.GROUP) {
            return sendJson(res, 400, { ok: false, error: 'ONLY_GROUPS' });
          }
          // 与 MCP 工具走同一条读取路径：读取也要按当前策略复核，
          // 否则「关掉这个群」只影响下一轮取数，历史摘要照样读得到。
          const handle = roomHandle(getRuntime().secret, canonical.canonicalId);
          const out = await getRuntime().service.getDigest(handle);
          const entry = out.status === 'OK' ? out.entry : null;
          return sendJson(res, 200, {
            ok: true,
            groupIdMasked: maskId(canonical.groupId),
            status: out.status,
            ...(out.reason ? { reason: out.reason } : {}),
            digest: entry?.digest ?? null,
            createdAt: entry?.createdAt ?? null,
          });
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
      if (alreadyRanToday(state, schedule, now)) return;

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
    // 解析不出来就是 null，不再默默当成周一：fail-open 会让「每周一」的任务在错误的星期跑。
    weekday: index >= 0 ? WEEKDAY_CODES[index] : null,
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

/**
 * 今天是否已经「由定时任务」跑过。
 *
 * 只认 lastTrigger === 'scheduled'：手动跑也会写 lastRunAt，若把它当成定时已完成，
 * 用户在 08:59 手点一次「立即总结」，09:00 的定时就会被静默吞掉 —— 而且没有任何提示。
 */
function alreadyRanToday(state, schedule, now) {
  if (state?.lastTrigger !== 'scheduled' || !state.lastRunAt) return false;
  const last = nowIn(schedule.timeZone, new Date(state.lastRunAt));
  return last.dateKey === now.dateKey;
}

function isDue(schedule, now) {
  if (now.hhmm !== schedule.time) return false;
  if (schedule.kind === 'daily') return true;
  if (!now.weekday) return false; // 周几不可判定 → 不跑，而不是猜一个
  return Array.isArray(schedule.weekdays) && schedule.weekdays.includes(now.weekday);
}

function readScheduleState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return {
      lastRunAt: typeof parsed?.lastRunAt === 'string' ? parsed.lastRunAt : null,
      lastTrigger: typeof parsed?.lastTrigger === 'string' ? parsed.lastTrigger : null,
      lastStatus: typeof parsed?.lastStatus === 'string' ? parsed.lastStatus : null,
    };
  } catch {
    return { lastRunAt: null, lastTrigger: null, lastStatus: null };
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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 管理面入口校验。
 *
 * 只判 remoteAddress 是不够的，有三种真实场景会绕过去：
 *  1) DNS rebinding：攻击者的域名解析到 127.0.0.1，浏览器会把请求发到本机，remoteAddress 就是回环；
 *  2) 任意网页的跨站请求：浏览器发出的简单请求（form / text-plain）不需要预检，服务端不校验就照做；
 *  3) 反向代理 / 公网隧道：转进来的请求 remoteAddress 通常也是 127.0.0.1。
 *
 * 因此这里同时校验 Host、Origin、Sec-Fetch-Site，并要求写操作必须是 application/json
 * （该类型跨源必预检，而本服务不返回任何 CORS 头，预检不可能通过）。
 */
function denyUntrustedRequest(req, res) {
  const address = String(req.socket?.remoteAddress ?? '');
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  if (!loopback) return reject(res, 403, 'LOCAL_ONLY');

  if (!hostIsLoopback(req.headers?.host)) return reject(res, 403, 'BAD_HOST');
  if (!originIsLoopback(req.headers?.origin)) return reject(res, 403, 'BAD_ORIGIN');

  const site = String(req.headers?.['sec-fetch-site'] ?? '').toLowerCase();
  if (site === 'cross-site') return reject(res, 403, 'CROSS_SITE');

  const method = String(req.method ?? 'GET').toUpperCase();
  if (method === 'POST') {
    const type = String(req.headers?.['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) return reject(res, 415, 'JSON_REQUIRED');
  }

  return false;
}

function reject(res, status, error) {
  sendJson(res, status, { ok: false, error });
  return true;
}

function hostIsLoopback(header) {
  if (typeof header !== 'string' || header.trim() === '') return false;
  let value = header.trim().toLowerCase();
  // IPv6 形如 [::1]:1875，先剥掉端口
  if (value.startsWith('[')) value = value.slice(0, value.indexOf(']') + 1);
  else value = value.split(':')[0];
  return LOOPBACK_HOSTS.has(value);
}

function originIsLoopback(header) {
  // 没有 Origin 说明不是跨源浏览器请求（同源导航、curl、脚本），交给 Host 校验兜住。
  if (typeof header !== 'string' || header.trim() === '') return true;
  try {
    const url = new URL(header.trim());
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
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

/** 群号/QQ 号只露头尾，够人辨认，不够被拿去直接使用。 */
function maskId(value) {
  const text = String(value ?? '');
  if (text.length === 0) return '';
  if (text.length <= 4) return '*'.repeat(text.length);
  if (text.length <= 7) return `${text.slice(0, 2)}***${text.slice(-1)}`;
  return `${text.slice(0, 3)}****${text.slice(-3)}`;
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

/** 仅供单元测试：时区换算、到期判定与管理面来源校验是最容易出错的三块。 */
export const __test = {
  nowIn,
  isDue,
  alreadyRanToday,
  normalizeSchedule,
  readScheduleState,
  writeScheduleState,
  denyUntrustedRequest,
};
