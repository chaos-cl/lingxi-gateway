# 139邮箱 AI工作台（灵犀/MClaw）API 逆向分析与 sub2api 式封装方案

> 分析日期：2026-10-14 · 全部结论均已在真实账号上实测验证（含端到端无头调用）

## 一、总体结论

139邮箱网页版内置的「AI工作台」（产品名**灵犀 / MClaw**，入口 `appmail10.mail.10086.cn/webai/`）本质是一个标准的前端 SPA，其后端 AI 网关为 **`https://ai.yun.139.com/api/outer/assistant/*`**（中国移动云盘 AI 中台）。

核心事实：

| 项目 | 结论 |
|---|---|
| 对话接口 | `POST /api/outer/assistant/chat/v2/add`，**SSE 流式**返回 |
| 认证 | `Authorization: Basic base64("mobile:手机号:RCS令牌")`，**有效期约 25 天，可随时用邮箱 sid+cookie 重铸** |
| 模型 | 10 个免费模型（qwen3.8-Max 800k / GLM-5.3 / DeepSeek-V4 / 九天 / 视觉 Seed-2.0-Lite 等），**服务端用户级持久化**，切换靠 `POST /chat/config` |
| 多轮上下文 | **服务端按 sessionId 保持**，客户端每轮只发最新一条 |
| 附加能力 | 联网搜索（返回引用）、AI搜索（搜邮件/云盘/笔记）、个人知识库、深度思考（reasoning 流） |
| 可封装性 | ⭐⭐⭐⭐⭐ 已完成 Node 无头全链路验证（铸造 token → 对话 → SSE 重组答案），无浏览器依赖 |

---

## 二、认证链路（已完全逆向 + 重放验证）

### 2.1 铸造流程

```
邮箱登录 (sid + mail.10086.cn cookies)
   │
   ▼  POST（空 XML body，靠 smsrebuild10 域 httpOnly cookie 认证）
https://smsrebuild10.mail.10086.cn/file/disk?func=disk:queryUserToken&sid=<SID>&cguid=<任意>&randnum=<随机>
   │
   ▼  响应 {"code":"S_OK","var":{"data":{"data":{
        account: "<DES加密的手机号>",     token: "<RCS真实令牌>",
        userDomainId, routerInfo, ... }}}}
   │
   ▼  DES-ECB(key="139_mail", PKCS7) 解密 account → 手机号
   │
   ▼  Authorization: Basic base64("mobile:" + 手机号 + ":" + token)
   │
   ▼  携带此头调用 ai.yun.139.com 全部接口
```

- 请求头：`Content-Type: application/xml`、`Referer: https://smsrebuild10.mail.10086.cn/proxy_2.htm`、Cookie（关键：`RMKEY`、`JSESSIONID` 等 httpOnly cookie，JS 读不到，需 CDP 或浏览器导出）
- `cguid`/`randnum` 任意值即可
- RCS 令牌内嵌过期时间戳（如 `1794541322574` ≈ 2026-11-08，约 25 天），**每次铸造生成新令牌**，旧令牌在过期前始终有效（实测同时多个令牌可用）

### 2.2 token 有效期与刷新策略

| 凭据 | 有效期 | 刷新方式 |
|---|---|---|
| Basic token（RCS） | ~25 天（内嵌时间戳） | 重调 `queryUserToken` 即得新 token，随时可刷 |
| 邮箱 sid + cookies | 邮箱登录会话（勾选"保持登录"更长） | 失效需重新登录邮箱（人工/半自动） |

**建议**：封装服务启动时与每次收到 401/认证失败时重铸；token 内存缓存、按内嵌 expiry 提前 1 天刷新。

---

## 三、AI 网关接口清单（ai.yun.139.com）

所有接口通用请求头：

```
Authorization: Basic <铸造的token>
Content-Type: application/json
x-yun-api-version: v1
x-yun-client-info: 3g||30|||||||1920/1200|zh-CN||||
x-yun-app-channel: 10175
x-yun-tid: <随机uuid>
（SSE 接口另加）accept: text/event-stream
```

### 3.1 对话 `POST /api/outer/assistant/chat/v2/add` ⭐核心

请求体（实测最小可用集）：

```jsonc
{
  "applicationType": "chat",
  "sessionId": "",                    // 空=新建会话；复用=多轮续接（服务端保持上下文）
  "dialogueInput": {
    "dialogue": "用户消息文本",
    "inputTime": "2026-10-14T11:45:13+08:00",
    "commandType": 1,
    "enableForceNetworkSearch": false,  // 联网搜索开关（true 会强制搜索）
    "enableModelThinking": false,       // 深度思考开关（模型需支持）
    "enableAiSearch": false,            // AI搜索（搜邮件/云盘，服务端另一个流程）
    "enableKnowledgeAndNetworkSearch": false,
    "extInfo": "{\"pcVersion\":\"1.7.0\",\"h5Version\":\"3.2.0\",\"dialogueType\":\"noAiEditDialogue\"}"
    // attachment / aiWritingSetting / toolSetting 等可省略
  },
  "sourceChannel": "10175",
  "userId": "<userDomainId，铸造token时返回>",
  "continuationInfo": null
}
```

响应为 **SSE 流**（`text/event-stream`），事件格式：

```
id:1791949753822
retry:5000
event:AI-chat-sse-simple
data:{"success":true,"code":"0000","data":{
  "dialogueId":"1311992963040237063",
  "sessionId":"1311993021022549213",          // 首个事件返回，多轮时复用
  "flowResult":{
    "index":6,                                 // 递增序号
    "resultType":1,
    "outContent":"花共黄昏。",                   // 答案增量 delta（拼接得全文）
    "reasoningContent":"",                      // 思考增量 delta（思考模型）
    "modelType":"blian_qwen38_flash",           // 服务端实际使用的模型
    "finishReason":"processing"                 // processing → stop
  },
  // 仅首个事件携带：networkSearchInfoList:[{index,title,url,siteName}] 联网引用
  // 仅结束事件携带：responseStatement:"以上内容由qwen3.8-Flash模型生成"、
  //               recommend.queryList 跟进问题
}}
```

终止判定：`flowResult.finishReason === "stop"`。流结束直接 close，无 `[DONE]` 标记。
异常恢复：请求头可带 `last-event-id`（上个事件 id）断线续传（页面端如此实现，可选）。

### 3.2 模型设置 `POST /api/outer/assistant/chat/config` ⭐关键机制

```json
{"modelType":"blian_qwen38_flash","sourceChannel":"10175","modelThinkingStatus":false,"networkSearchStatus":true,"baseIdList":[]}
```

**模型是服务端持久化的用户级全局配置**——`add` 请求本身不带模型字段。切换模型 = 先调本接口，再发对话。实测：设置 `blian_qwen38_flash` 后对话回显 `modelType: blian_qwen38_flash`。

⚠️ 这意味着：**同一账号并发使用不同模型会互相覆盖**，封装层必须对「切模型→发消息」做原子化/串行化（见 §5.3）。

### 3.3 其他接口

| 接口 | 用途 | 要点 |
|---|---|---|
| `POST /chat/config/get` | 读配置+模型列表 | 响应 `modelList[]`，`defaultMode:1` 标记当前生效模型 |
| `POST /chat/v2/list` | 会话列表 | `pageInfo` 分页，返回 `sessionId,title,updateTime` |
| `POST /chat/v2/contentList` | 会话内全部轮次 | 按 `sessionId` 拉，含每轮输入/输出全文（导出/回放用） |
| `POST /knowledge/personal/v2/base/list` | 个人知识库列表 | 返回 baseId（可作 `baseIdList` 挂进对话） |
| `POST /accredit/get` | 授权状态 | `authStatus` |
| `POST /chat/v2/del` 等 | 会话管理 | （未逐一验证，按需探索） |

### 3.4 可用模型表（2026-10 实测，均免费）

| modelType | 显示名 | 最大输入 | 特性 |
|---|---|---|---|
| `blian_qwen38_max` | qwen3.8-Max | 800,000 字符 | 复杂任务、支持思考 |
| `huoshan_glm_5_3` | GLM-5.3 | 40,000 | 深度推理（服务端默认） |
| `blian_qwen38_flash` | qwen3.8-Flash | 800,000 | 轻量高频 |
| `blian_qwen37_plus` | qwen3.7-Plus | 800,000 | 跨模态 |
| `blian_qwen36_plus` | qwen3.6-Plus | 800,000 | 编程 |
| `blian_qwen35_plus` | qwen3.5-Plus | 800,000 | 多模态 |
| `blian_deepseek_v4_pro` | DeepSeek-V4-Pro | 40,000 | 逻辑推理、思考 |
| `blian_deepseek_v4_flash` | DeepSeek-V4-Flash | 40,000 | 低延迟、思考 |
| `jiutian` | 九天大模型 | 9,000 | 移动自研 |
| `vlm_huoshan_2_0_lite_thinking_vision` | Seed-2.0-Lite | 40,000 | 视觉理解 |

---

## 四、与 sub2api 的对照

sub2api 的模式是：**逆向目标服务的网页端/订阅端点 → 提取认证与协议 → 包装成 OpenAI 兼容 API 对外提供**。本项目完全同构：

| sub2api 概念 | 本项目对应 |
|---|---|
| 上游凭据（cookie/token） | 邮箱 sid+cookies → 铸造的 Basic token |
| 上游对话端点 | `chat/v2/add`（SSE） |
| 上游模型列表 | `chat/config/get` 的 modelList |
| OpenAI `/v1/models` | 直接映射 modelType ↔ 显示名 |
| OpenAI `/v1/chat/completions` | 见下节转换设计 |
| 流式协议转换 | `AI-chat-sse-simple` → OpenAI chunk |

---

## 五、封装设计（OpenAI 兼容网关）

### 5.1 对外接口

```
GET  /v1/models                 → modelList 映射
POST /v1/chat/completions       → stream / 非流式（SSE 重组）
（可选）GET /v1/sessions / GET /v1/sessions/:id/content   → 透传会话管理
```

### 5.2 messages → 139 请求的转换（两种模式）

**模式 A：无状态（默认，推荐）**
- 每次请求 `sessionId: ""` 新建会话
- 把 `messages[]` 渲染为单条 `dialogue` 文本：

```
[system content]（若有，置于开头作为背景说明）

用户：<msg1>
助手：<msg2>
用户：<latest user msg>
```

- 优点：完全无状态、并发安全、兼容一切 OpenAI 客户端；qwen 系 800k 字符容量足够长上下文
- 缺点：历史以文本形式注入（实测模型遵循良好），非服务端原生多轮

**模式 B：有状态会话复用（可选，供 agent 场景）**
- 调用方通过自定义头 `x-139-session-id`（或 `user` 字段哈希）指定会话
- 首轮建会话返回 sessionId，后续轮只发最新 user 消息，上下文由服务端保持
- 优点：原生多轮、token 消耗低；缺点：调用方需管理会话 id

### 5.3 模型切换的并发控制（本项目特有难点）

`chat/config` 是**用户级全局**设置，必须保证"设置模型 → 对话首包"之间不被其他请求的设置覆盖：

```
全局互斥锁（per-account）:
  lock()
    if (currentServerModel != requestedModel) POST /chat/config
    POST /chat/v2/add  →  收到首个SSE事件（服务端已锁定本次dialogue的模型）后 unlock()
  流式转发期间不再持锁（dialogueId 已绑定模型）
```

或按模型分队列串行；单模型场景可完全跳过 config 调用。

### 5.4 流式转换

```
139 SSE event                      →  OpenAI chunk
─────────────────────────────────────────────────
flowResult.outContent (delta)      →  choices[0].delta.content
flowResult.reasoningContent        →  delta.reasoning_content（DeepSeek 风格）
首事件 networkSearchInfoList        →  首个 chunk 的 x-citations / annotations 自定义字段
finishReason=stop                  →  finish_reason:"stop" + data: [DONE]
responseStatement / modelType      →  末 chunk 的 model / system_fingerprint 字段
```

### 5.5 参数映射

| OpenAI 参数 | 映射 |
|---|---|
| `model` | `chat/config.modelType`（映射表 §3.4） |
| `stream` | 是否重组（非流式=聚合全部 delta 后一次返回） |
| `messages` | 模式 A 渲染 / 模式 B 增量 |
| `temperature/top_p` 等 | 无对应参数，忽略（服务端不暴露） |
| 自定义 `enable_thinking` | `dialogueInput.enableModelThinking` |
| 自定义 `web_search` | `enableForceNetworkSearch`（引用随流返回） |

### 5.6 Token 生命周期管理

```
启动: 读配置(sid,cookies) → mint() → 缓存 {basic, userId, expiry}
每次上游调用: 携带 basic
收到 401/认证错误: mint() 重铸 → 重试一次
每日定时: 检查 expiry 提前刷新
sid 失效: 告警 → 人工重新登录邮箱更新 sid+cookies（或接入自动登录）
```

### 5.7 风险与限制（务必知悉）

1. **非官方接口**：中国移动未公开此 API，协议可能随时变更；大规模调用有风控/封号风险（埋点显示有 `hw_request` 请求量上报）
2. **账号级全局状态**：模型设置会同步影响你自己网页端的 AI工作台（切模型后网页端也变）
3. **内容审计**：响应含 `outAuditStatus` 字段，内容经平台审核/记录，勿用于敏感数据
4. **模型实际身份**：UI 显示名与后端模型能力未经官方证实（如"qwen3.8-Max"实际由火山方舟等供应，`blian_`/`huoshan_` 前缀暗示供应商路由）
5. `config/get` 偶发返回空 modelList（实测一次），需重试逻辑

---

## 六、实测验证记录

1. ✅ 浏览器内拦截全部请求（fetch/XHR/WS/SSE 四类补丁）
2. ✅ SSE 全量捕获与 delta 语义确认（outContent/reasoningContent 均为增量）
3. ✅ 模型切换端到端：UI 切 qwen3.8-Flash → `chat/config` → 流回显 `blian_qwen38_flash`
4. ✅ CDP 抓取跨域代理 iframe 的 token 铸造请求（`proxy_2.htm` 转发 `queryUserToken`）
5. ✅ **Node 无头全链路**：cookies+sid 重放铸造 → DES-ECB("139_mail") 解密手机号 → Basic 头 → `config/get` 与 `chat/v2/add` SSE 对话成功，答案完整重组
6. 抓包样本存于 `captures/`，可运行 PoC 见 `poc/headless-chat.mjs`

## 七、后续可深挖

- 视觉模型 `vlm_huoshan_2_0_lite_thinking_vision` 的图片上传协议（`attachment` 结构）
- AI搜索（`enableAiSearch`）封装为 `/v1/mail-search` 工具接口——这是该账号独有的私域能力（搜自己的邮件/云盘/笔记）
- AI写作、AI生成PPT、AI代码助手（webai 内置应用，各自有独立端点）
- 会话删除/重命名接口（`chat/v2/del` 等，按需抓取）
