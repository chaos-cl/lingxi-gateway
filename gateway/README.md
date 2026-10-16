# 139灵犀 · OpenAI 兼容网关

把 139邮箱 AI工作台（灵犀/MClaw）的 10 个免费模型封装成标准 OpenAI API 的本地轻量网关。**零依赖**（纯 Node 18+，无需 `npm install`、无需浏览器、无需任何启动参数）。

```
OpenAI 客户端/Agent ──HTTP──▶ 本网关(127.0.0.1:8317) ──▶ ai.yun.139.com（139 AI 中台）
                                │
                                └──▶ smsrebuild10.mail.10086.cn（token 铸造，仅刷新时调用）
```

## 快速开始

```bash
# 1. 配置凭据（一次性）：把邮箱 sid + cookie 写入 credentials.json
#    （登录 mail.10086.cn → 打开 AI工作台 → DevTools 导出，详见下节）
# 2. 启动
node gateway/server.mjs
# 3. 使用
curl http://127.0.0.1:8317/v1/models
```

## 凭据获取（credentials.json）

```json
{ "sid": "03c5MTk0OTM...", "cookie": "RMKEY=xxx; JSESSIONID=xxx; ..." }
```

| 字段 | 获取方式 |
|---|---|
| `sid` | 登录邮箱打开 AI工作台后，webai iframe URL 里的 `sid=` 参数（或 localStorage 的 `userSid`） |
| `cookie` | `smsrebuild10.mail.10086.cn` 域请求携带的完整 Cookie 头（**必须含 RMKEY 等 httpOnly 项**，JS 读不到，需用 DevTools→Network 复制请求头，或浏览器插件/CDP 导出） |

也可用环境变量 `MAIL_SID` / `MAIL_COOKIE` 传入。凭据只在**铸造/刷新 token** 时用到（约 25 天一次），日常对话不依赖邮箱会话。

## 配置（config.json，可选）

```json
{ "port": 8317, "apiKey": "", "defaultModel": "blian_qwen38_flash" }
```

- `apiKey`：设置后客户端须带 `Authorization: Bearer <key>`（强烈建议暴露到局域网时开启）
- 环境变量优先：`GATEWAY_PORT` / `GATEWAY_API_KEY`

## API

### GET /v1/models

OpenAI 格式模型列表。模型名同时接受 `id`（如 `blian_qwen38_max`）、显示名（`qwen3.8-Max`）及常用写法（`glm-5.3`、`qwen3.8-max`、`deepseek-v4-pro`）。

| model id | 名称 | 输入上限 | 思考 |
|---|---|---|---|
| blian_qwen38_max | qwen3.8-Max | 800k | ✓ |
| huoshan_glm_5_3 | GLM-5.3 | 40k | 始终思考 |
| blian_qwen38_flash | qwen3.8-Flash | 800k | ✓ |
| blian_qwen37_plus / 36_plus / 35_plus | qwen3.x-Plus | 800k | ✓ |
| blian_deepseek_v4_pro / v4_flash | DeepSeek-V4 | 40k | ✓ |
| jiutian | 九天大模型 | 9k | ✗ |
| vlm_huoshan_2_0_lite_thinking_vision | Seed-2.0-Lite | 40k | ✓（视觉） |

### POST /v1/chat/completions

完全兼容 OpenAI 格式：

```bash
curl http://127.0.0.1:8317/v1/chat/completions -H "Content-Type: application/json" -d '{
  "model": "glm-5.3",
  "messages": [
    {"role": "system", "content": "你是一个简洁的助手"},
    {"role": "user", "content": "一句话介绍量子计算"}
  ]
}'
```

流式：`"stream": true`（SSE，与 OpenAI chunk 格式一致）；思考流映射为 `delta.reasoning_content`（DeepSeek 风格）。流式结束前**无条件**发送 `choices: []` 的 usage 块（OpenAI `include_usage` 语义），供客户端统计 token 与输出速度（TPS）——即使请求未带 `stream_options.include_usage`。

**思考开关**（自动归一化，任选其一）：

| 参数风格 | 示例 | 谁在用 |
|---|---|---|
| DashScope 布尔 | `"enable_thinking": true` | 通义系 SDK |
| Anthropic 对象 | `"thinking": {"type": "enabled"}` | **OpenBitFun**、Claude 风格客户端 |
| OpenAI 档位 | `"reasoning_effort": "medium"` | **OpenBitFun**（low/medium/high 任意值即开） |
| 布尔简写 | `"thinking": true` | 通用 |

`thinking.type: "disabled"` 显式关闭；不支持思考开关的模型（GLM-5.3 始终思考、九天）自动忽略。

**其他扩展参数**（非标准，可选）：

| 参数 | 作用 |
|---|---|
| `web_search: true` | 联网搜索，引用列表在 `x_citations` 字段返回 |
| `session_id: "..."` | 会话复用模式（也可用请求头 `x-139-session-id`） |

**会话模式**：

- **默认无状态**：每次请求新建会话，`messages` 全量渲染为单条输入。并发安全、兼容一切 OpenAI 客户端。
- **有状态复用**：传 `x-139-session-id`（首次从响应的 `x_139.session_id` 拿到），之后只发最新 user 消息，上下文由 139 服务端原生保持（省 token、真多轮）：

```bash
# 第一轮（响应里拿 x_139.session_id）
curl ... -d '{"model":"glm-5.3","messages":[{"role":"user","content":"我叫小明，喜欢蓝色"}]}'
# 第二轮（复用会话，模型记得上一轮）
curl ... -H "x-139-session-id: <上轮session_id>" \
          -d '{"model":"glm-5.3","messages":[{"role":"user","content":"我叫什么名字？"}]}'
```

响应附加元数据（`x_139` 字段 / 结束 chunk）：`session_id`、`model_used`（服务端实际模型）、`statement`（官方署名）、`citations`。

### 工具调用（function calling，文本协议模拟）

139 上游无原生 function calling。网关在**请求侧**把 `tools` 数组注入对话文本（qwen HERMES 模板风格），**响应侧**用流式状态机把模型输出的 `<tool_call>{"name":...,"arguments":{...}}</tool_call>` 块转回 OpenAI 结构化 `delta.tool_calls`（`finish_reason: "tool_calls"`）：

- 历史 `assistant.tool_calls` → 渲染为 `<tool_call>` 块；`role:"tool"` 结果 → `<tool_response>` 块，模型可正确续接多轮工具循环
- 跨 chunk 标签边界、markdown 围栏包裹、arguments 字符串/对象双形态、未闭合截断均有容错（非法块原样回退为正文文本）
- OpenBitFun / OpenAI SDK / Claude Code 等 agent 客户端可直接使用

### OpenAI SDK / Agent 接入

任何支持自定义 `base_url` 的客户端都能直接用：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8317/v1", api_key="any")
r = client.chat.completions.create(model="blian_qwen38_max", messages=[...])
```

Claude Code / 其他 Agent：配置 `OPENAI_BASE_URL=http://127.0.0.1:8317/v1` 即可。

## Token 生命周期（自动管理）

```
sid+cookie ──POST queryUserToken──▶ RCS token(≈25天) ──▶ Basic 头调 AI 接口
     ▲                                                        │
     └────────── 有效期前1天 / 收到401 时自动重铸 ◀────────────┘
```

- token 内存缓存，过期时间从 realToken 内嵌时间戳解析，提前 24h 主动刷新
- 重铸产生新 token，旧 token 过期前仍有效（互不影响进行中的流）
- `sid/cookie` 失效（重铸报错）→ 需重新登录邮箱导出一次凭据（唯一人工介入点）

## 重要说明与风险

1. **非官方接口**：协议来自网页端逆向，可能随服务端变更失效；请勿高并发滥用，有风控/封号风险
2. **模型是账号级全局状态**：网关内部已对"切模型→对话首包"加互斥锁保证并发正确；但切模型会同步影响你自己网页端 AI工作台的默认模型
3. `temperature`/`top_p` 等采样参数上游不暴露，会被忽略；`usage` 为按字符估算值
4. 内容经平台审核记录（`outAuditStatus`），勿传敏感数据
5. `credentials.json` 含登录凭据，注意文件权限，勿提交/外传

## 文件结构

```
gateway/
├── server.mjs        # HTTP 服务 + OpenAI 协议转换
├── upstream.mjs      # 139 上游客户端（模型切换互斥锁 + SSE 解析 + 认证重试）
├── token.mjs         # token 铸造/缓存/刷新
├── des.mjs           # DES-ECB 解密（原生 + 纯JS回退，Node24 免参数）
├── models.mjs        # 模型表 + 别名解析
├── config.mjs        # 配置加载
├── credentials.json  # 邮箱凭据（敏感）
└── config.json       # 可选运行配置
```
