# dsh-qq-digest

一个**只读**的 QQ 摘要插件：读群聊，产出「重点活动 / 任务待办 / 决定结论」。
**群聊默认全开、私聊默认全关**；私聊只由你在设置页一条一条打开，不允许一键全开。

> 这是插件，不是机器人：它没有、也不会有任何发送/回复/转发能力。
> 工具清单里不存在发送类工具，代码里也不存在发送路径。

## 三个开关（设置 → QQ 群摘要）

| 开关 | 默认 | 关掉后 |
|---|---|---|
| **群聊读取总开关** | 开 | 所有群一律不读；单群开关同时失效；定时任务空转 |
| 每个群的开关 | 全开 | 只跳过那一个群 |
| 每条私聊的开关 | **全关** | 默认就是关；勾上之后这条私聊才进入摘要流程 |

「一键放开所有私聊」在策略层被**直接判非法**（`private.defaultEnabled=true` → 策略作废 → 全关），
所以「私聊被读」只可能是你逐条点出来的结果。

## 与微信版的区别（别照抄微信那套）

| | dsh-wechat-digest | dsh-qq-digest（本插件） |
|---|---|---|
| 群聊 | 默认开，可关 | 默认开，可关，另有总开关 |
| 私聊 | 默认关，可开 | 默认关，**只能逐条打开**；一键全开会被判非法 |
| 句柄密钥之外的标识 | 原始 chat id 止于闸门 | 同，且**规范 id 也不外传**（水位线改用句柄做键） |

## 工具（四个，全部只读）

| 工具 | 作用 |
|---|---|
| `qq_digest_list_rooms` | 列出策略允许的群（只给不透明句柄 + 群名，不给群号） |
| `qq_digest_run_summary` | 立即跑一次增量总结。**没有入参**——触发不携带范围 |
| `qq_digest_get_digest` | 按句柄读摘要；不传句柄返回每个群最新一篇 |
| `qq_digest_status` | 数据源、策略是否降级、可用群数、上次运行结果 |

## 数据源（三选一，`QQ_DIGEST_SOURCE`）

| 源 | 默认 | 说明 |
|---|---|---|
| `bridge` | ✅ | 读本机 `qq-bridge` 的只读 HTTP 接口（`127.0.0.1:3100`）。**只覆盖机器人见过的会话** |
| `snowluma` | | 直连 SnowLuma OneBot HTTP（`127.0.0.1:3000`）。能枚举机器人所在的**所有群**，但要求网关在线 |
| `fixture` | | 内置假数据，含群 + 私聊 + 频道哨兵，用于验证隔离 |

**如实说明**：`bridge` 源只能看到「有消息进过桥接」的群。想覆盖全部群，要么开 `snowluma` 源（需网关在线），
要么让机器人在那些群里被 @ 过。这不是插件偷懒，是 QQ 侧取数的客观限制。

## 摘要器（`config.json` 的 `summarizer`）

- `llm`（默认）：OpenAI 兼容接口，结构化 JSON。密钥取 `QQ_DIGEST_LLM_API_KEY` 或 `~/.dsh/.credentials.yaml` 的 `DEEPSEEK_API_KEY`。
  失败**不静默降级**，直接抛 `LLM_*` 错误码。
  ⚠️ **知情提示**：选 `llm` 意味着被摘要的群/私聊**消息正文、昵称，以及被 @ 的 QQ 号**会发送到
  模型服务商（默认 `api.deepseek.com`）。不能接受这一点就选 `heuristic`（纯本地规则，不出网）。
  摘要是对**不可信输入**的加工结果：群成员可以往群名/正文里塞指令，摘要只能当数据看，不能当指令执行。
- `heuristic`：本地关键词规则，零网络零成本，质量有上限（会漏也会误抓）。

## 配置

`<DSH_HOME>/qq-digest/config.json`（默认 `<DSH_HOME>/qq-digest/config.json`）。
**每次工具调用都重读**，改完立即生效，不用重启。

```json
{
  "version": 1,
  "groups": {
    "group:70001111": { "enabled": true, "name": "客户对接群" }
  },
  "summarizer": "llm",
  "schedule": { "enabled": true, "kind": "weekly", "weekdays": ["MO","TU","WE","TH","FR"], "time": "09:00", "timeZone": "Asia/Shanghai" }
}
```

- 不写 `groups` = 所有群都可读。
- `groups` 里只用于**关掉**某个群或给它起名。
- `private` 是**受支持的一等键**：`{ "88880001": { "enabled": true } }` 逐条打开私聊；
  不允许一键全开（`private.defaultEnabled=true` 在策略解析阶段即判非法 → 全关）。
- 写出 `friend` / `send` / `reply` / `scope` / `write` 一类**危险键** → 整份配置作废 → **全关**（fail-closed）；
  与安全无关的未知键被忽略。
- 配置损坏同理：全关，不回退到「默认允许」。

## 落盘

`<DSH_HOME>/qq-digest/digests.jsonl`（每行一篇摘要）+ `watermarks.json`（增量水位线）。

落盘字段白名单：`roomHandle / roomTitle / digest / provenance / trigger / createdAt`。
写入代码里**不存在**「消息原文」和「原始会话 id」这两条路——不是过滤，是结构上不可能（有测试断言）。

## 验证

```bash
npm run verify                      # core 纯净性检查 + 全部用例（当前 116）
node scripts/smoke.mjs              # fixture 端到端（真实子进程走 MCP 协议）
node scripts/smoke.mjs bridge       # 真桥接只读冒烟
node scripts/host-smoke.mjs         # 宿主半：假 ctx 跑 apply()，真 req/res 打路由（含跨站/伪造 Host 用例）
node scripts/final-check.mjs        # 发布前自检（脱敏词从 QQ_DIGEST_SENSITIVE_PATTERNS 读，不写死在仓库里）
node scripts/prune-orphans.mjs      # 预览：清掉句柄对不上任何现存会话的「孤儿摘要」
node scripts/prune-orphans.mjs --apply  # 真正清理（自动备份）
```

core 纯净性检查锁定：`src/core/` 不许 import `node:fs` / 子进程 / 网络，不许出现 `fetch(`、`send_*`、`/api/send`、写文件符号。

## 设置页

插件装好后，在 **设置 → QQ 群摘要** 里：

| 区块 | 能改什么 |
|---|---|
| 群聊读取总开关 | 关掉后所有群一律不读，单群开关同时失效 |
| 参与总结的群 | 每个群一个开关 + 一个「群名」输入框。默认全开 |
| 私聊 | 每条一个开关 + 一个名字输入框，**默认全关**，逐条打开；勾上才读 |
| 摘要器 | 模型摘要 / 本地规则 |
| 定时执行 | 开关、每天或每周指定、星期几、时间、时区（默认 Asia/Shanghai） |
| 立即总结 | **顶部和底部各一个按钮，任何时候都可点**；有未保存改动会「先保存再跑」 |

保存走宿主同一套校验：非法时间、未知字段、任何私聊 id 一律 400 拒绝，不会落一份半合法配置。

**名字不能重复**：群和私聊**合并判定**（`trim` + 忽略大小写），空名字不参与。
面板会实时把重复的两个输入框标红并提示「重名」；真正拦下来的是宿主，
返回 `DUPLICATE_NAME：「X」同时被群 100000 和私聊 88880001 使用`，整份配置不落盘。

### 定时是怎么跑的

定时器在 DSH 宿主进程里，每 30 秒看一次表：

- 到点（`HH:MM` 精确命中）+ 今天还没跑过 → 抢跨进程锁 → 跑一轮 → 记 `schedule-state.json`
- **DSH 没在运行时不会跑**，也不会事后补跑（只在启动后 5 秒内补同一天同一分钟那一次）
- 和 MCP 工具的手动触发互斥：两边用同一个 `run.lock`，同时来只会跑一轮

### 为什么之前「看不见」

设置页这一项曾经注册失败，原因是 `slots` 服务**晚于** `apply` 发布：
读不到就 `return` 等于静默放弃 —— 插件显示「已安装」、接口一切正常，
但设置里永远没有这一项，且没有任何报错。现在改成和 `dsh-instruction-memory`
一样的做法：`ctx.slots ?? ctx.get('slots')`，读不到就每 50ms 重试，最多 20 次
（约 1 秒），仍然没有才 `console.error` 并上报。

配套加了**客户端心跳**，让这类问题不必再猜：

| 现象 | 含义 |
|---|---|
| `factoryAt` 有值 | 客户端 bundle 真的被执行了 |
| `mountedAt` 有值 | 设置页注册成功 |
| `failedAt` + `lastError` | 加载了但注册失败，错误原文就在里面 |
| 三个都没值 | 客户端 bundle 根本没加载（是列出问题，不是注册问题） |

`GET /qq-digest-api/state` 的 `clientBoot` 字段就是这份记录。

### 设置页背后的接口

`/qq-digest-api`（只接受回环地址）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/state` | 配置 + 群列表 + 上次执行情况 |
| POST | `/config` | 保存群开关/群名/摘要器/定时 |
| POST | `/run` | 立即跑一次 |
| GET | `/digest?group=<群号>` | 某个群的最新摘要 |

## 安装进 DSH

```bash
# 0) （可选）从 npm 拿包，或直接把本仓库放到任意目录
npm i dsh-qq-digest

# 1) MCP 行：给模型用的四个只读工具
node scripts/install.mjs --apply

# 2) bundle 行：设置页 + 定时器（宿主半 + 客户端半）
node scripts/link-profile.mjs --apply
```

第 1 步还会把本机 qq-bridge 的位置写进 `<DSH_HOME>/qq-digest/bridge-root.txt`
（源码里不硬编码任何绝对路径）。如果没自动找到，用 `--bridge-root=D:/path/to/qq-bridge` 指定。

**包内不含任何作者的个人信息**：QQ 号、群号、用户目录都是脱敏后的假值或运行时解析。

第 2 步**不走 pnpm**：本机 profile 的 `node_modules` 里有文件被占用
（`@img/sharp-win32-x64` 会在 pnpm 重装时报 `ERR_PNPM_EPERM`），所以这里用
junction + 手改 profile `package.json`（会自动备份），和本机 `dsh-instruction-memory` 的装法一致。

两块都要**重启 DSH** 才生效（Desktop 应用完全退出再打开）。

## 客户端半的加载契约（踩过的坑，别再踩）

```js
window.__ModuleLoader__.load({
  id: 'dsh-qq-digest',          // 必须等于包名 / loader entry 名
  factory: (require) => {       // require 是**参数**，不是全局
    const React = require('react');
    ...
    return module.exports;
  },
});
```

写成无参 IIFE `load((() => { ... })())` 会在浏览器里直接
`ReferenceError: require is not defined`，启动日志记成
`web boot: 1 entry did not activate / dsh-qq-digest: import failed`，
而 **宿主半完全正常**（接口照常响应）—— 只表现在「设置里没有这一项」，极易误判成没装上。
`test/client.test.js` 会在无浏览器环境里真的执行这个 bundle，把这条锁住。

主题色一律用 `--dsw-alias-*`（`--dsw-alias-border-l1` / `--dsw-alias-bg-layer-1` /
`--dsw-alias-label-secondary` / `--dsw-alias-brand-primary` / `--dsw-alias-state-*`），
不是 `--color-*`；写错不会报错，只会失去明暗主题适配。

## 自检

```bash
node scripts/verify-dsh.mjs      # 宿主半在线？客户端半上次启动有没有失败？落盘状态？
```

检查项与判定口径：

- 宿主半：API 200 + 群列表非空 + 策略未降级 + 数据源无报错
- 客户端半：最近一次 `crash-*-web-boot.log` 是否提到本插件；**如果那次 boot 早于 client.js 的修改时间，报 SKIP 而不是通过**（避免用旧日志证明新代码）
- 落盘：`config.json` 是否存在、`digests.jsonl` 有几条摘要

## 升级注意：0.1.x → 0.2.x 会换句柄密钥

0.1.x 的句柄密钥是源码里的公开常量（`qq-digest-local-dev-secret-…`），任何人拿到它就能离线算出任意房间的
句柄。0.2.0 起改为 `QQ_DIGEST_SECRET` 或 `<数据目录>/handle-secret`（首次启动随机生成）。

**代价必须说清楚**：旧摘要的 `roomHandle` 是用旧密钥算出来的，换密钥后**匹配不上任何当前句柄**，因此
- 老摘要仍然在 `digests.jsonl` 里，但读不到（`status.digestCount` 会大于 `status.visibleDigestCount`）；
- `watermarks.json` 的键（也是旧句柄）同样失效，**下一轮会把所有房间重新摘要一遍**。

这是刻意的取舍：不换密钥，旧句柄就一直可被外部计算出来，撤销语义也就无从谈起。
若要保留历史摘要，请在升级**之前**用 0.1.x 导出；升级之后只能整份丢弃 `digests.jsonl` 与 `watermarks.json` 重来。

## 已知限制（不美化）

- **设置页的开关不是安全边界**：`/qq-digest-api` 允许**本机进程**（包括模型通过 bash 起一个 `curl`）直接 POST 改配置。
  它挡住的是**浏览器与网络**，不是本机同一用户下的进程。
- 管理面已做的校验（`lib/index.js` 的 `denyUntrustedRequest`）：
  ① 来源必须是回环（`remoteAddress`）；② `Host` 必须是回环字面量（挡 DNS rebinding）；
  ③ `Origin` 必须是回环来源；④ `Sec-Fetch-Site: cross-site` 直接拒；
  ⑤ 写操作必须是 `application/json` —— 这个类型跨源必预检，而本服务不返回任何 CORS 头，
  于是 `<form>` / `text/plain` 的 CSRF 简单请求进不来。
- 反代 / 公网隧道仍会让 `remoteAddress` 看起来是回环：**不要把本插件挂在公网隧道后面**。
- 句柄密钥不再有源码默认值：`QQ_DIGEST_SECRET` → `<数据目录>/handle-secret`（首次启动随机生成并落盘）。
  写不进去就拒绝启动，而不是退回弱密钥。`/state` 的 `secretSource` 会如实告诉你当前用哪一种。
- 读取摘要会**按当前策略现算授权**：关掉某个群或关掉总开关之后，该群历史摘要立即读不到（本轮修复）。
  拒绝列表里返回的是 `auditRef`（独立 HMAC 域），它**不能**用来读任何摘要。
- 私聊只在 `bridge` 数据源下可用；`snowluma` 适配器只调群历史，没有私聊取数路径。
- `bridge` 源的群名是空的（桥接不存群名）；可在 `config.json` 的 `groups.<id>.name` 里人工命名。
- `bridge` 源每轮最多回看 **100 条**（桥接 `/api/messages` 的硬上限）。两次运行之间新增超过 100 条时，
  更早的那些会被跳过——水位线只记得住它实际读到的最后一条。别指望用它补历史。
- `bridge` 源看不到「机器人没收到过消息」的群。要覆盖全部群，得开 `snowluma` 源（需网关在线）。
- `snowluma` 源是 `stateless`：每轮全量重算固定窗口（默认 60 条）。原因是 OneBot 的 `message_id`
  不保证单调，拿它当水位线会静默漏读新消息。
- 句子级启发式摘要对「谁负责」判断保守：猜不准就回退成发消息的人，不做过度推断。
- `config.json` 的 `schedule` 由**宿主半自己**执行：`lib/index.js` 每 30s tick 一次，到点跑一轮
  （启动后 5s 还会补跑一次，避免刚好在到点后才启动而整天漏跑）。
  跨进程互斥用 `run.lock`（带心跳续租，长轮次不会被判成陈旧锁抢占）。
- 手动「立即总结」**不会**吞掉当天的定时：去重只认 `lastTrigger === "scheduled"` 的那一次。
- 未评估 QQ 侧 ToS 与账号风险；本插件只读本地桥接/网关接口，不额外登录。
- **`/state` 不再下发原始群号/QQ 号**：只给 `ref`（12 位 HMAC，设置页提交配置时用来反查会话）和
  `groupIdMasked` / `qqMasked`（例如 `700****111`）。服务端保存时重新枚举数据源反查 ref，不落任何映射表；
  兼容旧行为：直接送原始 id 或 `group:<数字>` 仍然接受（脚本用）。
- **手动触发有 60 秒最短间隔**（`QQ_DIGEST_MIN_RUN_INTERVAL_MS`，0 表示关闭），超限返回 `RATE_LIMITED`。
  定时触发不受限 —— 它本身已有每日去重，再限流会让到点那次被吞掉。
- 限流只覆盖「手动触发」的 60 秒最短间隔；跨天的总量配额仍未做。
