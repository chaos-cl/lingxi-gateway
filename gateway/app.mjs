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
import { Upstream, UpstreamError } from "./upstream.mjs";
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
    ...(opts.port ? { port: Number(opts.port) } : {}),
  };

  // Token 落盘复用：铸造要求 cookie 新鲜、token 却有 ~25 天有效期，存盘后重启无需重新登录
  const tokens = new TokenManager({
    sid: creds.sid || config.sid,
    cookie: creds.cookie || config.cookie,
    cacheFile: path.join(DATA_SUBDIR, "token.json"),
  });
  const upstream = new Upstream(tokens);

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
  return (
    (sys ? sys + "\n\n" : "") +
    "以下是一段多轮对话记录（其中 <tool_call> 是助手发起的工具调用，<tool_response> 是工具返回的结果）。请作为「助手」角色，直接回答最后一条用户消息，不要复述历史内容。\n\n" +
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
  const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
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
    "工具执行结果将以 <tool_response> 块返回给你，根据结果继续回答或再次调用。\n" +
    "单次工具调用的参数体积请控制在 6000 字符以内：大文件先写骨架，再用 Edit 分段补全（上游单次输出长度有限，过长会被截断）。\n" +
    "注意：JSON 的引号必须是半角 ASCII 双引号 \" ，不要用中文引号“”，冒号逗号也用半角 : , ，否则解析会失败。\n" +
    "若无需使用工具，直接用文字回答。"
  );
}

/* ---- <tool_call> 文本流提取器：处理跨 chunk 边界，输出 text / tool_call 事件 ---- */
const TC_OPEN = "<tool_call>";
const TC_CLOSE = "</tool_call>";

/** 尾部与标签前缀的最大重叠长度（防止标签被 chunk 切断） */
function tagOverlap(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) if (s.endsWith(tag.slice(0, k))) return k;
  return 0;
}

/** 孤立闭合标签（qwen 连续多工具调用时多余的 </tool_call> 残骸）连同周边空白一并剥除 */
const STRAY_CLOSE_RE = /(?:\s*<\/tool_call>)+/g;

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
    val = val
      .replace(/<\/parameter>\s*$/i, "")
      .replace(/<\/function>\s*$/i, "")
      .replace(/<\/invoke>\s*$/i, "")
      .replace(/<\/tool_call>\s*$/i, "")
      .replace(/^\r?\n/, "")
      .replace(/\s+$/, "");
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

/** JSON 客体/数组：依次尝试渐进式修复（弯引号 / 全角标点 / 裸换行 / 尾逗号 / 未转义引号） */
function parseJsonCalls(raw) {
  const tryParse = (s) => {
    const variants = [];
    const add = (x) => { if (x != null && !variants.includes(x)) variants.push(x); };
    add(s);
    const sq = repairSmartQuotes(s);
    add(sq);
    const fw = repairFullWidth(sq);
    add(fw);
    const loose = repairJsonLoose(fw);
    add(loose);
    add(repairUnescapedQuotes(loose));
    add(repairUnescapedQuotes(repairJsonLoose(s))); // 不走弯引号修复的兜底
    for (const v of variants) {
      try { return JSON.parse(v); } catch { /* 继续尝试 */ }
    }
    return null;
  };
  let obj = tryParse(raw);
  if (!obj) {
    const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); // 宽容：剥掉前后杂文字
    if (a >= 0 && b > a) obj = tryParse(raw.slice(a, b + 1));
  }
  if (!obj) return [];
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
}

/** 块内容 → tool_call 数组（按方言优先级尝试） */
function parseToolCallBlock(inner, index) {
  const raw = String(inner || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim();
  if (!raw) return [];
  for (const group of [parseHermesCalls(raw), parseInvokeCalls(raw), parseJsonCalls(raw)]) {
    if (group.length) return group.map((c, i) => mkToolCall(c.name, c.args, index + i));
  }
  return [];
}

/** 是否看起来是工具协议残片（而非正常正文） */
function looksLikeProtocol(s) {
  return /<function\s*=|<\/function>|<parameter\s*=|<\/parameter>|<invoke\s|"arguments"\s*:/.test(String(s || ""));
}

/** 工具协议残片的诊断提示：区分「被截断」与「格式不合法」，各自给出可执行的纠正方式 */
function toolCallNotice(inner, { closed = false } = {}) {
  const s = String(inner || "");
  // 留档：解析失败的原始块写到 data/failed-toolcalls/（保留最近 20 份），便于事后定位是哪种畸形；
  // 另可用 LINGXI_CAPTURE_DIR 指定目录。
  const dumpDirs = [process.env.LINGXI_CAPTURE_DIR, path.join(DATA_SUBDIR, "failed-toolcalls")].filter(Boolean);
  for (const dir of dumpDirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `failed-${Date.now()}.txt`);
      fs.writeFileSync(file, s);
      const old = fs.readdirSync(dir).filter((f) => /^failed-\d+\.txt$/.test(f)).sort().slice(0, -20);
      for (const f of old) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } }
      break; // 成功一处即可
    } catch { /* 忽略留档失败 */ }
  }
  const name =
    (s.match(/<function\s*(?:=\s*|name\s*=\s*["'])([^"'>\s]+)/) || [])[1] ||
    (s.match(/<invoke\s+name\s*=\s*["']([^"']+)["']/) || [])[1] ||
    (s.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || "";
  const who = name ? `（${name}）` : "";
  if (closed) {
    const head = s.trim().replace(/\s+/g, " ").slice(0, 120);
    return `\n[网关] 工具调用解析失败${who}：该块 ${s.length} 字符，但不是合法的 JSON/XML，已丢弃。请用 {"name": "工具名", "arguments": {...}}，字符串内的引号与换行必须转义。开头片段：${head}\n`;
  }
  return `\n[网关] 工具调用被截断${who}：输出在 ${s.length} 字符处中断（未出现闭合标签），已丢弃该调用。请缩小单次调用的参数体积，或改为分段写入。\n`;
}

class ToolCallExtractor {
  constructor() { this.pend = ""; this.inCall = false; this.nextIndex = 0; }
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
        // 流在块中间结束：协议残片不回显原文，改为可执行的提示
        events.push({ type: "text", text: looksLikeProtocol(this.pend) ? toolCallNotice(this.pend, { closed: false }) : TC_OPEN + this.pend });
      }
      this.pend = ""; this.inCall = false;
    } else if (this.pend) {
      const cleaned = this.pend.replace(STRAY_CLOSE_RE, "");
      if (cleaned) events.push({ type: "text", text: cleaned });
      this.pend = "";
    }
    return events;
  }
  _drain(final = false) {
    const events = [];
    while (true) {
      if (!this.inCall) {
        const i = this.pend.indexOf(TC_OPEN);
        if (i >= 0) {
          // 开标签之前的正文：剥掉孤立闭合标签残骸
          const before = this.pend.slice(0, i).replace(STRAY_CLOSE_RE, "");
          if (before) events.push({ type: "text", text: before });
          this.pend = this.pend.slice(i + TC_OPEN.length);
          this.inCall = true;
          continue;
        }
        // 无开标签：保留可能是半截标签（开/闭任一）的尾部，其余正文剥掉孤立闭合标签后输出
        const keep = final ? 0 : Math.max(tagOverlap(this.pend, TC_OPEN), tagOverlap(this.pend, TC_CLOSE));
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
          // 解析不出结构化调用：协议残片只给提示，正常正文原样保留
          events.push({ type: "text", text: looksLikeProtocol(inner) ? toolCallNotice(inner, { closed: true }) : TC_OPEN + inner + TC_CLOSE });
        }
        continue;
      }
      // 防失控：缓冲超限且无闭合标签，放弃解析（协议残片只给提示）
      if (final || this.pend.length > 65536) {
        if (final) return events; // 交给 flush() 处理
        events.push({ type: "text", text: looksLikeProtocol(this.pend) ? toolCallNotice(this.pend, { closed: false }) : TC_OPEN + this.pend });
        this.pend = ""; this.inCall = false;
        return events;
      }
      return events; // 等待更多数据
    }
  }
}

// 供离线回归测试使用（真实模型输出样本 → 结构化调用）
__internals.parseToolCallBlock = parseToolCallBlock;
__internals.ToolCallExtractor = ToolCallExtractor;

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOfContent(messages[i].content).trim();
  }
  throw new UpstreamError("messages 中没有 user 消息", { status: 400 });
}

const estTokens = (chars) => Math.ceil(chars * 0.6); // 粗略估算，仅用于 usage 展示

/* ---------------- 缓存命中估算 ----------------
 * 139 上游（ai.yun.139.com）的 SSE 事件里**没有任何 token/usage 字段**（实测：只有
 * data.flowResult.{outContent,reasoningContent,finishReason,outAuditStatus…}、会话 id 与推荐
 * 追问），139 网页版自身也从未调用任何用量/计费接口 —— 即平台没有把百炼（DashScope）的
 * usage / 隐式上下文缓存计量透传给客户端。因此网关只能估算：
 *   · token 数：按字符估（estTokens）
 *   · 缓存命中：取「同一会话上一轮请求的最长公共前缀」，等价于百炼隐式上下文缓存的理论
 *     命中量（对话逐轮追加时，前缀即上轮全部内容）
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
  let messages, modelObj, dialogue, think, webSearch, stream, sessionId, tools = [];
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
    if (parsed.tool_choice === "required" && !tools.length) tools = [];
    dialogue = sessionId ? lastUserText(messages) : renderDialogue(messages);
    if (tools.length) dialogue += renderToolsPrompt(tools);
    if (dialogue.length > modelObj.maxInput) {
      throw new UpstreamError(`输入长度 ${dialogue.length} 超过模型上限 ${modelObj.maxInput} 字符`, { status: 400 });
    }
  } catch (e) {
    return oaiError(res, e.status || 400, e.message);
  }

  // 模型常给工具名加命名空间前缀或直接吐包装名（tools__CallDeferredTool / tool_call / functions.Read），
  // 这里按本次请求实际提供的工具清单做归一，避免客户端报 "Tool 'xxx' is not in the allowed list"。
  const allowedTools = tools.map((t) => t?.function?.name).filter((n) => typeof n === "string" && n);
  const allowedLower = new Map(allowedTools.map((n) => [n.toLowerCase(), n]));
  const normalizeToolCall = (call) => {
    const fn = call?.function;
    if (!fn) return null;
    let name = String(fn.name || "").trim();
    if (!name) return null;
    if (!allowedTools.length || allowedTools.includes(name)) return call;
    const candidates = [
      name.replace(/^(?:tools?|functions?)__/i, ""),           // tools__CallDeferredTool → CallDeferredTool
      name.split(/[.:/]/).pop(),                                // functions.Read → Read
      name.replace(/^(?:tools?|functions?)[._-]/i, ""),
    ];
    for (const c of candidates) {
      if (!c) continue;
      if (allowedTools.includes(c)) { fn.name = c; return call; }
      const hit = allowedLower.get(c.toLowerCase());
      if (hit) { fn.name = hit; return call; }
    }
    const tail = allowedTools.find((t) => t.toLowerCase().endsWith(name.split(/[.:/]/).pop().toLowerCase()));
    if (tail) { fn.name = tail; return call; }
    return call; // 未命中就原样放行，让客户端明确报错而不是静默丢调用
  };

  // 缓存命中估算（前缀复用）：必须在本轮调用前算，并把本轮 prompt 记为下轮基准。
  // 可缓存前缀 < 1024 token 时百炼不会建立缓存 → 上报 0，避免假命中。
  const cachePrefixTokens = config.cacheEstimate === false
    ? 0
    : estTokens(estimateCacheChars(cacheConvKey(messages, modelObj.id), dialogue));
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

  const chatOpts = {
    model: modelObj.id,
    think,
    dialogue,
    sessionId: String(sessionId),
    webSearch,
    signal: abort.signal,
  };

  const id = "chatcmpl-139-" + crypto.randomUUID().slice(0, 8);
  const created = Math.floor(Date.now() / 1000);
  const promptChars = dialogue.length;
  // usage 块（所有返回路径共用）：带缓存字段，供客户端统计命中率
  const usageBlock = () => {
    const promptTokens = estTokens(promptChars);
    const completionTokens = estTokens(content.length + reasoning.length);
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
  let lastFinish = "";
  // 请求收尾：日志 + 用量落盘（流式与非流式都必须走到，历史上非流式漏记）
  const finalize = () => {
    log(`[chat] ${modelObj.name}${think ? "+think" : ""}${webSearch ? "+search" : ""}${toolCallCount ? "+tools(" + toolCallCount + ")" : ""} | ${sessionId ? "续会话" : "新会话"} ${sidOut || ""} | ${content.length}字${cacheTokens ? " 缓存≈" + cacheTokens + "tok" : ""} ${Date.now() - t0}ms`);
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
      promptTokens: estTokens(promptChars), completionTokens: estTokens(content.length + reasoning.length),
      cacheTokens,
      elapsedMs: Date.now() - t0, toolCalls: toolCallCount,
    });
  };
  const baseChunk = (delta, extra = {}) => ({
    id, object: "chat.completion.chunk", created, model: modelObj.id, choices: [{ index: 0, delta, finish_reason: null, ...extra }],
  });

  try {
    if (!stream) {
      for await (const ev of upstream.chat(chatOpts)) {
        collect(ev);
        armIdle();
      }
      clearTimers();
      // 工具调用提取（非流式）：从全文中提取 <tool_call> 块转为结构化 tool_calls
      let toolCallsOut = [];
      if (tools.length) {
        const extractor = new ToolCallExtractor();
        const events = [...extractor.feed(content), ...extractor.flush()];
        content = events.filter((e) => e.type === "text").map((e) => e.text).join("");
        toolCallsOut = events.filter((e) => e.type === "tool_call").map((e) => normalizeToolCall(e.call)).filter(Boolean);
        toolCallCount = toolCallsOut.length;
      }
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
    const extractor = tools.length ? new ToolCallExtractor() : null;
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
          res.write(`data: ${JSON.stringify(baseChunk({ tool_calls: [call] }))}\n\n`);
        }
      }
    };

    let citationsSent = false;
    for await (const ev of upstream.chat(chatOpts)) {
      armIdle();
      const hadCitations = citations.length > 0;
      collect(ev);
      const fr = ev.data?.flowResult || {};
      if (fr.reasoningContent) {
        res.write(`data: ${JSON.stringify(baseChunk({ reasoning_content: fr.reasoningContent }))}\n\n`);
      }
      if (fr.outContent && extractor) {
        emitTextEvents(extractor.feed(fr.outContent));
      } else if (fr.outContent) {
        res.write(`data: ${JSON.stringify(baseChunk({ content: fr.outContent }))}\n\n`);
      }
      if (!hadCitations && citations.length && !citationsSent) {
        citationsSent = true;
        res.write(`data: ${JSON.stringify(baseChunk({}, { x_citations: citations }))}\n\n`);
      }
      if (fr.finishReason === "stop") break;
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
    if (stream && res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: { message, type: "upstream_error", code: status } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      oaiError(res, status, message, status >= 500 ? "upstream_error" : "invalid_request_error");
    }
    recordUsage({
      model: modelObj.id, modelName: modelObj.name, think: !!think, search: !!webSearch,
      ok: false, error: String(message).slice(0, 200),
      promptChars: dialogue?.length || 0, contentChars: content.length, reasoningChars: reasoning.length,
      promptTokens: estTokens(dialogue?.length || 0), completionTokens: estTokens(content.length + reasoning.length),
      cacheTokens,
      elapsedMs: Date.now() - t0, toolCalls: 0,
    });
    log(`[chat] 失败: ${message}`);
    return;
  }

  finalize();

  function collect(ev) {
    const d = ev.data || {};
    if (d.sessionId) sidOut = d.sessionId;
    const fr = d.flowResult || {};
    if (fr.outContent) content += fr.outContent;
    if (fr.reasoningContent) reasoning += fr.reasoningContent;
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
      const p = Number(port || config.port || 8317);
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

