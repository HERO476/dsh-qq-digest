#!/usr/bin/env node
/**
 * 宿主半冒烟：不启动 DSH，直接用一个假 ctx 把 apply() 跑起来，
 * 再对着它注册的 HTTP 路由发真实的 req/res 对象。
 *
 * 这能提前抓到「路由没注册 / 路径写错 / JSON 形状不对 / 私聊没被拒」，
 * 不必等到重启 DSH 之后才在设置页里发现。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dataDir = mkdtempSync(join(tmpdir(), 'qq-digest-host-'));
process.env.QQ_DIGEST_DATA_DIR = dataDir;
process.env.QQ_DIGEST_SOURCE = process.env.QQ_DIGEST_SOURCE || 'fixture';

const { apply } = await import('../lib/index.js');

let captured = null;
const ctx = {
  webServer: {
    register(options) {
      captured = options;
      return () => {};
    },
  },
  effect(fn) {
    const disposer = fn();
    return () => {};
  },
  get() {
    return undefined;
  },
  logger: { info() {}, warn() {} },
};

apply(ctx);

if (captured === null) {
  console.error('FAIL: 没有注册任何路由');
  process.exit(1);
}
if (captured.kind !== 'prefix' || captured.path !== '/qq-digest-api') {
  console.error(`FAIL: 路由形状不对 ${JSON.stringify({ kind: captured.kind, path: captured.path })}`);
  process.exit(1);
}

function request(handler, { method = 'GET', url, body, headers = {}, remoteAddress = '127.0.0.1' }) {
  return new Promise((resolve, reject) => {
    const req = new Readable({ read() {} });
    req.method = method;
    req.url = url;
    // 真实请求一定带 Host；写操作还带 content-type。
    // 宿主半现在会校验 Host / Origin / Sec-Fetch-Site，所以这里要把「正常浏览器」的形状补齐。
    req.headers = {
      host: '127.0.0.1:4845',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    };
    req.socket = { remoteAddress };
    if (body !== undefined) req.push(JSON.stringify(body));
    req.push(null);

    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers ?? {};
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: this.statusCode, json: JSON.parse(text) });
        } catch {
          reject(new Error(`非 JSON 响应：${text.slice(0, 200)}`));
        }
      },
    };

    handler(req, res);
  });
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
}

const state = await request(captured.handler, { url: '/qq-digest-api/state' });
check('GET /state 返回 200', state.status === 200, state.status);
check('状态里有 groups 数组', Array.isArray(state.json.rooms), typeof state.json.rooms);
check('只暴露群', (state.json.rooms ?? []).every((room) => /^\d+$/.test(String(room.groupId))), JSON.stringify(state.json.rooms?.slice(0, 2)));
check('fixture 下应看到 2 个群', (state.json.rooms ?? []).length === 2, (state.json.rooms ?? []).length);
check('默认群聊总开关是开的', state.json.groupsEnabled === true, state.json.groupsEnabled);
check('私聊单独成列且默认全关', Array.isArray(state.json.privateRooms) && state.json.privateRooms.length === 1 && state.json.privateRooms[0].enabled === false, JSON.stringify(state.json.privateRooms));

const saved = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groups: { '100000': { enabled: false } }, summarizer: 'heuristic', schedule: { enabled: true, kind: 'daily', time: '09:30', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('POST /config 保存成功', saved.status === 200 && saved.json.ok === true, saved.status);
check('关掉的群出现在配置里', saved.json.config?.groups?.['group:100000']?.enabled === false, JSON.stringify(saved.json.config?.groups));
check('定时时间被保存', saved.json.config?.schedule?.time === '09:30', saved.json.config?.schedule?.time);

const afterSave = await request(captured.handler, { url: '/qq-digest-api/state' });
const closed = (afterSave.json.rooms ?? []).find((room) => room.groupId === '100000');
check('关掉的群在列表里标记为关闭', closed?.enabled === false, JSON.stringify(closed));

const privateAttempt = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groups: { '88880001-private': { enabled: true }, 'private:88880001': { enabled: true } } },
});
check('私聊 id 被拒（400）', privateAttempt.status === 400, `${privateAttempt.status} ${JSON.stringify(privateAttempt.json)}`);

const badTime = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groups: {}, summarizer: 'heuristic', schedule: { enabled: true, kind: 'daily', time: '9:3', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('非法时间被拒（400）', badTime.status === 400, `${badTime.status} ${JSON.stringify(badTime.json)}`);

const privSave = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: false, groups: {}, private: { '88880001': { enabled: true, name: '测试私聊' } }, summarizer: 'heuristic', schedule: { enabled: false, kind: 'daily', time: '09:00', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('可以逐条打开私聊', privSave.status === 200, privSave.status);
check('总开关可以关掉', privSave.json.state?.groupsEnabled === false, privSave.json.state?.groupsEnabled);
check('私聊开关落盘', privSave.json.state?.privateRooms?.[0]?.enabled === true, JSON.stringify(privSave.json.state?.privateRooms));
check('私聊名字落盘', privSave.json.state?.privateRooms?.[0]?.name === '测试私聊', privSave.json.state?.privateRooms?.[0]?.name);

const blockedRun = await request(captured.handler, { method: 'POST', url: '/qq-digest-api/run', body: {} });
const blockedDenied = (blockedRun.json?.result?.denied ?? []).filter((item) => item.reason === 'GROUP_DISABLED');
check('总开关关掉后所有群都被拒（单群覆盖也失效）', blockedDenied.length === 2, blockedDenied.length);

const restore = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: true, groups: {}, private: { '88880001': { enabled: false } }, summarizer: 'heuristic', schedule: { enabled: false, kind: 'daily', time: '09:00', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('可以再恢复默认', restore.status === 200 && restore.json.state?.groupsEnabled === true, restore.status);

const run = await request(captured.handler, { method: 'POST', url: '/qq-digest-api/run', body: {} });
check('POST /run 返回结果', run.status === 200 && typeof run.json.result?.status === 'string', JSON.stringify(run.json.result?.status));

const digest = await request(captured.handler, { url: '/qq-digest-api/digest?group=70001111' });
check('GET /digest 只认群号', digest.status === 200 || digest.json.digest === null, digest.status);

const privateDigest = await request(captured.handler, { url: '/qq-digest-api/digest?group=private%3A1' });
check('私聊句柄读不到摘要（400）', privateDigest.status === 400, privateDigest.status);

// 客户端半心跳：证明「设置页看不见」时能分清是哪一层的问题
const bootFactory = await request(captured.handler, { method: 'POST', url: '/qq-digest-api/client-boot', body: { phase: 'factory' } });
check('POST /client-boot 接受 factory 心跳', bootFactory.status === 200, bootFactory.status);
const bootMounted = await request(captured.handler, { method: 'POST', url: '/qq-digest-api/client-boot', body: { phase: 'mounted', sectionId: 'qq-digest' } });
check('POST /client-boot 接受 mounted 心跳', bootMounted.status === 200, bootMounted.status);
const withBoot = await request(captured.handler, { url: '/qq-digest-api/state' });
check('状态里回显客户端心跳', Boolean(withBoot.json.clientBoot?.factoryAt && withBoot.json.clientBoot?.mountedAt), JSON.stringify(withBoot.json.clientBoot));

const notFound = await request(captured.handler, { url: '/qq-digest-api/nope' });
check('未知路径 404', notFound.status === 404, notFound.status);

// 重名：群和私聊同名必须被拒（放在最后，避免改动状态影响前面的用例）
const dupSave = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: true, groups: { '100000': { enabled: true, name: '重名' } }, private: { '88880001': { enabled: false, name: '重名' } }, summarizer: 'heuristic', schedule: { enabled: false, kind: 'daily', time: '09:00', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('群与私聊同名 → 400', dupSave.status === 400 && String(dupSave.json.error ?? '').includes('DUPLICATE_NAME'), `${dupSave.status} ${JSON.stringify(dupSave.json)}`);

const uniqueSave = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: true, groups: { '100000': { enabled: true, name: '甲' } }, private: { '88880001': { enabled: false, name: '乙' } }, summarizer: 'heuristic', schedule: { enabled: false, kind: 'daily', time: '09:00', weekdays: ['MO'], timeZone: 'Asia/Shanghai' } },
});
check('名字互不相同 → 200', uniqueSave.status === 200, uniqueSave.status);


// ── 管理面来源校验（跨站 / rebinding / 隧道 / CSRF）──────────────────────
// 这些用例锁住的是「只判 remoteAddress 不够」这件事本身：
// 每一条的攻击前提都能让 remoteAddress 看起来是回环。
const evilOrigin = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: false },
  headers: { origin: 'https://evil.example' },
});
check('跨站 Origin → 403', evilOrigin.status === 403 && evilOrigin.json.error === 'BAD_ORIGIN', `${evilOrigin.status} ${JSON.stringify(evilOrigin.json)}`);

const evilHost = await request(captured.handler, { url: '/qq-digest-api/state', headers: { host: 'evil.example:4845' } });
check('伪造 Host（DNS rebinding）→ 403', evilHost.status === 403 && evilHost.json.error === 'BAD_HOST', `${evilHost.status} ${JSON.stringify(evilHost.json)}`);

const crossSite = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/run',
  body: {},
  headers: { 'sec-fetch-site': 'cross-site' },
});
check('Sec-Fetch-Site: cross-site → 403', crossSite.status === 403 && crossSite.json.error === 'CROSS_SITE', `${crossSite.status} ${JSON.stringify(crossSite.json)}`);

const textPlain = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/config',
  body: { groupsEnabled: true },
  headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
});
check('text/plain 简单请求（CSRF）→ 被来源校验挡住', textPlain.status === 403 || textPlain.status === 415, `${textPlain.status} ${JSON.stringify(textPlain.json)}`);

const sameOriginNoBody = await request(captured.handler, {
  method: 'POST',
  url: '/qq-digest-api/client-boot',
  body: { phase: 'factory' },
  headers: { origin: 'http://127.0.0.1:4845' },
});
check('同源 Origin + application/json → 放行', sameOriginNoBody.status === 200, `${sameOriginNoBody.status} ${JSON.stringify(sameOriginNoBody.json)}`);

const nonLoopback = await request(captured.handler, { url: '/qq-digest-api/state', remoteAddress: '192.168.1.10' });
check('非回环来源 → 403 LOCAL_ONLY', nonLoopback.status === 403 && nonLoopback.json.error === 'LOCAL_ONLY', `${nonLoopback.status} ${JSON.stringify(nonLoopback.json)}`);

for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail === undefined ? '' : `  (${result.detail})`}`);
}

rmSync(dataDir, { recursive: true, force: true });

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
