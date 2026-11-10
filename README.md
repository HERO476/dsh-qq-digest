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
- 写出 `private` / `friend` / `send` / `scope` 一类键 → 整份配置作废 → **全关**（fail-closed）。
- 配置损坏同理：全关，不回退到「默认允许」。

## 落盘

`<DSH_HOME>/qq-digest/digests.jsonl`（每行一篇摘要）+ `watermarks.json`（增量水位线）。

落盘字段白名单：`roomHandle / roomTitle / digest / provenance / trigger / createdAt`。
写入代码里**不存在**「消息原文」和「原始会话 id」这两条路——不是过滤，是结构上不可能（有测试断言）。

## 验证

```bash
npm run verify            # core 纯净性检查 + 51 个用例
node scripts/smoke.mjs        # fixture 端到端（真实子进程走 MCP 协议）
node scripts/smoke.mjs bridge # 真桥接只读冒烟
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

这一步分两块，互不冲突（row id 不同）：

```bash
# 1) MCP 行：给模型用的四个只读工具
node scripts/install.mjs --apply

# 2) bundle 行：设置页 + 定时器（宿主半 + 客户端半）
node scripts/link-profile.mjs --apply
```

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

## 已知限制（不美化）

- **设置页的开关不是安全边界**：`/qq-digest-api` 只允许回环地址访问，但本机任何进程
  （包括模型通过 bash 起一个 `curl`）都能 POST 改配置。开关管的是「默认不读」，
  不是「别人改不了」。真要防，得给 API 加一次性的会话令牌，本期没做。
- 私聊只在 `bridge` 数据源下可用；`snowluma` 适配器只调群历史，没有私聊取数路径。
- `bridge` 源的群名是空的（桥接不存群名）；可在 `config.json` 的 `groups.<id>.name` 里人工命名。
- `bridge` 源每轮最多回看 **100 条**（桥接 `/api/messages` 的硬上限）。两次运行之间新增超过 100 条时，
  更早的那些会被跳过——水位线只记得住它实际读到的最后一条。别指望用它补历史。
- `bridge` 源看不到「机器人没收到过消息」的群。要覆盖全部群，得开 `snowluma` 源（需网关在线）。
- `snowluma` 源是 `stateless`：每轮全量重算固定窗口（默认 60 条）。原因是 OneBot 的 `message_id`
  不保证单调，拿它当水位线会静默漏读新消息。
- 句子级启发式摘要对「谁负责」判断保守：猜不准就回退成发消息的人，不做过度推断。
- `config.json` 里的 `schedule` 字段目前只是**描述性配置**：插件本身不注册定时任务。
  要每天自动跑，需要另外用 DSH 的 automation 建一条定时任务去调用 `qq_digest_run_summary`。
- 未评估 QQ 侧 ToS 与账号风险；本插件只读本地桥接/网关接口，不额外登录。
