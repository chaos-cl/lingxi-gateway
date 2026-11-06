#!/usr/bin/env node
/**
 * 可编程网关工厂（server.mjs 的薄壳与 desktop/Electron 主进程共用）
 *
 *   const gw = createGateway({ port, adminToken, onLog });
 *   await gw.start();
 *   ...
 *   await gw.stop();
 *
 * 端点：
 *   GET  /healthz                  健康检查（含 token 状态）
 *   GET  /v1/models                模型列表（OpenAI 格式）
 *   GET  /v1/models/:id            单模型
 *   POST /v1/chat/completions      对话（stream / 非流式）
 *   GET  /admin                    管理面板（静态页）
 *   *    /admin/api/*              管理 API（需 X-Admin-Token）
 *
 * 会话模式：
 *   默认无状态：每次请求新建 139 会话，messages 全量渲染为单条输入（并发安全）
 *   有状态复用：请求头 x-139-session-id 传会话 id，则只发最新 user 消息，
 *              上下文由 139 服务端保持；响应头/结束块会回传实际 session id
 *
 * 扩展参数（非 OpenAI 标准，可省略）：
 *   enable_thinking: true   深度思考（模型需支持，思考流映射到 delta.reasoning_content）
 *   web_search: true        联网搜索（引用列表随流返回）
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadConfig, GATEWAY_DIR } from "./config.mjs";
import { TokenManager } from "./token.mjs";
import { Upstream, UpstreamError, UA } from "./upstream.mjs";
import { MODELS, resolveModel, openaiModels } from "./models.mjs";
import { recordUsage, setUsageDir } from "./usage.mjs";
import { createAdminApi } from "./admin.mjs";

/** 版本号单一来源：package.json（打包进 asar 后位于 ../package.json，同样可读） */
function readOwnVersion() {
  try {
    return createRequire(import.meta.url)("../package.json").version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const GATEWAY_VERSION = readOwnVersion();

/* ---------------- 凭据 / 配置文件读写 ---------------- */

function readJsonFile(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

function writeJsonFile(file, obj, mode = 0o600) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode });
  try { fs.chmodSync(file, mode); } catch { /* ignore */ }
}

/**
 * 创建网关实例（不自动监听，需调用 start()）
 * @param {object} opts
 * @param {number} [opts.port]        覆盖配置端口
 * @param {string} [opts.dataDir]     凭据/配置/用量数据目录（默认 gateway/；桌面版传 userData）
 * @param {string} [opts.adminToken]  管理 API 令牌（缺省自动生成并落盘）
 * @param {(line:string)=>void} [opts.onLog] 日志回调（桌面 App 收集显示）
 */
// 供离线回归测试取用（工具调用解析器；由 createGateway 内部填充）
export const __internals = {};

export function createGateway(opts = {}) {
  const dataDir = opts.dataDir || GATEWAY_DIR;
  const CRED_FILE = path.join(dataDir, "credentials.json");
  const CONFIG_FILE = path.join(dataDir, "config.json");
  const DATA_SUBDIR = path.join(dataDir, "data");
  setUsageDir(DATA_SUBDIR);

  const creds = { ...readJsonFile(CRED_FILE), ...(opts.sid ? { sid: opts.sid } : {}), ...(opts.cookie ? { cookie: opts.cookie } : {}) };
  const cfgFile = readJsonFile(CONFIG_FILE);
  const envCfg = loadConfig(dataDir);
  const startedAt = Date.now();

  const config = {
    ...envCfg,
    ...(opts.port != null ? { port: Number(opts.port) } : {}), // 0 = 让系统分配空闲端口
  };

  // Token 落盘复用：铸造要求 cookie 新鲜、token 却有 ~25 天有效期，存盘后重启无需重新登录
  const tokens = new TokenManager({
    sid: creds.sid || config.sid,
    cookie: creds.cookie || config.cookie,
    cacheFile: path.join(DATA_SUBDIR, "token.json"),
  });
  const upstream = new Upstream(tokens);

  /* ---------------- 视觉支持：OpenAI image_url → 139 云盘 → attachment ----------------
   * 协议来自 webui 实抓（2026-11-07）：
   *   1. POST personal-kd-njs.yun.139.com/hcy/file/create 建目录链 /AI空间/灵犀互动记录/本地上传
   *      （fileRenameMode=refuse 幂等，exist:true 即已存在）—— 鉴权与 AI API 同一个 Basic token
   *   2. POST /hcy/file/create 建文件条目（sha256 + partInfos）→ data.exist=true 为秒传命中，
   *      直接用 data.fileId；否则拿 data.uploadId + partInfos[].uploadUrl（AWS SigV4 预签名）
   *      PUT 原始字节后 POST /hcy/file/complete
   *   3. 聊天体：command {command:"036",subCommand:"036006"} + attachment {attachmentTypeList:[3],
   *      fileList:[{fileId,parentFileId,name,type:"file",size}]}，qwen3.8-Max 等模型原生识图
   */
  const MCLOUD_BASE = "https://personal-kd-njs.yun.139.com";
  const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
  // 单次请求随对话送达的图片上限：agent 客户端（如 zcode）会把历史里的所有截图每轮重发，
  // 上游对超量 fileList 直接报「参数错误」——只保留最近的若干张（最早的截图对当前轮次价值最低）
  const IMAGE_MAX_PER_REQUEST = 6;
  const mcloudHeaders = (basic) => ({
    // 头集合与 webui 实抓对齐；x-yun-client-info 为必需头（缺失会被 hcy 判 04000003「请求头不合法」）
    Accept: "application/json, text/plain, */*",
    Authorization: basic,
    "Content-Type": "application/json;charset=UTF-8",
    "INNER-HCY-ROUTER-HTTPS": "1",
    "mcloud-channel": "1000101",
    "mcloud-client": "10904",
    "mcloud-network": "102",
    "mcloud-skey": "",
    "mcloud-version": "2.0.0",
    "User-Agent": UA,
    "x-DeviceInfo": "||||chrome|152.0.7977.130|||windows 10||zh-CN|||",
    "x-NetType": "4",
    "x-huawei-channelSrc": "10254500",
    "x-inner-ntwk": "2",
    "x-yun-api-version": "v1",
    "x-yun-app-channel": "10175",
    "x-yun-client-info": "||||chrome|152.0.7977.130|||windows 10||zh-CN|||",
    "x-yun-tid": crypto.randomUUID(),
    Origin: "https://appmail10.mail.10086.cn",
    Referer: "https://appmail10.mail.10086.cn/",
  });
  const uploadFolderId = { id: null };
  const uploadedImages = new Map(); // sha256 → { fileId, parentFileId, name, size }（同图去重：agent 循环每轮都重发图片，秒传靠这条缓存 + 平台 contentHash 去重）
  async function ensureUploadFolder() {
    if (uploadFolderId.id) return uploadFolderId.id;
    const { basic } = await tokens.get();
    let parent = "/";
    for (const name of ["AI空间", "灵犀互动记录", "本地上传"]) {
      const res = await fetch(MCLOUD_BASE + "/hcy/file/create", {
        method: "POST",
        headers: mcloudHeaders(basic),
        body: JSON.stringify({ parentFileId: parent, name, type: "folder", fileRenameMode: "refuse" }),
      });
      const j = await res.json().catch(() => null);
      if (!j || j.code !== "0000" || !j.data?.fileId) {
        throw new UpstreamError(`云盘目录创建失败（${name}）：${j ? JSON.stringify(j).slice(0, 150) : "HTTP " + res.status}`, { status: 502 });
      }
      parent = j.data.fileId;
    }
    uploadFolderId.id = parent;
    return parent;
  }
  async function uploadImage({ buffer, mime, name }) {
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const hit = uploadedImages.get(hash);
    if (hit) return hit;
    const { basic } = await tokens.get();
    const parentId = await ensureUploadFolder();
    const createRes = await fetch(MCLOUD_BASE + "/hcy/file/create", {
      method: "POST",
      headers: mcloudHeaders(basic),
      body: JSON.stringify({
        fileRenameMode: "auto_rename",
        contentType: "application/oct-stream",
        type: "file",
        name, size: buffer.length,
        contentHashAlgorithm: "sha256",
        contentHash: hash,
        partInfos: [{ parallelHashCtx: { partOffset: 0 }, partNumber: 1, partSize: buffer.length }],
        parentFileId: parentId,
      }),
    });
    const create = await createRes.json().catch(() => null);
    if (!create || create.code !== "0000" || !create.data?.fileId) {
      throw new UpstreamError(`图片上传失败（create）：${create ? JSON.stringify(create).slice(0, 150) : "HTTP " + createRes.status}`, { status: 502 });
    }
    const meta = create.data;
    if (!((meta.exist || meta.rapidUpload) && meta.fileId)) {
      // 秒传未命中（rapidUpload=false）：单分片直传（presigned URL 自带签名，无需鉴权头）→ complete。
      // 秒传两种形态都直接用 fileId：exist=true（同名同 hash 重复创建）、rapidUpload=true（同 hash 异名，平台已挂新条目）
      const part = (meta.partInfos || [])[0];
      if (!meta.uploadId || !part?.uploadUrl) throw new UpstreamError("图片上传失败（create 未返回 uploadId/uploadUrl）", { status: 502 });
      const put = await fetch(part.uploadUrl, { method: "PUT", body: buffer, headers: { "Content-Type": "application/oct-stream" } });
      if (!put.ok) throw new UpstreamError(`图片上传失败（对象存储 PUT ${put.status}）`, { status: 502 });
      const completeRes = await fetch(MCLOUD_BASE + "/hcy/file/complete", {
        method: "POST",
        headers: mcloudHeaders(basic),
        body: JSON.stringify({ fileId: meta.fileId, uploadId: meta.uploadId, contentHash: hash, contentHashAlgorithm: "sha256" }),
      });
      const complete = await completeRes.json().catch(() => null);
      if (!complete || complete.code !== "0000") {
        throw new UpstreamError(`图片上传失败（complete）：${complete ? JSON.stringify(complete).slice(0, 150) : "HTTP " + completeRes.status}`, { status: 502 });
      }
    }
    const out = { fileId: meta.fileId, parentFileId: meta.parentFileId || parentId, name: meta.fileName || name, size: buffer.length };
    uploadedImages.set(hash, out);
    if (uploadedImages.size > 64) uploadedImages.delete(uploadedImages.keys().next().value);
    return out;
  }
  /** OpenAI 图片 URL → { buffer, mime, ext }：支持 data:base64 与 https 下载 */
  async function decodeImageUrl(url) {
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(url || "").replace(/\s+/g, ""));
    if (m) {
      const buffer = Buffer.from(m[2], "base64");
      return { buffer, mime: m[1].toLowerCase(), ext: (m[1].split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg") };
    }
    if (/^https:\/\//i.test(url)) {
      const res = await fetch(url);
      if (!res.ok) throw new UpstreamError(`图片下载失败（HTTP ${res.status}）`, { status: 400 });
      const mime = (res.headers.get("content-type") || "image/png").split(";")[0].toLowerCase();
      const buffer = Buffer.from(await res.arrayBuffer());
      const extFromUrl = (/\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url) || [])[1];
      return { buffer, mime, ext: (extFromUrl || mime.split("/")[1] || "png").toLowerCase().replace("jpeg", "jpg") };
    }
    throw new UpstreamError("不支持的 image_url（仅支持 data:base64 与 https://）", { status: 400 });
  }
  /** 从 messages 里提取 OpenAI 视觉图片；stateless 多轮取全部 user 消息（去重后上传很便宜），会话模式只取最后一条 */
  function extractImageUrls(msgs, lastOnly) {
    const users = msgs.filter((m) => m.role === "user");
    const scope = lastOnly ? users.slice(-1) : users;
    const out = [];
    for (const m of scope) {
      if (!Array.isArray(m.content)) continue;
      for (const p of m.content) {
        if (p?.type !== "image_url") continue;
        const url = typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        if (url) out.push(url);
      }
    }
    return out;
  }

  const log = (line) => {
    console.log(line);
    try { opts.onLog?.(line); } catch { /* ignore */ }
  };

  // 管理令牌：优先显式传入 → 环境变量 → 落盘复用（App 与面板共享）
  const ADMIN_TOKEN_FILE = path.join(DATA_SUBDIR, "admin-token");
  let adminToken = opts.adminToken || process.env.GATEWAY_ADMIN_TOKEN || "";
  if (!adminToken) {
    try {
      adminToken = fs.readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
    } catch { /* 未生成过 */ }
    if (!adminToken) {
      adminToken = crypto.randomBytes(24).toString("base64url");
      try {
        fs.mkdirSync(path.dirname(ADMIN_TOKEN_FILE), { recursive: true });
        fs.writeFileSync(ADMIN_TOKEN_FILE, adminToken + "\n", { mode: 0o600 });
      } catch { /* ignore */ }
    }
  }

  /* ---------------- 会话全量日志（data/sessions/） ----------------
   * 每次对话请求落一个 JSON：完整上游输入（dialogue）、逐轮往返（输出/思考/finish/续写指令）、
   * 最终 tool_calls / usage / 错误现场。默认开启，保留最近 200 份，旧的自动清理；
   * GATEWAY_SESSION_LOG=0 或 config.json {"sessionLog": false} 关闭。 */
  const SESSIONS_DIR = path.join(DATA_SUBDIR, "sessions");
  const SESSION_KEEP = 200;
  const writeSessionLog = (rec) => {
    if (!rec) return;
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(path.join(SESSIONS_DIR, `${rec.ts.replace(/[:.]/g, "-")}-${rec.id || "req"}.json`), JSON.stringify(rec));
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json")).sort();
      for (const f of files.slice(0, Math.max(0, files.length - SESSION_KEEP))) {
        try { fs.unlinkSync(path.join(SESSIONS_DIR, f)); } catch { /* ignore */ }
      }
    } catch { /* 日志失败不影响请求 */ }
  };

  const getCredentials = () => readJsonFile(CRED_FILE, { sid: creds.sid || "", cookie: creds.cookie || "" });
  const saveCredentials = (c) => {
    creds.sid = c.sid ?? creds.sid;
    creds.cookie = c.cookie ?? creds.cookie;
    writeJsonFile(CRED_FILE, { sid: creds.sid, cookie: creds.cookie });
    log(`[admin] 凭据已更新（sid ${String(creds.sid).slice(0, 8)}…，cookie ${String(creds.cookie).split(";").length} 项）`);
  };
  const getConfig = () => ({ port: Number(process.env.GATEWAY_PORT || cfgFile.port || config.port), apiKey: process.env.GATEWAY_API_KEY ?? config.apiKey ?? "", defaultModel: cfgFile.defaultModel || config.defaultModel });
  const saveConfig = (patch) => {
    Object.assign(cfgFile, patch);
    writeJsonFile(CONFIG_FILE, cfgFile, 0o644);
    if (patch.apiKey !== undefined) config.apiKey = patch.apiKey;
    if (patch.defaultModel !== undefined) config.defaultModel = patch.defaultModel;
    if (patch.port !== undefined) config.port = patch.port;
  };

  /* ---------------- 工具 ---------------- */

/**
 * 思考开关解析：兼容各客户端的字段风格。
 *  - enable_thinking: true                    （DashScope/SiliconFlow 风格）
 *  - thinking: true                           （布尔简写）
 *  - thinking: {type:"enabled"|"disabled"}    （OpenBitFun/Anthropic 风格对象）
 *  - reasoning_effort: "low"|"medium"|"high"  （OpenAI 风格档位，出现即视为开思考）
 */
function resolveThink(parsed) {
  if (parsed.enable_thinking === true || parsed.thinking === true) return true;
  if (parsed.thinking && typeof parsed.thinking === "object") {
    const t = parsed.thinking.type || parsed.thinking.enabled;
    if (t === true || t === "enabled" || t === "on") return true;
    return false; // 显式 disabled 优先于 reasoning_effort
  }
  if (typeof parsed.reasoning_effort === "string") {
    return !["none", "off", "disable", "disabled", "minimal"].includes(parsed.reasoning_effort.trim().toLowerCase());
  }
  return false;
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((p) => p && p.type === "text").map((p) => p.text || "").join("\n");
  }
  return "";
}

function renderDialogue(messages) {
  const sys = messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => textOfContent(m.content).trim())
    .filter(Boolean)
    .join("\n");
  const rest = messages.filter((m) => m.role !== "system" && m.role !== "developer");
  if (!rest.length) throw new UpstreamError("messages 中缺少 user/assistant 消息", { status: 400 });
  if (rest.length === 1) {
    return (sys ? sys + "\n\n" : "") + textOfContent(rest[0].content).trim();
  }
  const lines = rest.map((m) => {
    // 工具调用轮次的文本化渲染（qwen HERMES 模板风格，供无原生 function calling 的上游理解）
    if (m.role === "tool") {
      return `<tool_response>\n${textOfContent(m.content).trim() || "（工具执行完成，无输出）"}\n</tool_response>`;
    }
    const calls = Array.isArray(m.tool_calls) && m.tool_calls.length
      ? "\n" + m.tool_calls.map(renderToolCallText).join("\n")
      : "";
    const body = textOfContent(m.content).trim();
    const label = m.role === "assistant" ? "助手" : "用户";
    return `${label}：${body}${calls}`;
  });
  // 按最后一条消息动态给出续写边界：agent 循环里最后一条往往是工具结果而非用户消息，
  // 固定的"回答最后一条用户消息"会误导模型重答旧问题或复述转录稿
  const lastIsTool = rest[rest.length - 1]?.role === "tool";
  const tail = lastIsTool
    ? "以上是一段多轮对话记录（其中 <tool_call> 是助手发起的工具调用，<tool_response> 是系统在工具执行后插入的结果）。对话记录以 <tool_response> 结束——请以「助手」身份从这里继续：基于该工具结果直接给出下一步，要么发起新的 <tool_call> 继续操作，要么给出最终回答。不要复述历史内容；<tool_response> 由系统插入，助手永远不会自己输出它。\n\n"
    : "以上是一段多轮对话记录（其中 <tool_call> 是助手发起的工具调用，<tool_response> 是系统在工具执行后插入的结果）。请以「助手」身份，直接回答最后一条用户消息。不要复述历史内容，也不要输出 <tool_response>（那不是助手的输出格式）。\n\n";
  return (
    (sys ? sys + "\n\n" : "") +
    tail +
    lines.join("\n")
  );
}

/** assistant.tool_calls（OpenAI 结构）→ <tool_call> 文本块 */
function renderToolCallText(tc) {
  const f = tc.function || {};
  let args = f.arguments ?? tc.arguments ?? {};
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { /* 保留原字符串 */ }
  }
  // 仍是字符串（原始 arguments 本身不是合法 JSON）→ 按字符串值渲染，保证历史示例是合法 JSON
  const argsStr = typeof args === "string" ? JSON.stringify(args) : JSON.stringify(args ?? {});
  return `<tool_call>\n{"name": ${JSON.stringify(f.name ?? tc.name ?? "")}, "arguments": ${argsStr}}\n</tool_call>`;
}

/** tools 数组（OpenAI 格式）→ 注入对话的工具说明（HERMES 风格，qwen 系原生遵循） */
function renderToolsPrompt(tools) {
  const lines = tools.map((t) => {
    const f = t.function || t;
    const params = JSON.stringify(f.parameters ?? f.input_schema ?? { type: "object" });
    return `- ${f.name}：${(f.description || "").trim()}\n  参数 JSON Schema：${params}`;
  }).join("\n");
  return (
    "\n\n# 可用工具\n\n" + lines +
    "\n\n# 工具调用规则\n" +
    "需要调用工具时，回复中只输出如下格式的调用块（可连续多个，不要输出任何解释性文字）：\n" +
    '<tool_call>\n{"name": "工具名", "arguments": {"参数名": 参数值}}\n</tool_call>\n' +
    "上述 JSON 必须严格合法：arguments 里字符串值内部的引号必须用反斜杠转义（\\\"）。例如 shell 命令：\n" +
    '<tool_call>\n{"name": "ExecCommand", "arguments": {"cmd": "grep \\"foo\\" file.txt"}}\n</tool_call>\n' +
    "需要连续调用多个工具时，每个调用必须用自己完整的 <tool_call>…</tool_call> 块包裹：不要省略中间的闭合标签，也不要在一个块内嵌套第二个 <tool_call>。\n" +
    "参数值里包含 Windows 路径或注册表键名时，反斜杠必须双写（如 \"C:\\\\Users\\\\x\"）；JSON 结构本身的引号（键名、分隔符）不要转义。\n" +
    "工具执行结果将以 <tool_response> 块返回给你，根据结果继续回答或再次调用。\n" +
    "单次工具调用的参数体积请控制在 6000 字符以内：大文件先写骨架，再用 Edit 分段补全（上游单次输出长度有限，过长会被截断）。\n" +
    "注意：JSON 的引号必须是半角 ASCII 双引号 \" ，不要用中文引号“”，冒号逗号也用半角 : , ，否则解析会失败。\n" +
    "只能调用上面「可用工具」清单里列出的工具。清单之外的工具一律不存在——禁止发明、猜测或使用其他名称（如 bash、terminal、run_command 等未列出的名字），否则调用会被客户端拒绝。\n" +
    "绝对不要自己输出 <tool_response> 块——那是系统在工具执行后插入的结果标记，不是你的输出格式；你只输出正文与 <tool_call>。\n" +
    "若无需使用工具，直接用文字回答。"
  );
}

/* ---- 幻觉工具名治理：语义别名 + 参数适配 ----
 * 上游模型偶尔无视清单输出训练先验里的工具名（bash / read_file / write_file…），
 * 原样透传会被客户端以 "Tool 'xxx' is not in the allowed list" 拒绝并中断 agent 循环。
 * 这里按 token 语义重叠把幻觉名映射到本次清单里最接近的工具，并把参数键适配到目标 schema。
 */

/** 幻觉名 token → 清单工具名 token 的强同义表（命中按 2 分计） */
const TOKEN_SYNONYMS = {
  bash: "exec command cmd shell terminal",
  shell: "exec command cmd bash",
  terminal: "exec command cmd shell console",
  console: "exec command cmd terminal",
  run: "exec execute command",
  execute: "exec run command",
  command: "cmd exec",
  cmd: "command exec",
  script: "exec command",
  cat: "read",
  view: "read show open",
  open: "read show view",
  show: "read view",
  load: "read",
  create: "write save",
  save: "write create",
  store: "write save",
  patch: "edit replace modify",
  modify: "edit replace update",
  update: "edit replace modify",
  replace: "edit modify patch",
  find: "grep glob search",
  search: "grep glob find",
  list: "glob ls",
  ls: "glob list",
  glob: "find list ls",
  fetch: "fetch url http",
  url: "fetch http",
  http: "fetch url",
  internet: "web search",
  websearch: "web search internet",
  agent: "task subagent spawn",
  task: "agent subagent",
  subagent: "agent task spawn",
  spawn: "agent task",
  todo: "todo task plan",
  notebook: "notebookedit notebook",
};

/** 工具名分词：camelCase / snake / kebab 统一拆开（ExecCommand → [exec, command]） */
const nameTokens = (s) =>
  String(s)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * 幻觉工具名 → 本次清单里语义最接近的工具。评分：token 精确命中 2 分，同义表命中 2 分；
 * 唯一最高分且 ≥2 才采纳（并列视为歧义，不映射）。
 */
function aliasTarget(name, allowedTools) {
  const A = nameTokens(name);
  if (!A.length) return null;
  const scored = allowedTools.map((allowed) => {
    const B = new Set(nameTokens(allowed));
    let score = 0;
    for (const t of A) {
      if (B.has(t)) { score += 2; continue; }
      const syn = String(TOKEN_SYNONYMS[t] || "").split(" ").filter(Boolean);
      if (syn.some((s) => B.has(s))) score += 2;
    }
    return { allowed, score };
  });
  const max = Math.max(0, ...scored.map((s) => s.score));
  if (max < 2) return null;
  const winners = scored.filter((s) => s.score === max);
  if (winners.length !== 1) return null; // 歧义不猜
  return winners[0];
}

/** 参数键的等义词族：幻觉参数键 → 目标 schema 里同族的键 */
const ARG_KEY_FAMILIES = [
  ["command", "cmd", "commandline", "commandline", "shellcommand", "shell_command", "terminalcommand", "terminal_command", "bashcommand", "bash_command", "script", "instruction", "cli"],
  ["path", "filepath", "file_path", "file", "filename", "location", "uri", "target", "dir", "directory"],
  ["content", "text", "data", "body", "source", "value", "input", "code", "payload", "newstring", "new_string", "replacement"],
  ["oldstring", "old_string", "oldtext", "old_text", "pattern", "query", "regex"],
  ["url", "link", "href", "address"],
  ["outputmode", "output_mode", "mode", "format"],
  ["limit", "count", "max", "topk", "top_k"],
  ["description", "desc", "message", "reason", "summary"],
  ["offset", "start", "begin", "from"],
  ["name", "toolname", "tool_name", "id", "key", "domain"],
];

const canonKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * 幻觉调用的参数 → 目标工具 schema 的键名适配（bash{command} → ExecCommand{cmd}）。
 * 只重命名键、不动值；无法归族的键保留原名（客户端一般容忍多余键）；
 * 目标 required 键缺失且恰好剩一个未匹配键时，把它映射为该 required 键。
 * 参数不是可解析对象时原样返回（changed=false），不强改。
 */
function adaptCallArgsToSchema(argsValue, fnDef) {
  const props = fnDef?.parameters?.properties;
  const required = Array.isArray(fnDef?.parameters?.required) ? fnDef.parameters.required : [];
  const result = { changed: false, arguments: null };
  if (!props || !Object.keys(props).length) return result;
  let args = argsValue;
  if (typeof args === "string") {
    try { args = JSON.parse(args); }
    catch { try { args = JSON.parse(repairJsonLoose(args)); } catch { return result; } }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return result;
  const canonProps = new Map(Object.keys(props).map((k) => [canonKey(k), k]));
  const out = {};
  const leftovers = [];
  for (const [k, v] of Object.entries(args)) {
    if (k in props) { out[k] = v; continue; }
    const direct = canonProps.get(canonKey(k));
    if (direct) { out[direct] = v; result.changed = true; continue; }
    const fam = ARG_KEY_FAMILIES.find((f) => f.some((x) => canonKey(x) === canonKey(k)));
    const hit = fam && Object.keys(props).find((p) => fam.some((x) => canonKey(x) === canonKey(p)));
    if (hit) { out[hit] = v; result.changed = true; continue; }
    leftovers.push([k, v]);
  }
  for (const req of required) {
    if (req in out) continue;
    if (leftovers.length === 1) { const [k, v] = leftovers.shift(); out[req] = v; result.changed = true; }
  }
  for (const [k, v] of leftovers) out[k] = v;
  const sameKeys = !result.changed
    && Object.keys(out).length === Object.keys(args).length
    && Object.keys(out).every((k) => k in args);
  if (!sameKeys) result.arguments = JSON.stringify(out);
  return result;
}

/**
 * 工具名归一器：把模型输出的畸形/幻觉工具名映射到本次请求的清单。
 * 层级：原样 → 前缀/命名空间剥离（tools__、functions.、mcp__srv__）→ 大小写 → 语义别名（含参数适配）→ 后缀匹配。
 * 全部落空则原样放行，让客户端明确报错而不是静默丢调用。
 */
function createToolCallNormalizer(tools, { log } = {}) {
  const allowedTools = tools.map((t) => t?.function?.name).filter((n) => typeof n === "string" && n);
  const allowedLower = new Map(allowedTools.map((n) => [n.toLowerCase(), n]));
  const schemaOf = (name) => tools.find((t) => (t?.function?.name || t?.name) === name)?.function ?? null;
  const normalize = (call) => {
    const fn = call?.function;
    if (!fn) return null;
    let name = String(fn.name || "").trim();
    if (!name) return null;
    if (!allowedTools.length || allowedTools.includes(name)) return call;
    let matched = "";
    const candidates = [
      name.replace(/^(?:tools?|functions?)__/i, ""),           // tools__CallDeferredTool → CallDeferredTool
      name.split(/[.:/]/).pop(),                                // functions.Read → Read
      name.replace(/^(?:tools?|functions?)[._-]/i, ""),
      name.replace(/^[\w.-]+?__/, ""),                          // mcp__server__tool → tool
    ];
    for (const c of candidates) {
      if (!c) continue;
      if (allowedTools.includes(c)) { matched = c; break; }
      const hit = allowedLower.get(c.toLowerCase());
      if (hit) { matched = hit; break; }
    }
    if (!matched) {
      const alias = aliasTarget(name, allowedTools);
      if (alias) matched = alias.allowed;
    }
    if (matched) {
      const adapted = adaptCallArgsToSchema(fn.arguments, schemaOf(matched));
      log?.(`[tools] 工具名归一: ${name} → ${matched}${adapted.changed ? "（参数键已适配）" : ""}`);
      fn.name = matched;
      if (adapted.arguments != null) fn.arguments = adapted.arguments;
      return call;
    }
    const tail = allowedTools.find((t) => t.toLowerCase().endsWith(name.split(/[.:/]/).pop().toLowerCase()));
    if (tail) { fn.name = tail; return call; }
    return call; // 未命中就原样放行，让客户端明确报错而不是静默丢调用
  };
  return { normalize, allowedTools };
}

/* ---- tool_choice 强制支持 ----
 * OpenAI 语义：required / {type:"function",function:{name}} 时模型必须发起工具调用。
 * 上游无原生支持 → 注入高优先级指令；非流式下若模型仍不调用，可带更强指令重试一次。
 */
function parseToolChoice(tool_choice, tools) {
  const names = tools.map((t) => t?.function?.name).filter((n) => typeof n === "string" && n);
  if (!names.length) return { forced: "", required: false };
  if (tool_choice === "required") return { forced: "", required: true };
  if (tool_choice && typeof tool_choice === "object") {
    const n = tool_choice?.function?.name || tool_choice?.name;
    if (typeof n === "string" && n.trim()) {
      const hit = names.find((x) => x === n || x.toLowerCase() === n.trim().toLowerCase());
      return { forced: hit || n.trim(), required: true };
    }
  }
  return { forced: "", required: false };
}

function renderToolChoiceDirective(choice) {
  if (!choice?.required) return "";
  if (choice.forced) {
    return (
      `\n\n# 强制工具调用（系统级要求，最高优先级）\n` +
      `本轮回复必须且只能发起对工具「${choice.forced}」的一次调用：立即输出 <tool_call> 块调用它，` +
      `不要输出任何解释、寒暄或纯文字内容。若缺少信息，也必须调用该工具并用合理值补全参数，无法推断的参数传空字符串。`
    );
  }
  return (
    `\n\n# 强制工具调用（系统级要求，最高优先级）\n` +
    `本轮回复必须从「可用工具」清单中选择最合适的一个发起调用（输出 <tool_call> 块），不允许输出纯文字回复。`
  );
}

/* ---- <tool_call> 文本流提取器：处理跨 chunk 边界，输出 text / tool_call 事件 ---- */
const TC_OPEN = "<tool_call>";
const TC_CLOSE = "</tool_call>";
const TR_OPEN = "<tool_response>"; // 助手永远不该输出；出现了=模型在复述/伪造转录稿，剥离
const TR_CLOSE = "</tool_response>";

/** 尾部与标签前缀的最大重叠长度（防止标签被 chunk 切断） */
function tagOverlap(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) if (s.endsWith(tag.slice(0, k))) return k;
  return 0;
}

/** 孤立闭合标签（qwen 连续多工具调用时多余的 </tool_call> 残骸）连同周边空白一并剥除 */
const STRAY_CLOSE_RE = /(?:\s*<\/tool_call>|\s*<\/tool_response>)+/g;

/**
 * 修复 JSON 字符串值内的裸引号/换行（模型输出 shell 命令等含双引号内容时的常见非法 JSON）。
 * 启发式：字符串内的引号若后面（跳过空白）不是 , } ] : 或结尾，则视为内容引号 → 转义。
 */
function repairUnescapedQuotes(s) {
  let out = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === "\\") { out += ch + (s[i + 1] ?? ""); i++; continue; }
    if (ch === '"') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      const next = s[j];
      if (next === undefined || next === "," || next === "}" || next === "]" || next === ":") {
        inStr = false;
        out += ch;
      } else {
        out += '\\"'; // 内容引号：模型漏转义
      }
      continue;
    }
    if (ch === "\n") { out += "\\n"; continue; }
    if (ch === "\r") continue;
    if (ch === "\t") { out += "\\t"; continue; }
    out += ch;
  }
  return out;
}

/**
 * <tool_call> 块 → OpenAI tool_call 结构。
 * 上游模型会混用三种方言，必须全部支持：
 *   1) JSON：       {"name":"Edit","arguments":{...}}
 *   2) HERMES XML： <function=Read>\n<parameter=path>\n/a.txt\n</parameter>\n</function>
 *   3) invoke XML： <invoke name="Edit"><parameter name="file_path">…</parameter>
 * 一个块内可能有多个并行调用，故返回数组。
 */
function mkToolCall(name, args, index) {
  return {
    id: "call_139_" + crypto.randomUUID().slice(0, 8),
    index,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) },
  };
}

/** <parameter=KEY>value</parameter> 或 <parameter name="KEY">value</parameter> 序列 → 对象 */
function parseXmlParams(body) {
  const args = {};
  const re = /<parameter\s*(?:=\s*([^>\s]+)|name\s*=\s*["']([^"']+)["'])\s*>/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ key: (m[1] || m[2] || "").trim(), start: re.lastIndex, tagStart: m.index });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].tagStart : body.length; // 值止于下一个标签的起始 '<'
    let val = body.slice(marks[i].start, end);
    // 逐层剥掉尾部堆叠的闭合标签（</parameter>\n</function> 这种）——
    // 链式单次替换会漏掉先被上层标签"曝光"出来的内层闭合标签，导致参数值粘上 </parameter> 残骸
    let prev;
    do {
      prev = val;
      val = val.replace(/(?:<\/parameter>|<\/function>|<\/invoke>|<\/tool_call>)\s*$/i, "");
    } while (val !== prev);
    val = val.replace(/^\r?\n/, "").replace(/\s+$/, "");
    if (marks[i].key) args[marks[i].key] = val;
  }
  return args;
}

/** qwen HERMES：<function=NAME> … </function>，可连续多个 */
function parseHermesCalls(raw) {
  const out = [];
  const re = /<function\s*(?:=\s*([^>\s]+)|name\s*=\s*["']([^"']+)["'])\s*>\s*([\s\S]*?)(?=<\/function>|(?=<function\s*(?:=|name\s*=))|$)/g;
  let m;
  while ((m = re.exec(raw))) out.push({ name: (m[1] || m[2] || "").trim(), args: parseXmlParams(m[3] || "") });
  return out.filter((c) => c.name);
}

/** Anthropic 风格：<invoke name="NAME">…</invoke>（模型常省略 </invoke>） */
function parseInvokeCalls(raw) {
  const out = [];
  const re = /<invoke\s+name\s*=\s*["']([^"']+)["']\s*>\s*([\s\S]*?)(?=<\/invoke>|(?=<invoke\s)|$)/g;
  let m;
  while ((m = re.exec(raw))) out.push({ name: m[1].trim(), args: parseXmlParams(m[2] || "") });
  return out.filter((c) => c.name);
}

/** 修掉字符串里的裸换行/Tab 与尾随逗号——模型写多行代码时常犯 */
function repairJsonLoose(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") continue;
      if (c === "\t") { out += "\\t"; continue; }
    }
    out += c;
  }
  return out.replace(/,\s*([}\]])/g, "$1");
}

/** 把 {"name":"tool_call","arguments":{"name":"Read","arguments":{...}}} 这类包装层剥开 */
function unwrapNested(c, depth = 0) {
  const WRAPPER = /^(tool_calls?|tools?|functions?|invoke|call|arguments|parameters)$/i;
  if (depth > 3 || !WRAPPER.test(c.name)) return c;
  const a = c.args;
  if (!a || typeof a !== "object") return c;
  const nextName = a.name ?? a.tool_name ?? a.toolName ?? a.function ?? a.tool;
  if (typeof nextName !== "string" || !nextName.trim()) return c;
  let nextArgs = a.arguments ?? a.parameters ?? a.params ?? a.args ?? a.input ?? {};
  if (typeof nextArgs === "string") {
    try { nextArgs = JSON.parse(nextArgs); } catch { try { nextArgs = JSON.parse(repairJsonLoose(nextArgs)); } catch { /* 保持原样 */ } }
  }
  return unwrapNested({ name: nextName.trim(), args: nextArgs }, depth + 1);
}

/** 中文/排版引号（“ ” „ ″）→ ASCII 引号：只在结构位置转换，正文里的中文引号原样保留 */
function repairSmartQuotes(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\u201c" || c === "\u201d" || c === "\u201e" || c === "\u2033") {
      let p = i - 1;
      while (p >= 0 && /\s/.test(s[p])) p--;
      const prev = p >= 0 ? s[p] : "";
      let n = i + 1;
      while (n < s.length && /\s/.test(s[n])) n++;
      const next = n < s.length ? s[n] : "";
      const openCtx = prev === ":" || prev === "," || prev === "{" || prev === "[" || prev === "";
      const closeCtx = next === "," || next === "}" || next === "]" || next === ":" || next === "";
      if (openCtx || closeCtx) { out += '"'; continue; } // 当成字符串定界符
    }
    out += c; // 正文中的“引号”保留
  }
  return out;
}

/**
 * 过度转义修复：模型把 JSON 结构引号也转义了（PowerShell 嵌套引号场景），
 * 如 `Sort-Object\",\"description\":\"List ...\"}}`。
 *   - 字符串内 `\"` 且其后（跳过空白）是 , } ] → 视为字符串真正的结束符；
 *   - 字符串外 `\"` → 还原为结构引号。
 */
function repairOverEscapedQuotes(s) {
  let out = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!inStr) {
      if (c === "\\" && s[i + 1] === '"') { out += '"'; i++; continue; }
      if (c === '"') inStr = true;
      out += c;
      continue;
    }
    if (c === "\\" && s[i + 1] === '"') {
      let j = i + 2;
      while (j < s.length && /\s/.test(s[j])) j++;
      const n = s[j];
      if (n === "," || n === "}" || n === "]") { out += '"'; inStr = false; i++; continue; }
      out += '\\"'; i++; continue;
    }
    if (c === '"') { inStr = false; out += c; continue; }
    out += c;
  }
  return out;
}

/** 字符串值忘写引号修复（"description":裸文字, 形态）：值以字母开头时补上引号。兜底变体。 */
function repairUnquotedValue(s) {
  return s.replace(/(:\s*)([A-Za-z][^"{}\[\]\n]*?)"(?=\s*[,}\]])/g, (_m, p1, p2) => `${p1}"${p2}"`);
}

/** 全角标点 → 半角（只在字符串外转换，结构位置的 ：，｛｝ 会让 JSON 直接失败） */
function repairFullWidth(s) {
  let out = "", inStr = false, esc = false;
  for (const c of s) {
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr) {
      if (c === "\uff1a") { out += ":"; continue; }  // ：
      if (c === "\uff0c") { out += ","; continue; }  // ，
      if (c === "\uff5b") { out += "{"; continue; }  // ｛
      if (c === "\uff5d") { out += "}"; continue; }  // ｝
      if (c === "\uff1d") { out += "="; continue; }  // ＝
    }
    out += c;
  }
  return out;
}

/**
 * 结构性补全：字符串都已闭合、只差少量 } / ]（模型常少写一个右括号）。
 * 超过 3 层或字符串本身没闭合（=真截断，payload 不完整）则拒绝，避免写坏文件。
 */
function autoCloseJson(s) {
  let inStr = false, esc = false;
  const depth = [];
  for (const c of s) {
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{" || c === "[") depth.push(c);
    else if (c === "}" || c === "]") depth.pop();
  }
  if (inStr || esc || !depth.length || depth.length > 3) return null;
  let out = s.replace(/[,\s]+$/, "");
  for (let i = depth.length - 1; i >= 0; i--) out += depth[i] === "{" ? "}" : "]";
  return out;
}

/**
 * 修复 JSON 字符串里的非法转义（线上 Windows 样本：E:\bf\OLDSSD500\炎龙… 的路径反斜杠）。
 *  - \X（X 不是合法转义字符）→ \\X：如 \炎、\O、\y（不修则 JSON.parse 直接失败）
 *  - 驱动器路径上下文（含 E:\ / C:\ 的字符串）里 \b\f\r\t\n 也按路径分隔符处理 → \\X：
 *    否则 \b 被解析成退格符、\n 被解析成换行，路径被静默改写、调用"成功"地打错地方
 *    （丢换行是可见失败会触发模型重试，路径改写是隐蔽错误，宁可前者）
 *  - \u 后面不是 4 位十六进制（如 \users）→ \\u
 */
function repairInvalidEscapes(s) {
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s[i] !== '"') { out += s[i++]; continue; }
    // 找字符串结束（尊重转义），整段交给 repairStrEscapes
    let j = i + 1;
    while (j < s.length) {
      if (s[j] === "\\") { j += 2; continue; }
      if (s[j] === '"') break;
      j++;
    }
    const seg = s.slice(i, j + 1);
    const isDrive = /[A-Za-z]:\\/.test(seg);
    let body = "";
    for (let k = 1; k < seg.length - 1; k++) {
      const c = seg[k];
      if (c !== "\\") { body += c; continue; }
      const n = seg[k + 1] ?? "";
      if (n === "") { body += c; continue; }
      if (!'"\\/:bfnrtu'.includes(n)) { body += "\\\\" + n; k++; continue; }
      if (isDrive && "bfrtn".includes(n)) { body += "\\\\" + n; k++; continue; }
      if (n === "u" && !/^[0-9a-fA-F]{4}/.test(seg.slice(k + 2, k + 6))) { body += "\\\\u"; k++; continue; }
      body += c + n; k++;
    }
    out += '"' + body + (j < s.length ? '"' : "");
    i = j + 1; // 跳过闭合引号（未闭合则跳到末尾）
  }
  return out;
}

/** JSON 客体/数组：依次尝试渐进式修复（弯引号 / 全角标点 / 非法转义 / 裸换行 / 尾逗号 / 未转义引号 / 过度转义 / 忘写值引号 / 结构补全） */
function parseJsonCalls(raw) {
  const tryParse = (s) => {
    const variants = [];
    const add = (x) => { if (x != null && !variants.includes(x)) variants.push(x); };
    // 先于原串尝试：\n/\t/\b 是合法转义，原串可能"成功"解析但值被静默污染（E:\temp → E:<TAB>emp）
    const esc0 = repairInvalidEscapes(s);
    add(esc0);
    add(s);
    const sq = repairSmartQuotes(s);
    add(sq);
    const fw = repairFullWidth(sq);
    add(fw);
    const esc = repairInvalidEscapes(fw);
    add(esc);
    const loose = repairJsonLoose(esc);
    add(loose);
    add(repairUnescapedQuotes(loose));
    add(repairUnescapedQuotes(repairJsonLoose(s))); // 不走弯引号修复的兜底
    add(autoCloseJson(loose));                       // 只差右括号：补全后通常能拿到完整参数
    add(repairInvalidEscapes(loose));                // Windows 裸反斜杠路径（E:\bf\...，模型忘写双反斜杠）
    add(repairOverEscapedQuotes(loose));             // 结构引号被过度转义（PowerShell 嵌套引号场景）
    add(repairUnquotedValue(loose));                 // 字符串值忘写引号（"description":裸文字）
    for (const v of variants) {
      try { return JSON.parse(v); } catch { /* 继续尝试 */ }
    }
    return null;
  };
  /** 解析成功的对象 → 调用列表（拆包装层） */
  const toCalls = (obj) => {
    const list = Array.isArray(obj) ? obj : Array.isArray(obj.tool_calls) ? obj.tool_calls : [obj];
    const out = [];
    for (const it of list) {
      const name = it?.name ?? it?.function?.name ?? it?.tool_name;
      if (!name || typeof name !== "string") continue;
      let args = it.arguments ?? it.function?.arguments ?? it.parameters ?? it.args ?? {};
      if (typeof args === "string") { const p = tryParse(args); if (p) args = p; }
      out.push(unwrapNested({ name: name.trim(), args }));
    }
    return out;
  };
  let obj = tryParse(raw);
  if (obj) return toCalls(obj);
  // 整块解析失败：逐个扫描顶层配对 JSON 区域（覆盖"前后杂文字包裹单调用"与
  // "块内多个并列调用/嵌套第二个 <tool_call>"两类，线上 Windows 样本均出现过）
  const calls = [];
  let i = raw.indexOf("{");
  while (i >= 0) {
    const end = scanBalancedJson(raw, i);
    if (end < 0) {
      // 最后一个未闭合（上游截断）：结构能补全就补全；
      // 补不出时若前面已找回调用则静默补发空参数骨架，否则返回空走「截断提示 + 补发」路径（给模型留重试指引）
      const tail = raw.slice(i);
      const closed = autoCloseJson(repairSmartQuotes(repairInvalidEscapes(tail)));
      const objs = closed ? tryParse(closed) : null;
      if (objs) { calls.push(...toCalls(objs)); break; }
      if (calls.length) {
        const nm = (tail.match(/"name"\s*:\s*["“”']([^"“”'\s}]+)/) || [])[1];
        if (nm) calls.push(unwrapNested({ name: nm.trim(), args: {} }));
      }
      break;
    }
    const regionObj = tryParse(raw.slice(i, end));
    if (regionObj) calls.push(...toCalls(regionObj));
    i = raw.indexOf("{", end);
  }
  return calls;
}

/**
 * 杂交方言（线上 Windows 样本）：模型把 HERMES 的 <function=NAME> 错写成 <parameter=NAME>，
 * 参数整体塞进 <parameter=arguments>{"cmd":…}</parameter>，结尾 </function> 还在。
 * 形态：<parameter=ExecCommand></parameter><parameter=arguments>{…}</parameter></function>
 */
function parseParameterWrapperCalls(raw) {
  const pairs = [];
  const re = /<parameter\s*(?:=\s*([^>\s]+)|name\s*=\s*["']([^"']+)["'])\s*>([\s\S]*?)<\/parameter>/g;
  let m;
  while ((m = re.exec(raw))) pairs.push({ key: (m[1] || m[2] || "").trim(), val: m[3] ?? "" });
  const out = [];
  for (let i = 0; i + 1 < pairs.length; i++) {
    const a = pairs[i], b = pairs[i + 1];
    if (a.val.trim() || b.key.toLowerCase() !== "arguments") continue;
    let args = null;
    try { args = JSON.parse(b.val); }
    catch { try { args = JSON.parse(repairJsonLoose(repairInvalidEscapes(b.val))); } catch { continue; } }
    if (args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length) {
      out.push({ name: a.key, args });
    }
  }
  return out;
}

/** 块内容 → tool_call 数组（按方言优先级尝试） */
function parseToolCallBlock(inner, index) {
  const raw = String(inner || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  if (!raw) return [];
  for (const group of [parseHermesCalls(raw), parseInvokeCalls(raw), parseParameterWrapperCalls(raw), parseJsonCalls(raw)]) {
    if (group.length) return group.map((c, i) => mkToolCall(c.name, c.args, index + i));
  }
  return [];
}

/** 是否看起来是工具协议残片（而非正常正文） */
function looksLikeProtocol(s) {
  return /<function\s*=|<\/function>|<parameter\s*=|<\/parameter>|<invoke\s|"arguments"\s*:/.test(String(s || ""));
}

/**
 * 工具协议残片的诊断提示：区分「被截断」与「格式不合法」，各自给出可执行的纠正方式。
 * 返回 name 时调用方会补发一个空参数调用，保证 agent 循环不被掐断。
 */
function toolCallFailure(inner, { closed = false } = {}) {
  const s = String(inner || "");
  // 留档：解析失败的原始块写到 data/failed-toolcalls/（保留最近 20 份），便于事后定位是哪种畸形；
  // 另可用 LINGXI_CAPTURE_DIR 指定目录。
  const dumpDirs = [process.env.LINGXI_CAPTURE_DIR, path.join(DATA_SUBDIR, "failed-toolcalls")].filter(Boolean);
  for (const dir of dumpDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `failed-${Date.now()}.txt`), s);
      const old = fs.readdirSync(dir).filter((f) => /^failed-\d+\.txt$/.test(f)).sort().slice(0, -20);
      for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
      break; // 成功一处即可
    } catch { /* 忽略留档失败 */ }
  }
  const name =
    (s.match(/<function\s*(?:=\s*|name\s*=\s*["'])([^"'>\s]+)/) || [])[1] ||
    (s.match(/<invoke\s+name\s*=\s*["']([^"']+)["']/) || [])[1] ||
    (s.match(/"name"\s*:\s*["“”']([^"“”'\s]+)["“”']/) || [])[1] || "";
  const who = name ? `（${name}）` : "";
  const text = closed
    ? `\n[网关] 工具调用格式不完整${who}：该块 ${s.length} 字符但参数无法解析（常见原因：JSON 与 XML 标签混用、引号未转义）。已丢弃参数并重新发起该调用，请补全参数后重试。\n`
    : `\n[网关] 工具调用被截断${who}：输出在 ${s.length} 字符处中断（未出现闭合标签）。已丢弃参数并重新发起该调用，请缩小单次调用的参数体积或分段写入。\n`;
  return { name, text };
}

class ToolCallExtractor {
  /**
   * @param {string[]|null} allowedNames 本次请求提供的工具名；给了才启用裸 JSON 识别（避免误吃正文）
   * @param {(name:string)=>boolean} [canAlias] 幻觉工具名是否可被语义别名兜住；
   *   给了才对「清单外但可别名」的裸 JSON 也按调用识别（<tool_call> 包裹路径由 normalizer 统一处理）
   */
  constructor(allowedNames = null, canAlias = null) {
    this.pend = ""; this.inCall = false; this.inResp = false; this.nextIndex = 0;
    this.allowed = Array.isArray(allowedNames) && allowedNames.length ? allowedNames : null;
    this.canAlias = typeof canAlias === "function" ? canAlias : null;
  }
  /** 名字是否属于本次请求的工具（容忍 tools__ 前缀与大小写；可别名兜底的幻觉名也算） */
  _nameOk(name) {
    if (!this.allowed) return false;
    const n = String(name || "").trim();
    if (!n) return false;
    const short = n.replace(/^(?:tools?|functions?)__/i, "").split(/[.:/]/).pop();
    if (this.allowed.some((a) => a === n || a === short || a.toLowerCase() === short.toLowerCase())) return true;
    return !!(this.canAlias && this.canAlias(n));
  }
  /** 尝试把缓冲里的裸 JSON 当作工具调用；返回 { events, consumed } 或 null（需等待更多数据） */
  _tryBareJson(final) {
    if (!this.allowed) return null;
    const m = BARE_JSON_RE.exec(this.pend);
    if (!m) return null;
    const start = m.index;
    const end = scanBalancedJson(this.pend, start);
    if (end < 0) {
      // 未闭合：可能还在流里；超过 64KB 说明不是调用，放弃识别
      if (!final && this.pend.length - start <= 65536) return { events: [], consumed: 0, wait: true };
      if (final) {
        // 流已结束仍不闭合 → 按"少右括号/被截断"处理：能补全就补，补不出就给空参数补发
        const tailRaw = this.pend.slice(start);
        const closed = autoCloseJson(repairSmartQuotes(tailRaw));
        // 能补全就走补全；补不出也把原始尾巴过一遍完整修复链（平衡但非法的 JSON 可能在这一步被救回）
        const fixed = closed ? parseToolCallBlock(closed, this.nextIndex) : parseToolCallBlock(repairSmartQuotes(tailRaw), this.nextIndex);
        const events2 = [];
        const before2 = this.pend.slice(0, start).replace(/```(?:json)?\s*$/i, "");
        if (before2) events2.push({ type: "text", text: before2 });
        if (fixed.length && fixed.every((c) => this._nameOk(c.function.name))) {
          for (const c of fixed) events2.push({ type: "tool_call", call: c });
          this.nextIndex += fixed.length;
        } else {
          const nameM = tailRaw.match(/"name"\s*:\s*["“”']([^"“”'\s]+)/);
          const fail = toolCallFailure(tailRaw, { closed: false });
          events2.push({ type: "text", text: fail.text });
          if (nameM && this._nameOk(nameM[1])) events2.push({ type: "tool_call", call: mkToolCall(nameM[1], {}, this.nextIndex++) });
        }
        return { events: events2, consumed: this.pend.length, wait: false };
      }
      return null;
    }
    const events = [];
    const before = this.pend.slice(0, start).replace(/```(?:json)?\s*$/i, "");
    if (before) events.push({ type: "text", text: before });
    const candidate = this.pend.slice(start, end);
    const calls = parseToolCallBlock(candidate, this.nextIndex);
    if (calls.length && calls.every((c) => this._nameOk(c.function.name))) {
      for (const c of calls) events.push({ type: "tool_call", call: c });
      this.nextIndex += calls.length;
      let rest = this.pend.slice(end);
      rest = rest.replace(/^\s*```/, ""); // 被 ```json 包裹时去掉收尾围栏
      return { events, consumed: end + (this.pend.slice(end).length - rest.length), wait: false };
    }
    if (!calls.length) {
      // 裸 JSON 确实命中（BARE_JSON_RE + 名字在清单）却解析失败（畸形/截断）：
      // 走失败流程给提示 + 空参数补发，绝不把协议残片当正文泄漏
      const nm = (candidate.match(/"name"\s*:\s*["“”']([^"“”'\s}]+)/) || [])[1];
      if (nm && this._nameOk(nm)) {
        const fail = toolCallFailure(candidate, { closed: true });
        events.push({ type: "text", text: fail.text });
        events.push({ type: "tool_call", call: mkToolCall(fail.name || nm, {}, this.nextIndex++) });
        return { events, consumed: end, wait: false };
      }
    }
    // 不像工具调用 → 当正文原样吐出这段，继续往后扫
    events.push({ type: "text", text: candidate });
    return { events, consumed: end, wait: false };
  }
  feed(chunk) {
    this.pend += chunk;
    return this._drain();
  }
  flush() {
    const events = this._drain(true);
    if (this.inCall) {
      const calls = parseToolCallBlock(this.pend, this.nextIndex);
      if (calls.length) {
        for (const c of calls) events.push({ type: "tool_call", call: c });
        this.nextIndex += calls.length;
      } else if (this.pend.trim()) {
        // 流在块中间结束：协议残片不回显原文，改为提示 + 空参数补发，避免 agent 循环被掐断
        if (looksLikeProtocol(this.pend)) {
          const fail = toolCallFailure(this.pend, { closed: false });
          events.push({ type: "text", text: fail.text });
          if (fail.name) events.push({ type: "tool_call", call: mkToolCall(fail.name, {}, this.nextIndex++) });
        } else {
          events.push({ type: "text", text: TC_OPEN + this.pend });
        }
      }
      this.pend = ""; this.inCall = false;
    } else if (this.inResp) {
      // 流在伪造的 <tool_response> 块中间结束：整段是幻觉的工具结果，静默吞掉
      this.pend = ""; this.inResp = false;
    } else if (this.pend) {
      const cleaned = this.pend.replace(STRAY_CLOSE_RE, "");
      if (cleaned) events.push({ type: "text", text: cleaned });
      this.pend = "";
    }
    return events;
  }
  /**
   * 流结束时是否还挂着未闭合的工具调用块（上游在块中间提前自停，线上高频故障）。
   * 返回截断尾部片段（供续写指令引用原文）；null = 无需续写：
   *   - 普通文本尾巴不是截断；
   *   - 未闭合块若其实已可解析（完整 JSON 只差闭合标签，区域扫描能救回）→ flush 直接出结果，不浪费续写轮。
   * 覆盖两种挂起状态：inCall（<tool_call> 块未闭合）、裸 JSON 等待态（命中特征但 JSON 未配对）。
   */
  truncatedTail(max = 80) {
    const pend = String(this.pend || "");
    const s = pend.trim();
    if (s.length < 8) return null;
    if (this.inCall) {
      return parseToolCallBlock(pend, 0).length ? null : s.slice(-max);
    }
    if (this.allowed && BARE_JSON_RE.test(pend)) {
      const closed = autoCloseJson(repairSmartQuotes(pend));
      const fixed = closed ? parseToolCallBlock(closed, 0) : parseToolCallBlock(repairSmartQuotes(pend), 0);
      return fixed.length ? null : s.slice(-max);
    }
    return null;
  }

  _drain(final = false) {
    const events = [];
    while (true) {
      if (this.inResp) {
        // 模型伪造的 <tool_response> 块：连同内容整体吞掉（不回显、不当正文）
        const j = this.pend.indexOf(TR_CLOSE);
        if (j >= 0) {
          this.pend = this.pend.slice(j + TR_CLOSE.length);
          this.inResp = false;
          continue;
        }
        if (final || this.pend.length > 65536) {
          this.pend = ""; this.inResp = false;
          return events;
        }
        return events; // 等更多数据
      }
      if (!this.inCall) {
        const iTC = this.pend.indexOf(TC_OPEN);
        const iTR = this.pend.indexOf(TR_OPEN);
        // 裸 JSON 出现在开标签之前（模型把多个调用塞进一个块、或嵌套第二个 <tool_call>）：
        // 优先走裸 JSON 识别，否则开标签分支会把前面的调用整段当正文吐掉（线上 Windows 样本）
        if (iTC >= 0 && iTC > 0 && this.allowed && BARE_JSON_RE.test(this.pend.slice(0, iTC))) {
          const bare = this._tryBareJson(final);
          if (bare && bare.wait) {
            const bm = BARE_JSON_RE.exec(this.pend);
            const before = this.pend.slice(0, bm.index).replace(STRAY_CLOSE_RE, "");
            if (before) events.push({ type: "text", text: before });
            this.pend = this.pend.slice(bm.index);
            return events; // 等更多数据（可能是被切断的裸调用）
          }
          if (bare) {
            for (const e of bare.events) events.push(e);
            this.pend = this.pend.slice(bare.consumed);
            continue;
          }
        }
        if (iTR >= 0 && (iTC < 0 || iTR < iTC)) {
          // 模型复述转录稿：开标签前的正文保留，块本身进入吞噬状态
          const before = this.pend.slice(0, iTR).replace(STRAY_CLOSE_RE, "");
          if (before) events.push({ type: "text", text: before });
          this.pend = this.pend.slice(iTR + TR_OPEN.length);
          this.inResp = true;
          continue;
        }
        const i = iTC;
        if (i >= 0) {
          // 开标签之前的正文：剥掉孤立闭合标签残骸
          const before = this.pend.slice(0, i).replace(STRAY_CLOSE_RE, "");
          if (before) events.push({ type: "text", text: before });
          this.pend = this.pend.slice(i + TC_OPEN.length);
          this.inCall = true;
          continue;
        }
        // 裸 JSON：模型偶尔不加 <tool_call>，直接把 {"name": "工具名", "arguments": {...}} 当正文吐出来
        const bare = this._tryBareJson(final);
        if (bare && bare.wait) {
          const bm = BARE_JSON_RE.exec(this.pend);
          const before = this.pend.slice(0, bm.index).replace(STRAY_CLOSE_RE, "");
          if (before) events.push({ type: "text", text: before });
          this.pend = this.pend.slice(bm.index);
          return events; // 等更多数据（可能是被切断的裸调用）
        }
        if (bare) {
          for (const e of bare.events) events.push(e);
          this.pend = this.pend.slice(bare.consumed);
          continue;
        }
        // 无开标签：保留半截标签、以及可能是裸 JSON 开头的尾巴（否则 '{"name"...' 的首个 '{' 会被当正文吐掉）
        let keep = final ? 0 : Math.max(tagOverlap(this.pend, TC_OPEN), tagOverlap(this.pend, TC_CLOSE), tagOverlap(this.pend, TR_OPEN));
        if (!final && this.allowed) {
          const lb = this.pend.lastIndexOf("{");
          if (lb >= 0 && this.pend.length - lb <= 40 && !this.pend.slice(lb).includes("}")) {
            keep = Math.max(keep, this.pend.length - lb);
          }
        }
        const body = this.pend.slice(0, this.pend.length - keep);
        const tail = this.pend.slice(this.pend.length - keep);
        const cleaned = body.replace(STRAY_CLOSE_RE, "");
        if (cleaned) events.push({ type: "text", text: cleaned });
        this.pend = tail;
        return events;
      }
      const j = this.pend.indexOf(TC_CLOSE);
      if (j >= 0) {
        const inner = this.pend.slice(0, j);
        this.pend = this.pend.slice(j + TC_CLOSE.length);
        this.inCall = false;
        const calls = parseToolCallBlock(inner, this.nextIndex);
        if (calls.length) {
          for (const c of calls) events.push({ type: "tool_call", call: c });
          this.nextIndex += calls.length;
        } else if (inner.trim()) {
          // 解析不出结构化调用：协议残片给提示并补发空参数调用（保证循环继续），正常正文原样保留
          if (looksLikeProtocol(inner)) {
            const fail = toolCallFailure(inner, { closed: true });
            events.push({ type: "text", text: fail.text });
            if (fail.name) events.push({ type: "tool_call", call: mkToolCall(fail.name, {}, this.nextIndex++) });
          } else {
            events.push({ type: "text", text: TC_OPEN + inner + TC_CLOSE });
          }
        }
        continue;
      }
      // 防失控：缓冲超限且无闭合标签，放弃解析（协议残片只给提示）
      if (final || this.pend.length > 65536) {
        if (final) return events; // 交给 flush() 处理
        if (looksLikeProtocol(this.pend)) {
          const fail = toolCallFailure(this.pend, { closed: false });
          events.push({ type: "text", text: fail.text });
          if (fail.name) events.push({ type: "tool_call", call: mkToolCall(fail.name, {}, this.nextIndex++) });
        } else {
          events.push({ type: "text", text: TC_OPEN + this.pend });
        }
        this.pend = ""; this.inCall = false;
        return events;
      }
      return events; // 等待更多数据
    }
  }
}

/**
 * 从 start 处的 '{' 开始找配对的 '}'（跳过字符串内容）。返回结束下标（含），未闭合返回 -1。
 */
function scanBalancedJson(s, start) {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (inStr) { if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** 裸 JSON 工具调用的起始特征（模型偶尔不加 <tool_call> 直接吐 JSON） */
const BARE_JSON_RE = /\{\s*"(?:name|tool_name|tool_calls|function)"\s*:/;

/**
 * <thinking>/<thought>/<reasoning> 块拆分器：模型偶尔把思考写进正文（而不是 reasoningContent）。
 * 拆出来映射到 reasoning_content，正文才干净；未闭合时标记 unfinishedThinking，
 * 供上层判断"这轮只吐了半截思考"从而自动续写。
 */
const THINK_TAGS = ["thinking", "thought", "reasoning"];
class ThinkingSplitter {
  constructor() { this.buf = ""; this.inThink = false; this.tag = ""; this.unfinishedThinking = false; }
  feed(chunk) { this.buf += chunk; return this._drain(false); }
  flush() { const ev = this._drain(true); this.unfinishedThinking = this.inThink; return ev; }
  reset() { this.buf = ""; this.inThink = false; this.tag = ""; } // 换一轮上游请求时重置，避免沿用上一轮的未闭合状态
  _drain(final) {
    const events = [];
    while (this.buf) {
      if (!this.inThink) {
        let best = null;
        for (const t of THINK_TAGS) {
          const i = this.buf.toLowerCase().indexOf(`<${t}>`);
          if (i >= 0 && (!best || i < best.i)) best = { i, t };
        }
        if (best) {
          const before = this.buf.slice(0, best.i);
          if (before) events.push({ type: "content", text: before });
          this.buf = this.buf.slice(best.i + best.t.length + 2);
          this.inThink = true; this.tag = best.t;
          continue;
        }
        const keep = final ? 0 : Math.max(0, ...THINK_TAGS.map((t) => tagOverlap(this.buf, `<${t}>`)));
        const body = this.buf.slice(0, this.buf.length - keep);
        if (body) events.push({ type: "content", text: body });
        this.buf = this.buf.slice(this.buf.length - keep);
        return events;
      }
      const close = `</${this.tag}>`;
      const i = this.buf.toLowerCase().indexOf(close);
      if (i >= 0) {
        const inner = this.buf.slice(0, i);
        if (inner) events.push({ type: "reasoning", text: inner });
        this.buf = this.buf.slice(i + close.length);
        this.inThink = false; this.tag = "";
        continue;
      }
      events.push({ type: "reasoning", text: this.buf }); // 未闭合也先吐（保持流式）
      this.buf = "";
      return events;
    }
    return events;
  }
}

// 供离线回归测试使用（真实模型输出样本 → 结构化调用）
__internals.parseToolCallBlock = parseToolCallBlock;
__internals.ToolCallExtractor = ToolCallExtractor;
__internals.ThinkingSplitter = ThinkingSplitter;
__internals.aliasTarget = aliasTarget;
__internals.adaptCallArgsToSchema = adaptCallArgsToSchema;
__internals.createToolCallNormalizer = createToolCallNormalizer;
__internals.parseToolChoice = parseToolChoice;
__internals.renderToolChoiceDirective = renderToolChoiceDirective;
__internals.renderDialogue = renderDialogue;
__internals.looksTruncatedStop = looksTruncatedStop;
__internals.stripLeadEscapes = stripLeadEscapes;
__internals.continuationDirective = continuationDirective;

/** 模型正文开头偶尔带字面转义残影（"\n\n我将…"）：剥掉开头的字面 \n / \t 序列 */
const LEAD_ESCAPE_RE = /^(?:\\n|\\t|\s)+/;

function stripLeadEscapes(text) {
  const m = LEAD_ESCAPE_RE.exec(String(text || ""));
  return m && m[0].includes("\\") ? String(text).slice(m[0].length) : text;
}

/**
 * 疑似「句中提前截断」判定（上游 qwen 偶发自停：finishReason=stop 却停在半句话）。
 * 保守启发式，宁可漏判不误判：
 *  - 正文以句读/闭合符结尾 → 视为完整
 *  - 代码围栏 ``` 数量为奇数 → 必然截断
 *  - 无句读结尾，且思考量远超正文（长思考后只吐出一小段） → 截断
 */
function looksTruncatedStop(content, reasoning) {
  const body = String(content || "").trim();
  if (!body) return false;
  const fences = (body.match(/```/g) || []).length;
  if (fences % 2 === 1) return true; // 围栏没闭合 → 必然截断
  if (/[。！？…：；.!?;:）》】」'"`（(]$/.test(body)) return false; // 句读/闭合结尾 → 视为完整
  return String(reasoning || "").length > 200 && body.length < 120; // 长思考后只吐一小段、无句读 → 截断
}

/** 续写指令：带上被截断的结尾原文，要求模型原地接着写 */
function continuationDirective(content) {
  const tail = String(content || "").trim().slice(-60);
  return (
    `\n\n（系统提示：你上一条回复被上游意外截断，你最后输出的是「${tail}」。` +
    `请从中断处直接继续输出剩余内容：不要重复任何已输出的文字，不要重新开始或另起话题，不要输出任何解释说明。）`
  );
}

/**
 * 工具调用截断的续写指令：带上未闭合块的尾部原文，要求补全该调用。
 * 模型「从断点续写」或「完整重写」都能被解析层消化（区域扫描对块内嵌套标签/多 JSON 均兼容）。
 */
function toolContinuationDirective(tail) {
  return (
    `\n\n（系统提示：你上一条回复里的工具调用在「${tail}」处被意外截断，JSON 参数不完整、调用块未闭合。` +
    `请立即补全：从中断处继续输出剩余内容，直到该调用块以 </tool_call> 正常闭合；` +
    `不要重复截断前已输出的内容，不要输出任何解释或另起话题。` +
    `若无法准确续写，则完整重写整个 <tool_call>{"name": ..., "arguments": {...}}</tool_call> 块（内容与原调用意图一致）。）`
  );
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOfContent(messages[i].content).trim();
  }
  throw new UpstreamError("messages 中没有 user 消息", { status: 400 });
}

/**
 * 字符 → token 估算（比例对齐 qwen 系 tokenizer 的实测区间）：
 *   - CJK 汉字/假名（2E80–9FFF、F900–FAFF）：约 1.5 字/token
 *   - CJK 标点与全角字符（3000–303F、FF00–FFEF）、emoji/符号（2600–27BF、≥0x10000）：基本 1 字 = 1 token
 *   - 其余（ASCII/代码/拉丁）：约 3.5 字/token
 * 全网关只用这一把尺子：prompt、completion、缓存命中前缀都用它换算，
 * 保证 cached_tokens ≤ prompt_tokens 恒成立（旧版缓存用 0.6/字符、prompt 用本函数，
 * 两把尺子在 ASCII 重的上下文里算出 210% 的"命中率"）。
 */
function estTokensText(s) {
  const str = String(s || "");
  if (!str) return 0;
  let cjk = 0, punct = 0, other = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
    else if ((c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || c >= 0x10000 || (c >= 0x2600 && c <= 0x27bf)) punct++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + punct + other / 3.5);
}

/* ---------------- 缓存命中估算 ----------------
 * 139 上游（ai.yun.139.com）的 SSE 事件里**没有任何 token/usage 字段**（实测：只有
 * data.flowResult.{outContent,reasoningContent,finishReason,outAuditStatus…}、会话 id 与推荐
 * 追问），139 网页版自身也从未调用任何用量/计费接口 —— 即平台没有把百炼（DashScope）的
 * usage / 隐式上下文缓存计量透传给客户端。因此网关只能估算：
 *   · token 数：estTokensText（字符分桶估算，见函数注释）
 *   · 缓存命中：取「同一会话上一轮请求的最长公共前缀」的**字符数**，再用 estTokensText
 *     换算成 token —— 与 prompt_tokens 同一把尺子，cached ≤ prompt 恒成立；前缀即百炼
 *     隐式上下文缓存的理论命中量（对话逐轮追加时，前缀就是上轮全部内容）
 * 该值标记为非计量值：响应里 x_139.usage_source = "estimated"，便于客户端区分。
 */
const CACHE_PROMPTS = new Map(); // key → { prompt, at }
const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_ENTRIES = 64;
// 百炼文档：上下文缓存「最少可缓存 Token 数 = 1024」（隐式/显式同），低于此值不可能命中，故不计入
const CACHE_MIN_TOKENS = 1024;

function cacheConvKey(messages, modelId) {
  const str = (v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""));
  const first = str(messages?.[0]?.content);
  const second = str(messages?.[1]?.content).slice(0, 200);
  return crypto.createHash("sha1").update(`${modelId}\u0000${first}\u0000${second}`).digest("hex").slice(0, 16);
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

/** 估算本轮可命中缓存的字符数，并把本轮 prompt 记为下次比较基准 */
function estimateCacheChars(key, prompt) {
  const prev = CACHE_PROMPTS.get(key);
  const hit = prev && Date.now() - prev.at < CACHE_TTL_MS ? commonPrefixLen(prev.prompt, prompt) : 0;
  CACHE_PROMPTS.set(key, { prompt, at: Date.now() });
  if (CACHE_PROMPTS.size > CACHE_MAX_ENTRIES) {
    const oldest = CACHE_PROMPTS.keys().next().value;
    if (oldest !== undefined) CACHE_PROMPTS.delete(oldest);
  }
  return hit;
}

function oaiError(res, status, message, type = "invalid_request_error", code = null) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: { message, type, code } }));
}

function readBody(req, limit = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new UpstreamError("请求体过大", { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ---------------- 对话处理 ---------------- */

async function handleChat(req, res, body, deps) {
  const { config, tokens, upstream, log } = deps;
  const t0 = Date.now();
  let messages, modelObj, dialogue, think, webSearch, stream, sessionId, tools = [], choice = { forced: "", required: false };
  try {
    const parsed = JSON.parse(body || "{}");
    messages = Array.isArray(parsed.messages) ? parsed.messages : null;
    if (!messages || !messages.length) throw new UpstreamError("缺少 messages", { status: 400 });
    modelObj = resolveModel(parsed.model || config.defaultModel);
    if (!modelObj) {
      throw new UpstreamError(
        `未知模型 "${parsed.model}"，可用：${MODELS.map((m) => m.id).join(", ")}（也接受显示名如 glm-5.3 / qwen3.8-max）`,
        { status: 400 }
      );
    }
    stream = parsed.stream === true;
    think = resolveThink(parsed);
    if (think && modelObj.thinkable === false) think = false; // 上游该模型不支持开关（如 GLM-5.3 始终思考）
    webSearch = parsed.web_search === true || parsed.webSearch === true;
    sessionId = req.headers["x-139-session-id"] || parsed.session_id || parsed.sessionId || "";
    // tools（OpenAI function calling）：139 上游无原生支持 → 文本协议模拟（见 renderToolsPrompt / ToolCallExtractor）
    if (Array.isArray(parsed.tools)) {
      tools = parsed.tools.filter((t) => t && (t.function?.name || t.name));
    }
    choice = parseToolChoice(parsed.tool_choice, tools);
    dialogue = sessionId ? lastUserText(messages) : renderDialogue(messages);
    if (tools.length) {
      dialogue += renderToolsPrompt(tools);
      const directive = renderToolChoiceDirective(choice);
      if (directive) dialogue += directive;
    }
    if (dialogue.length > modelObj.maxInput) {
      throw new UpstreamError(`输入长度 ${dialogue.length} 超过模型上限 ${modelObj.maxInput} 字符`, { status: 400 });
    }
  } catch (e) {
    return oaiError(res, e.status || 400, e.message);
  }

  // 模型常给工具名加命名空间前缀、吐包装名，甚至幻觉出清单外的名字（bash / read_file…），
  // 这里按本次请求实际提供的工具清单做归一（含语义别名 + 参数键适配），
  // 避免客户端报 "Tool 'xxx' is not in the allowed list" 并中断 agent 循环。
  const { normalize: normalizeToolCall, allowedTools } = createToolCallNormalizer(tools, { log });
  const canAlias = (name) => !!aliasTarget(String(name || "").trim(), allowedTools);

  // 缓存命中估算（前缀复用）：必须在本轮调用前算，并把本轮 prompt 记为下轮基准。
  // 可缓存前缀 < 1024 token 时百炼不会建立缓存 → 上报 0，避免假命中。
  // 命中前缀先记字符数，再与 prompt 用同一把尺子（estTokensText）换算 token：
  // 旧版缓存走 chars*0.6、prompt 走 CJK 感知估算，两把尺子在 ASCII 重的上下文里
  // 会算出 >100% 的缓存命中率（cached_tokens > prompt_tokens）
  const cacheHitChars = config.cacheEstimate === false
    ? 0
    : estimateCacheChars(cacheConvKey(messages, modelObj.id), dialogue);
  const cachePrefixTokens = cacheHitChars > 0 ? estTokensText(dialogue.slice(0, cacheHitChars)) : 0;
  const cacheTokens = cachePrefixTokens >= CACHE_MIN_TOKENS ? cachePrefixTokens : 0;

  // 客户端断开 → 中止上游。
  // 超时策略：空闲超时（上游 3 分钟无新数据视为卡死）+ 30 分钟总时长硬上限。
  // 不用固定总超时——长思考流（30k+ 字 reasoning）总时长常超 5 分钟但数据持续到达，属正常流。
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableEnded) abort.abort(); });
  let abortReason = "";
  const failWith = (reason) => { abortReason = reason; abort.abort(); };
  const IDLE_TIMEOUT_MS = 3 * 60 * 1000;
  const HARD_LIMIT_MS = 30 * 60 * 1000;
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => failWith(`上游 ${IDLE_TIMEOUT_MS / 1000}s 无新数据（疑似卡死），已中止`), IDLE_TIMEOUT_MS);
  };
  const hardTimer = setTimeout(() => failWith(`总时长超过 ${HARD_LIMIT_MS / 60000} 分钟硬上限，已中止`), HARD_LIMIT_MS);
  const clearTimers = () => { clearTimeout(hardTimer); if (idleTimer) clearTimeout(idleTimer); };
  armIdle();

  // 视觉：提取 OpenAI image_url → 上传云盘（sha256 去重/秒传）→ attachment。
  // 上传失败降级为纯文本对话（图片部分丢弃但流程不中断），并把原因写进会话日志
  let imageMetas = [], imageError = "", imageDropped = 0;
  const rawImageUrls = extractImageUrls(messages, !!sessionId);
  {
    // 同一张图在历史里出现多次（zcode 每轮重发全量历史）→ 按 URL 去重；超出上限只保留最近 N 张
    const seen = new Set();
    const uniq = [];
    for (const url of rawImageUrls) {
      if (!seen.has(url)) { seen.add(url); uniq.push(url); }
    }
    const capped = uniq.slice(-IMAGE_MAX_PER_REQUEST);
    imageDropped = uniq.length - capped.length;
    try {
      let idx = 0;
      for (const url of capped) {
        idx++;
        const { buffer, mime, ext } = await decodeImageUrl(url);
        if (buffer.length > IMAGE_MAX_BYTES) throw new UpstreamError(`图片超过 ${Math.round(IMAGE_MAX_BYTES / 1048576)}MB 上限（${buffer.length} 字节）`, { status: 400 });
        if (!buffer.length) throw new UpstreamError("图片内容为空", { status: 400 });
        const name = `gateway-${Date.now()}-${idx}.${ext}`;
        imageMetas.push(await uploadImage({ buffer, mime, name }));
      }
      log(`[chat] 图片上传 ${imageMetas.length} 张${imageDropped ? `（历史共 ${uniq.length} 张，超出上限丢弃最早 ${imageDropped} 张）` : ""}：${imageMetas.map((i) => `${i.name}(${Math.round(i.size / 1024)}KB)`).join(", ")}`);
    } catch (e) {
      imageError = String(e.message || e).slice(0, 200);
      log(`[chat] 图片上传失败，按纯文本继续：${imageError}`);
      imageMetas = [];
    }
  }

  const chatOpts = {
    model: modelObj.id,
    think,
    dialogue,
    sessionId: String(sessionId),
    webSearch,
    signal: abort.signal,
    images: imageMetas,
  };

  const id = "chatcmpl-139-" + crypto.randomUUID().slice(0, 8);
  const created = Math.floor(Date.now() / 1000);
  const promptChars = dialogue.length;
  // usage 块（所有返回路径共用）：带缓存字段，供客户端统计命中率
  const usageBlock = () => {
    const promptTokens = estTokensText(dialogue);
    const completionTokens = estTokensText(content) + estTokensText(reasoning) + Math.ceil(toolChars / 3.5);
    return {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      // 缓存命中（估算值）：OpenBitFun 优先读 DeepSeek 扩展，其次读标准字段
      prompt_tokens_details: { cached_tokens: cacheTokens },
      prompt_cache_hit_tokens: cacheTokens,
      prompt_cache_miss_tokens: Math.max(0, promptTokens - cacheTokens),
    };
  };
  const usageSource = "estimated"; // 上游不返回计量，token 与缓存命中均为估算（见 README「token 用量与缓存命中」）
  let content = "", reasoning = "", modelUsed = "", sidOut = "", statement = "", citations = [];
  let toolCallCount = 0;
  let toolChars = 0; // 工具调用（名字+参数 JSON）的字符数：计入 completion 用量，否则带工具的轮次 completion=0、TPS 显示为 0
  let lastFinish = "";

  /* ---- 会话全量日志（data/sessions/）：逐轮往返追踪 ---- */
  const sess = config.sessionLog === false ? null : {
    ts: new Date().toISOString(),
    id, model: modelObj.id, modelName: modelObj.name,
    think: !!think, webSearch: !!webSearch, stream,
    sessionId: String(sessionId),
    toolNames: allowedTools, toolChoice: choice,
    promptChars: dialogue.length,
    images: [], // 上传成功的图片附件（fileId/name/size）；imageError 记录降级原因
    dialogue, // 完整上游输入（渲染后的对话 + 工具说明）
    rounds: [], // 每次 /chat/v2/add 往返一条：{ kind, note, out, reasoning, finish, ms }
  };
  let curRound = null;
  let roundNote = ""; // 下一轮对话相对基础 dialogue 的附加指令（续写/强制/催促），beginRound 消费后清空
  let roundKind = ""; // 下一轮的轮次类型（retry/prose-continuation/tool-choice-forced/tool-repair/nudge）
  const shortNote = (s) => String(s || "").slice(0, 300);
  const beginRound = (kind, note = "") => {
    curRound = { kind, note: String(note || ""), out: "", reasoning: "", finish: "", at: Date.now() };
    roundNote = "";
    roundKind = "";
  };
  const endRound = () => {
    if (curRound) {
      curRound.ms = Date.now() - curRound.at;
      if (sess) sess.rounds.push(curRound);
    }
    curRound = null;
  };
  const sessToolCalls = []; // 最终下发给客户端的 tool_calls（流式在 emit 时收，非流式在提取后收）
  if (sess) {
    sess.images = imageMetas.map((i) => ({ name: i.name, fileId: i.fileId, size: i.size }));
    if (imageDropped) sess.imagesDropped = imageDropped;
    if (imageError) sess.imageError = imageError;
  }

  // 请求收尾：日志 + 用量落盘（流式与非流式都必须走到，历史上非流式漏记）
  const finalize = () => {
    log(`[chat] ${modelObj.name}${think ? "+think" : ""}${webSearch ? "+search" : ""}${toolCallCount ? "+tools(" + toolCallCount + ")" : ""} | ${sessionId ? "续会话" : "新会话"} ${sidOut || ""} | ${content.length}字 finish=${lastFinish || "-"}${cacheTokens ? " 缓存≈" + cacheTokens + "tok" : ""} ${Date.now() - t0}ms`);
    // 会话全量日志：完整输入 + 逐轮往返 + 最终输出（data/sessions/，排查截断/畸形/续写行为用）
    if (sess) {
      sess.content = content;
      sess.reasoning = reasoning;
      sess.toolCalls = sessToolCalls;
      sess.finish = lastFinish || (sessToolCalls.length ? "tool_calls" : "stop");
      sess.usage = usageBlock();
      sess.ms = Date.now() - t0;
      sess.x139 = { session_id: sidOut, model_used: modelUsed, statement };
      writeSessionLog(sess);
    }
    // 原始抓包（排查上游截断/畸形输出用）：LINGXI_CAPTURE_DIR=/path 打开
    if (process.env.LINGXI_CAPTURE_DIR) {
      try {
        fs.mkdirSync(process.env.LINGXI_CAPTURE_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        fs.writeFileSync(
          path.join(process.env.LINGXI_CAPTURE_DIR, `${stamp}-${id}.json`),
          JSON.stringify({ ts: new Date().toISOString(), id, model: modelObj.id, think: !!think, tools: allowedTools, promptChars, contentChars: content.length, reasoningChars: reasoning.length, finishReason: lastFinish, elapsedMs: Date.now() - t0, out: content, reasoning }, null, 1)
        );
      } catch (e) { log(`[capture] 写盘失败: ${e.message}`); }
    }
    recordUsage({
      model: modelObj.id, modelName: modelObj.name, think: !!think, search: !!webSearch,
      ok: true, promptChars, contentChars: content.length, reasoningChars: reasoning.length,
      promptTokens: estTokensText(dialogue), completionTokens: estTokensText(content) + estTokensText(reasoning),
      cacheTokens,
      elapsedMs: Date.now() - t0, toolCalls: toolCallCount,
    });
  };
  const baseChunk = (delta, extra = {}) => ({
    id, object: "chat.completion.chunk", created, model: modelObj.id, choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  });
  // 上游偶尔只吐半截思考就停（finishReason=stop 却戛然而止）；此时追加此提示重试一次
  const NUDGE_TEXT = "\n\n（系统提示：你上一条回复只有思考、没有实际输出。请继续完成任务；若还需要操作，请立即发起工具调用。）";

  try {
    if (!stream) {
      let toolCallsOut = [];
      let attemptDialogue = dialogue;
      for (let attempt = 0; attempt < 3; attempt++) {
        const opts = { ...chatOpts, dialogue: attemptDialogue };
        beginRound(attempt === 0 ? "initial" : (roundKind || "retry"), attempt === 0 ? "" : roundNote);
        for await (const ev of upstream.chat(opts)) {
          collect(ev);
          armIdle();
        }
        endRound();
        // 把写进正文的 <thinking> 拆到 reasoning，正文才算"真输出"
        const sp = new ThinkingSplitter();
        const spell = [...sp.feed(content), ...sp.flush()];
        content = stripLeadEscapes(spell.filter((e) => e.type === "content").map((e) => e.text).join(""));
        reasoning += spell.filter((e) => e.type === "reasoning").map((e) => e.text).join("");
        // 工具调用提取（非流式）：从全文中提取 <tool_call> 块转为结构化 tool_calls
        toolCallsOut = [];
        if (tools.length) {
          const extractor = new ToolCallExtractor(allowedTools, canAlias);
          let events = [...extractor.feed(content)];
          // 上游在 <tool_call> 块中间提前自停（finishReason=stop 但 JSON 未闭合）：
          // 定向追加一轮"补全该调用"的续写，输出喂进同一个提取器再收尾，把完整参数救回来
          const truncTail = extractor.truncatedTail();
          if (truncTail && attempt < 2) {
            log(`[chat] 工具调用被截断（块尾「${truncTail.slice(-40)}」），自动续写补全`);
            beginRound("tool-repair", shortNote(toolContinuationDirective(truncTail)));
            let extra = "";
            for await (const ev of upstream.chat({ ...chatOpts, dialogue: dialogue + toolContinuationDirective(truncTail) })) {
              collect(ev, { textInto: false }); // 续写是隐藏修复轮：不并入正文/思考，只取输出
              armIdle();
              const fr = ev.data?.flowResult || {};
              if (fr.outContent) extra += fr.outContent;
              if (fr.finishReason === "stop") break;
            }
            endRound();
            events.push(...extractor.feed(extra));
          }
          events.push(...extractor.flush());
          content = events.filter((e) => e.type === "text").map((e) => e.text).join("");
          toolCallsOut = events.filter((e) => e.type === "tool_call").map((e) => normalizeToolCall(e.call)).filter(Boolean);
          toolCallCount = toolCallsOut.length;
          sessToolCalls.length = 0;
          sessToolCalls.push(...toolCallsOut);
          toolChars += toolCallsOut.reduce((n, c) => n + (c.function?.name?.length || 0) + (c.function?.arguments?.length || 0), 0);
        }
        // tool_choice 强制但模型只回了文字：非流式尚未出网，丢弃后带更强指令重试一次
        if (attempt === 0 && choice.required && tools.length && !toolCallsOut.length) {
          log("[chat] tool_choice 强制但未发起工具调用，丢弃纯文字回复并重试一次");
          content = "";
          reasoning = "";
          attemptDialogue = dialogue + "\n\n（系统提示：你上一轮没有发起工具调用，违反了强制要求。本轮必须首先输出 <tool_call> 块调用工具，不要再输出任何纯文字内容。）";
          roundNote = "tool_choice 强制重试指令";
          roundKind = "tool-choice-forced";
          continue;
        }
        // 句中截断（长思考后短正文、无句读结尾 / 围栏未闭合）：自动续写并拼回同一份回复
        if (attempt < 2 && !toolCallsOut.length && looksTruncatedStop(content, reasoning)) {
          log(`[chat] 疑似句中截断（思考 ${reasoning.length} 字 / 正文 ${content.trim().length} 字、无句读结尾），自动续写`);
          attemptDialogue = dialogue + continuationDirective(content);
          roundNote = shortNote(continuationDirective(content));
          roundKind = "prose-continuation";
          continue;
        }
        // 只吐出思考 / 什么都没吐，且本可以用工具 → 续写一次，避免 agent 轮次被掐断
        const produced = content.trim() || toolCallsOut.length;
        if (produced || !tools.length || attempt === 2) break;
        log("[chat] 空回复（只有思考），自动续写一次");
        content = "";
        attemptDialogue = dialogue + NUDGE_TEXT;
        roundNote = shortNote(NUDGE_TEXT);
        roundKind = "nudge";
      }
      clearTimers();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...(sidOut ? { "x-139-session-id": sidOut } : {}) });
      res.end(JSON.stringify({
        id, object: "chat.completion", created, model: modelObj.id,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            ...(content.trim() ? { content: content.trim() } : { content: null }),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCallsOut.length ? { tool_calls: toolCallsOut } : {}),
          },
          finish_reason: toolCallsOut.length ? "tool_calls" : "stop",
        }],
        usage: usageBlock(),
        x_139: { session_id: sidOut, model_used: modelUsed, statement, citations, elapsed_ms: Date.now() - t0, usage_source: usageSource, cache_estimate_tokens: cacheTokens, cache_prefix_tokens: cachePrefixTokens },
      }));
      finalize();
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify(baseChunk({ role: "assistant", content: "" }))}\n\n`);

    // 工具调用提取（流式）：正文经 ToolCallExtractor，<tool_call> 块转结构化 delta.tool_calls
    const extractor = tools.length ? new ToolCallExtractor(allowedTools, canAlias) : null;
    let sawToolCall = false;
    const emitTextEvents = (events) => {
      for (const e of events) {
        if (e.type === "text" && e.text) {
          res.write(`data: ${JSON.stringify(baseChunk({ content: e.text }))}\n\n`);
        } else if (e.type === "tool_call") {
          const call = normalizeToolCall(e.call);
          if (!call) continue;
          sawToolCall = true;
          toolCallCount++;
          toolChars += (call.function?.name?.length || 0) + (call.function?.arguments?.length || 0);
          sessToolCalls.push(call);
          res.write(`data: ${JSON.stringify(baseChunk({ tool_calls: [call] }))}\n\n`);
        }
      }
    };

    let citationsSent = false;
    const splitter = new ThinkingSplitter();
    let leadStripped = false; // 首段正文的字面 "\n\n" 转义残影只剥一次
    // 把 <thinking> 写进正文的情况拆出来：思考走 reasoning_content，正文才参与工具解析
    const applySplit = (se) => {
      if (se.type === "reasoning") {
        reasoning += se.text;
        res.write(`data: ${JSON.stringify(baseChunk({ reasoning_content: se.text }))}\n\n`);
        return;
      }
      if (!leadStripped) {
        const stripped = stripLeadEscapes(se.text);
        if (stripped !== se.text) se = { ...se, text: stripped };
        if (se.text.trim()) leadStripped = true;
      }
      content += se.text;
      if (extractor) emitTextEvents(extractor.feed(se.text));
      else if (se.text) res.write(`data: ${JSON.stringify(baseChunk({ content: se.text }))}\n\n`);
    };
    const feedOut = (txt) => { for (const se of splitter.feed(txt)) applySplit(se); };

    let attemptDialogue = dialogue;
    for (let attempt = 0; attempt < 3; attempt++) {
      const contentAtStart = content.length;
      const callsAtStart = toolCallCount;
      beginRound(attempt === 0 ? "initial" : (roundKind || "retry"), attempt === 0 ? "" : roundNote);
      for await (const ev of upstream.chat({ ...chatOpts, dialogue: attemptDialogue })) {
        armIdle();
        const hadCitations = citations.length > 0;
        collect(ev, { textInto: false });
        const fr = ev.data?.flowResult || {};
        if (fr.reasoningContent) {
          reasoning += fr.reasoningContent;
          res.write(`data: ${JSON.stringify(baseChunk({ reasoning_content: fr.reasoningContent }))}\n\n`);
        }
        if (fr.outContent) feedOut(fr.outContent);
        if (!hadCitations && citations.length && !citationsSent) {
          citationsSent = true;
          res.write(`data: ${JSON.stringify(baseChunk({}, { x_citations: citations }))}\n\n`);
        }
        if (fr.finishReason === "stop") break;
      }
      endRound();
      for (const se of splitter.flush()) applySplit(se); // 冲出本轮残留（未闭合思考按 reasoning 处理）
      splitter.reset(); // 下一轮是独立请求，不能沿用未闭合的 <thinking> 状态
      // 工具调用块被上游截断（未闭合自停）：定向续写补全，输出仍喂进同一个提取器
      //（块闭合后正常吐出 tool_call）；最多 2 轮，仍截断则走 flush 的空参数补发兜底
      const truncTail = extractor ? extractor.truncatedTail() : null;
      if (truncTail && attempt < 2) {
        log(`[chat] 工具调用被截断（块尾「${truncTail.slice(-40)}」），自动续写补全`);
        attemptDialogue = dialogue + toolContinuationDirective(truncTail);
        roundNote = shortNote(toolContinuationDirective(truncTail));
        roundKind = "tool-repair";
        continue;
      }
      const produced = content.length > contentAtStart || toolCallCount > callsAtStart;
      // 句中截断：在同一个 SSE 流里向上游追加一轮"从中断处继续"，客户端看到连续回复
      if (produced && attempt < 2 && toolCallCount === callsAtStart && looksTruncatedStop(content, reasoning)) {
        log(`[chat] 疑似句中截断（思考 ${reasoning.length} 字 / 正文 ${content.trim().length} 字、无句读结尾），自动续写`);
        attemptDialogue = dialogue + continuationDirective(content);
        roundNote = shortNote(continuationDirective(content));
        roundKind = "prose-continuation";
        continue;
      }
      if (produced || !tools.length || attempt === 2) break;
      attemptDialogue = dialogue + NUDGE_TEXT;
      roundNote = shortNote(NUDGE_TEXT);
      roundKind = "nudge";
      log("[chat] 空回复（只有思考），自动续写一次");
    }
    if (extractor) emitTextEvents(extractor.flush()); // 流结束：冲出残余文本/未闭合的 tool_call
    // 结束块（携带会话元数据）
    res.write(`data: ${JSON.stringify({
      ...baseChunk({}),
      choices: [{ index: 0, delta: {}, finish_reason: sawToolCall ? "tool_calls" : "stop" }],
      x_139: { session_id: sidOut, model_used: modelUsed, statement, citations, usage_source: usageSource, cache_estimate_tokens: cacheTokens, cache_prefix_tokens: cachePrefixTokens },
    })}\n\n`);
    // usage chunk：无条件发送（OpenBitFun 等客户端不带 stream_options.include_usage，
    // 但其 token 用量/TPS 显示依赖流内 usage 块；choices:[] 的 usage 帧是 OpenAI 官方 include_usage 语义，多余无害）
    res.write(`data: ${JSON.stringify({
      id, object: "chat.completion.chunk", created, model: modelObj.id,
      choices: [],
      usage: usageBlock(),
    })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    clearTimers();
  } catch (e) {
    clearTimers();
    if (res.writableEnded) return;
    const status = e.status || 502;
    const message = abortReason || e.message;
    // 客户端主动取消（关页面/点停止）不是故障：单独标记，别把统计里的"失败"搞脏
    const cancelled = !abortReason && /abort/i.test(String(e?.name || "") + String(e?.message || ""));
    if (stream && res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error", code: status } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      oaiError(res, status, message, status >= 500 ? "upstream_error" : "invalid_request_error");
    }
    recordUsage({
      model: modelObj.id, modelName: modelObj.name, think: !!think, search: !!webSearch,
      ok: false, ...(cancelled ? { cancelled: true } : {}), error: String(message).slice(0, 200),
      promptChars: dialogue?.length || 0, contentChars: content.length, reasoningChars: reasoning.length,
      promptTokens: estTokensText(dialogue || ""), completionTokens: estTokensText(content) + estTokensText(reasoning),
      cacheTokens,
      elapsedMs: Date.now() - t0, toolCalls: 0,
    });
    log(cancelled ? `[chat] 客户端取消（已生成 ${content.length} 字）` : `[chat] 失败: ${message}`);
    // 错误/取消现场也入会话日志（含已发生的往返轮次），便于定位上游故障
    if (sess) {
      sess.content = content;
      sess.reasoning = reasoning;
      sess.toolCalls = sessToolCalls;
      sess.finish = lastFinish || "";
      sess.ms = Date.now() - t0;
      sess.error = String(message).slice(0, 500);
      if (cancelled) sess.cancelled = true;
      writeSessionLog(sess);
    }
    return;
  }

  finalize();

  function collect(ev, { textInto = true } = {}) {
    const d = ev.data || {};
    if (d.sessionId) sidOut = d.sessionId;
    const fr = d.flowResult || {};
    if (curRound) {
      if (fr.outContent) curRound.out += fr.outContent;
      if (fr.reasoningContent) curRound.reasoning += fr.reasoningContent;
      if (fr.finishReason) curRound.finish = fr.finishReason;
    }
    if (textInto && fr.outContent) content += fr.outContent;
    if (textInto && fr.reasoningContent) reasoning += fr.reasoningContent;
    if (fr.finishReason) lastFinish = fr.finishReason;
    if (fr.modelType) modelUsed = fr.modelType;
    if (d.responseStatement) statement = d.responseStatement;
    if (!citations.length && fr.networkSearchInfoList?.length) {
      citations = fr.networkSearchInfoList.map((c) => ({ index: c.index, title: c.title, url: c.url, site: c.siteName }));
    }
  }
}

/* ---------------- HTTP 服务（由 start() 创建并监听） ---------------- */

  const deps = { config, tokens, upstream, log };
  const PANEL_FILE = path.join(GATEWAY_DIR, "web", "panel.html");
  const adminApi = createAdminApi({
    tokens, upstream,
    getCredentials, saveCredentials, getConfig, saveConfig,
    startedAt, version: GATEWAY_VERSION, adminToken,
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // CORS（本地任意客户端可调）
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key, x-139-session-id, x-admin-token");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    try {
      // 管理 API 优先（自带 X-Admin-Token 鉴权，不经网关 API Key）
      if (await adminApi(req, res, url)) return;

      // 管理面板静态页（本地 App / 浏览器访问）
      if (req.method === "GET" && (path === "/admin" || path === "/panel")) {
        const html = fs.readFileSync(PANEL_FILE, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html.replace("__ADMIN_TOKEN__", adminToken));
        return;
      }

      // 网关鉴权（可选）
      if (config.apiKey) {
        const auth = req.headers.authorization || "";
        const key = auth.replace(/^Bearer\s+/i, "") || req.headers["x-api-key"] || "";
        if (key !== config.apiKey) return oaiError(res, 401, "无效的 API Key", "authentication_error");
      }

      if (req.method === "GET" && path === "/healthz") {
        const cached = tokens.cache;
        const creds = getCredentials();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          ok: true,
          credentials: { sid: !!creds.sid, cookie: !!creds.cookie },
          token_cached: !!cached,
          token_expiry: cached ? new Date(cached.expiryMs).toISOString() : null,
          current_model_state: upstream._modelState,
          panel: "/admin",
        }));
        return;
      }
      if (req.method === "GET" && path === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(openaiModels()));
        return;
      }
      const mModel = path.match(/^\/v1\/models\/([^/]+)$/);
      if (req.method === "GET" && mModel) {
        const one = MODELS.find((m) => m.id === mModel[1] || m.name === mModel[1]);
        if (!one) return oaiError(res, 404, `模型不存在: ${mModel[1]}`, "invalid_request_error", "model_not_found");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(openaiModels().data.find((m) => m.id === one.id)));
        return;
      }
      if (req.method === "POST" && path === "/v1/chat/completions") {
        const body = await readBody(req);
        return await handleChat(req, res, body, deps);
      }
      if (path === "/") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({
          service: "139-mail-lingxi-gateway",
          version: GATEWAY_VERSION,
          endpoints: ["/healthz", "/v1/models", "/v1/models/:id", "/v1/chat/completions", "/admin"],
          panel: "/admin",
          models: MODELS.map((m) => m.id),
        }));
        return;
      }
      oaiError(res, 404, `未知路径: ${path}`, "invalid_request_error");
    } catch (e) {
      if (!res.headersSent) oaiError(res, e.status || 500, e.message, "internal_error");
      else res.end();
    }
  });

  return {
    server,
    tokens,
    upstream,
    config,
    adminToken,
    getCredentials,
    saveCredentials,
    getConfig,
    saveConfig,
    /** 启动监听（127.0.0.1）；返回实际端口 */
    start(port) {
      const p = Number(port != null ? port : (config.port != null ? config.port : 8317)); // 0 = 系统分配
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, "127.0.0.1", () => {
          const actual = server.address().port;
          log(`🚀 139灵犀 OpenAI 兼容网关已启动: http://127.0.0.1:${actual}/v1`);
          const creds = getCredentials();
          log(`   凭据: sid=${creds.sid ? "✅" : "❌"} cookie=${creds.cookie ? "✅" : "❌"} | 网关鉴权: ${config.apiKey ? "已开启" : "关闭（局域网注意暴露风险）"}`);
          log(`   管理面板: http://127.0.0.1:${actual}/admin`);
          log(`   模型: ${MODELS.map((m) => m.name).join(", ")}`);
          resolve(actual);
        });
      });
    },
    stop() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

/* ---------------- CLI 直跑（node gateway/app.mjs 兼容入口） ---------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const gw = createGateway({});
  gw.start().catch((e) => {
    console.error("启动失败:", e.message);
    process.exit(1);
  });
}

