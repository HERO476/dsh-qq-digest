/**
 * 数据源适配器：qq-bridge 的本机只读 HTTP 接口。
 *
 * 为什么走桥接而不是直连 SnowLuma：
 *  - 桥接是这台机器上**已经在跑**的组件（端口 3100），有稳定的只读接口和令牌；
 *  - SnowLuma 网关可能离线，直连会直接失败；
 *  - 桥接的存储层是单一写者，读它不会和桥接抢同一份状态。
 *
 * 只调两个只读路由：GET /api/conversations、GET /api/messages。
 * 本文件里不存在任何 /api/send、/api/send-image、/api/mark-read 的调用路径。
 *
 * 会话标识由桥接给出（`group:<群号>` / `private:<QQ号>`），这里**原样上行**，
 * 不做任何「看起来像群就当群」的推断 —— 分类只发生在 core/canonical.js。
 */

import { resolveBridgePaths } from '../bridge-paths.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';
const REQUEST_TIMEOUT_MS = 15_000;

export function createBridgeAdapter(options = {}) {
  const {
    baseUrl = process.env.QQ_DIGEST_BRIDGE_URL || DEFAULT_BASE_URL,
    tokenFile = process.env.QQ_DIGEST_BRIDGE_TOKEN_FILE || resolveBridgePaths({ env: process.env }).token,
    maxRooms = 200,
    messageLimit = 100,
    readToken,
    fetchImpl = globalThis.fetch,
  } = options;

  const cleanBase = String(baseUrl).replace(/\/+$/, '');

  async function call(route, query = {}) {
    const url = new URL(`${cleanBase}${route}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    let token = '';
    try {
      token = typeof readToken === 'function' ? String(readToken() ?? '') : '';
    } catch {
      token = '';
    }

    let response;
    try {
      response = await fetchImpl(url, {
        headers: token ? { 'x-console-token': token } : {},
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw coded('BRIDGE_UNAVAILABLE', `qq-bridge 不可达（${cleanBase}）：${String(err?.message ?? err)}`);
    }

    if (response.status === 401) throw coded('BRIDGE_UNAUTHORIZED', 'qq-bridge 拒绝令牌：检查 state/console-token');
    if (!response.ok) throw coded('BRIDGE_HTTP_' + response.status, `qq-bridge 返回 HTTP ${response.status}`);

    let data;
    try {
      data = await response.json();
    } catch {
      throw coded('BRIDGE_BAD_RESPONSE', 'qq-bridge 返回的不是 JSON');
    }
    if (!data || data.ok !== true) {
      throw coded('BRIDGE_BAD_RESPONSE', `qq-bridge 返回失败：${String(data?.error ?? data?.code ?? 'unknown')}`);
    }
    return data;
  }

  return {
    name: 'bridge',
    // 桥接的会话有稳定的自增 seq，可以用增量水位线。
    stateless: false,

    async listRooms() {
      const data = await call('/api/conversations');
      const items = Array.isArray(data.items) ? data.items : [];
      const rooms = [];

      for (const item of items) {
        const key = typeof item?.key === 'string' ? item.key : '';
        // 只把群前缀的行交给闸门；私聊行同样上行（让闸门留下拒绝痕迹），
        // 但绝不在这里做「跳过」——跳过会让审计看不到「本来有个私聊」。
        if (!key) continue;
        rooms.push({
          rawId: key,
          // 桥接的 key 前缀就是它自己声明的类型；闸门会与 canonical 分类交叉校验。
          authoritativeKind: key.startsWith('group:') ? 'group' : undefined,
          name: null,
          groupId: key.startsWith('group:') ? key.slice(6) : null,
        });
        if (rooms.length >= maxRooms) break;
      }
      return rooms;
    },

    async fetchMessages({ room, fromSeq = 0 }) {
      const data = await call('/api/messages', {
        key: room.rawId,
        mode: 'recent',
        limit: messageLimit,
      });

      const items = Array.isArray(data.items) ? data.items : [];
      const messages = [];

      for (const item of items) {
        const seq = Number(item?.seq);
        if (!Number.isFinite(seq) || seq <= fromSeq) continue;
        const text = normalizeText(item?.text);
        if (text.length === 0) continue;
        messages.push({
          seq,
          time: Number(item?.time) || 0,
          isSelf: item?.isSelf === true,
          nickname: normalizeNickname(item?.nickname),
          text,
        });
      }

      messages.sort((a, b) => a.seq - b.seq);
      return messages;
    },
  };
}

/** 单条消息正文上限：防止一条超长消息把上下文撑爆。 */
const MAX_MESSAGE_CHARS = 600;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, MAX_MESSAGE_CHARS);
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_CHARS, '').trim().slice(0, 40);
}

export function coded(code, message) {
  // 把错误码写进 message：日志和 MCP 输出里能直接看出是哪一类失败。
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}
