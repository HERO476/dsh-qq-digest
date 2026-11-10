/**
 * 数据源适配器：直连 SnowLuma 的 OneBot v11 HTTP 接口。
 *
 * 和 bridge 适配器的分工：
 *  - bridge：只用桥接**已经收到**的消息（会话被机器人见过才有内容）。
 *  - snowluma：能枚举**机器人所在的所有群**并拉取群历史，覆盖更全，
 *    但要求 SnowLuma 网关在线（`gatewayReady: true`）。
 *
 * 只调三个只读动作：get_group_list、get_group_msg_history。
 * 本文件里**不存在** get_friend_msg_history —— 私聊连取数路径都没有。
 * 即便如此，返回的每条会话依然要以 `group:` 前缀进入闸门，
 * 因为「我只调群接口」是约定，而闸门是机制；两者都要有。
 *
 * 本适配器 stateless：SnowLuma 的 message_id 不保证单调，
 * 拿它当水位线会出现「新消息被判成旧消息」的静默漏读。
 * 因此每次拉取固定窗口、全量重算，代价是多花一点 token，换来不漏。
 */

const DEFAULT_HTTP_URL = 'http://127.0.0.1:3000';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_CHARS = 600;

export function createSnowLumaAdapter(options = {}) {
  const {
    httpUrl = process.env.QQ_DIGEST_SNOWLUMA_URL || DEFAULT_HTTP_URL,
    accessToken = process.env.QQ_DIGEST_SNOWLUMA_TOKEN || '',
    historyCount = 60,
    maxRooms = 200,
    fetchImpl = globalThis.fetch,
  } = options;

  const cleanBase = String(httpUrl).replace(/\/+$/, '');

  async function action(name, params = {}) {
    let response;
    try {
      response = await fetchImpl(`${cleanBase}/${name}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ action: name, params }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw coded('SNOWLUMA_UNAVAILABLE', `SnowLuma 网关不可达（${cleanBase}）：${String(err?.message ?? err)}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw coded('SNOWLUMA_UNAUTHORIZED', 'SnowLuma 拒绝了 accessToken');
    }
    if (!response.ok) throw coded('SNOWLUMA_HTTP_' + response.status, `SnowLuma 返回 HTTP ${response.status}`);

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw coded('SNOWLUMA_BAD_RESPONSE', 'SnowLuma 返回的不是 JSON');
    }
    if (payload?.status === 'failed' || (payload?.retcode ?? 0) !== 0) {
      throw coded('SNOWLUMA_ACTION_FAILED', `OneBot ${name} 失败：${String(payload?.wording ?? payload?.message ?? payload?.retcode)}`);
    }
    return payload?.data ?? payload;
  }

  return {
    name: 'snowluma',
    stateless: true,

    async listRooms() {
      const data = await action('get_group_list');
      const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      const rooms = [];

      for (const item of items) {
        // OneBot 群号是数字；这里**必须**由适配器补 group: 前缀，
        // 绝不把裸数字交给闸门（裸数字是 UNKNOWN，会被拒）。
        const groupId = String(item?.group_id ?? '').trim();
        if (!/^\d{1,20}$/.test(groupId)) continue;
        rooms.push({
          rawId: `group:${groupId}`,
          authoritativeKind: 'group',
          name: typeof item?.group_name === 'string' ? item.group_name : null,
          groupId,
        });
        if (rooms.length >= maxRooms) break;
      }
      return rooms;
    },

    async fetchMessages({ room }) {
      const groupId = Number(room.groupId ?? String(room.rawId).replace(/^group:/, ''));
      if (!Number.isFinite(groupId) || groupId <= 0) {
        throw coded('SNOWLUMA_BAD_GROUP', '群号无效，拒绝拉取');
      }

      const data = await action('get_group_msg_history', { group_id: groupId, count: historyCount });
      const items = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
      const messages = [];

      items.forEach((item, index) => {
        const text = segmentToText(item?.message ?? item?.raw_message, item?.raw_message);
        if (text.length === 0) return;
        const senderId = String(item?.sender?.user_id ?? '');
        messages.push({
          // stateless：seq 只用于溯源展示与排序，不参与跨轮增量。
          seq: index + 1,
          time: Number(item?.time) > 0 ? Number(item.time) * 1000 : 0,
          isSelf: senderId !== '' && senderId === String(process.env.QQ_DIGEST_SELF_ID ?? ''),
          nickname: normalizeNickname(item?.sender?.card || item?.sender?.nickname),
          text,
        });
      });

      return messages;
    },
  };
}

/** OneBot message 段 → 纯文本。只保留文字，其余压成人话占位。 */
export function segmentToText(message, rawMessage) {
  if (typeof message === 'string' && message.length > 0) return clip(message);
  if (!Array.isArray(message)) return clip(typeof rawMessage === 'string' ? rawMessage : '');

  const parts = [];
  for (const segment of message) {
    if (!segment || typeof segment !== 'object') continue;
    const type = segment.type;
    const data = segment.data ?? {};
    if (type === 'text') parts.push(String(data.text ?? ''));
    else if (type === 'at') parts.push(`@${String(data.qq ?? '')}`);
    else if (type === 'image') parts.push('[图片]');
    else if (type === 'face') parts.push('[表情]');
    else if (type === 'mface') parts.push(`[表情包${data.summary ? `: ${String(data.summary).slice(0, 20)}` : ''}]`);
    else if (type === 'record') parts.push('[语音]');
    else if (type === 'video') parts.push('[视频]');
    else if (type === 'file') parts.push('[文件]');
    else if (type === 'reply') parts.push('[回复]');
    else if (type === 'forward') parts.push('[合并转发]');
  }
  return clip(parts.join(''));
}

function clip(text) {
  const cleaned = String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  return cleaned.slice(0, MAX_MESSAGE_CHARS);
}

export function normalizeNickname(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
}

export function coded(code, message) {
  // 把错误码写进 message：日志和 MCP 输出里能直接看出是哪一类失败。
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}
