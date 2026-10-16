#!/usr/bin/env node
/**
 * 139邮箱 AI工作台（灵犀）无头调用 PoC
 *
 * 全链路：sid+cookies → 铸造 Basic token → chat/config 切模型 → chat/v2/add SSE 对话
 * 验证日期：2026-10-14，协议分析见 ../139邮箱AI工作台API分析与封装方案.md
 *
 * 用法：
 *   1) 配置凭据（二选一）：
 *      - 环境变量：MAIL_SID=<sid> MAIL_COOKIE=<smsrebuild10 域全量 cookie 串> node headless-chat.mjs
 *      - 配置文件：poc/credentials.json  {"sid": "...", "cookie": "..."}
 *   2) 可选参数：--model blian_qwen38_max --think --ask "你的问题"
 *
 * 注意：DES 解密需 legacy provider，请用如下方式运行：
 *   node --openssl-legacy-provider headless-chat.mjs [参数]
 *
 * 凭据获取：登录 mail.10086.cn 网页版 → DevTools → Application/网络：
 *   - sid：webai iframe URL 里的 sid 参数（localStorage userSid 同）
 *   - cookie：smsrebuild10.mail.10086.cn 域请求的完整 Cookie 头（需含 RMKEY 等 httpOnly 项，建议用浏览器插件或 CDP Network.getCookies 导出）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------- 配置 ----------
const credFile = path.join(import.meta.dirname, "credentials.json");
let { sid, cookie } = fs.existsSync(credFile)
  ? JSON.parse(fs.readFileSync(credFile, "utf8"))
  : { sid: process.env.MAIL_SID, cookie: process.env.MAIL_COOKIE };
if (!sid || !cookie) {
  console.error("缺少凭据：请设置 MAIL_SID / MAIL_COOKIE 环境变量或创建 credentials.json");
  process.exit(1);
}
const args = process.argv.slice(2);
const getOpt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const QUESTION = getOpt("--search") || getOpt("--ask") || "用一句话介绍你自己";
const MODEL = getOpt("--model") || "blian_qwen38_flash";
const THINK = args.includes("--think");
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// ---------- 1. 铸造 Basic token ----------
// realToken 内嵌过期时间戳（第4段），可提前判断失效
function desEcbDecrypt(b64, keyStr) {
  const d = crypto.createDecipheriv("des-ecb", Buffer.from(keyStr, "utf8"), null);
  return Buffer.concat([d.update(Buffer.from(b64, "base64")), d.final()]).toString("utf8");
}
async function mintBasicToken() {
  const res = await fetch(
    `https://smsrebuild10.mail.10086.cn/file/disk?func=disk:queryUserToken&sid=${sid}&cguid=${Date.now()}&randnum=${Math.random()}`,
    {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/xml", Accept: "text/javascript",
                 Referer: "https://smsrebuild10.mail.10086.cn/proxy_2.htm", "User-Agent": UA },
      body: "<object></object>",
    });
  const j = await res.json();
  if (j.code !== "S_OK") throw new Error("铸造失败（sid/cookie 可能过期）: " + JSON.stringify(j).slice(0, 200));
  const T = j.var.data.data;
  const phone = desEcbDecrypt(T.account, "139_mail");
  const basic = "Basic " + Buffer.from(`mobile:${phone}:${T.token}`).toString("base64");
  const realToken = T.token;
  const expiryMs = Number(realToken.split("|")[3]) || 0;
  return { basic, userId: T.userDomainId, phone, expiryMs };
}

// ---------- 2. AI 网关调用 ----------
function aiHeaders(basic) {
  return {
    Authorization: basic,
    "Content-Type": "application/json",
    "User-Agent": UA,
    "x-yun-api-version": "v1",
    "x-yun-client-info": "3g||30|||||||1920/1200|zh-CN||||",
    "x-yun-app-channel": "10175",
    "x-yun-tid": crypto.randomUUID(),
    Origin: "https://appmail10.mail.10086.cn",
    Referer: "https://appmail10.mail.10086.cn/",
  };
}
async function setModel(basic, modelType, think) {
  const res = await fetch("https://ai.yun.139.com/api/outer/assistant/chat/config", {
    method: "POST",
    headers: aiHeaders(basic),
    body: JSON.stringify({ modelType, sourceChannel: "10175", modelThinkingStatus: !!think, networkSearchStatus: false, baseIdList: [] }),
  });
  return res.json();
}
async function* chatStream(basic, userId, dialogue, { think = false, webSearch = false, sessionId = "" } = {}) {
  const body = {
    applicationType: "chat", sessionId,
    dialogueInput: {
      dialogue, prompt: "", inputTime: new Date().toISOString(),
      command: null, resourceType: "0", resourceId: "", dialogueType: "0", commandType: 1,
      enableForceNetworkSearch: webSearch, enableAllNetworkSearch: false, enableAiSearch: false,
      extInfo: '{"pcVersion":"1.7.0","h5Version":"3.2.0","dialogueType":"noAiEditDialogue"}',
      versionInfo: { pcVersion: "1.7.0", h5Version: "3.2.0" },
      toolSetting: { imageToolSetting: { enableLlmDescribe: false } },
      attachment: {}, aiWritingSetting: {},
      enableModelThinking: think, enableKnowledgeAndNetworkSearch: false,
    },
    sourceChannel: "10175", userId, continuationInfo: null,
  };
  const res = await fetch("https://ai.yun.139.com/api/outer/assistant/chat/v2/add", {
    method: "POST",
    headers: { ...aiHeaders(basic), accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`chat/add HTTP ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop();
    for (const p of parts) {
      const dl = p.split("\n").find((l) => l.startsWith("data:"));
      if (!dl) continue;
      let j; try { j = JSON.parse(dl.slice(5)); } catch { continue; }
      yield j; // { data: { sessionId, dialogueId, flowResult{outContent,reasoningContent,finishReason,...}, ... } }
    }
  }
}

// ---------- 3. 主流程 ----------
const { basic, userId, phone, expiryMs } = await mintBasicToken();
console.log(`✅ token 铸造成功：${phone.slice(0, 3)}****${phone.slice(-4)}，有效期至 ${new Date(expiryMs).toLocaleString()}`);

const cfg = await setModel(basic, MODEL, THINK);
console.log(`✅ 模型已切换为 ${MODEL}（${cfg.success ? "成功" : JSON.stringify(cfg)}）`);

console.log(`\n🤖 问题：${QUESTION}\n--------------------------------`);
let answer = "", thinkText = "", modelEcho = "", sessionId = "";
for await (const ev of chatStream(basic, userId, QUESTION, { think: THINK })) {
  const d = ev.data || {};
  sessionId = d.sessionId || sessionId;
  const fr = d.flowResult || {};
  if (fr.modelType) modelEcho = fr.modelType;
  if (fr.reasoningContent) { thinkText += fr.reasoningContent; process.stdout.write("\x1b[2m" + fr.reasoningContent + "\x1b[0m"); }
  if (fr.outContent) { answer += fr.outContent; process.stdout.write(fr.outContent); }
  if (fr.finishReason === "stop") break;
}
console.log(`\n--------------------------------`);
console.log(`模型回显: ${modelEcho} | sessionId: ${sessionId}${thinkText ? " | 思考长度: " + thinkText.length : ""}`);
