/**
 * 网关端到端测试（打桩上游，真实 HTTP + SSE）
 *
 *   node tests/gateway-e2e.test.mjs
 *
 * 覆盖线上真实出现过的四类畸形输出，以及网关的兜底行为：
 *   A. invoke 方言 + 缺闭合标签        → 正常解析
 *   B. JSON 被截断                     → 补发空参数调用 + 原因说明（不掐断循环）
 *   C. 畸形工具名（tools__X / tool_call 套娃） → 归一成本次请求的工具名
 *   D. 只吐半截 <thinking>             → 拆到 reasoning + 自动续写一次
 *   E. 裸 JSON（无 <tool_call> 包裹）   → 识别为工具调用
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../gateway/app.mjs";

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lx-e2e-"));
fs.writeFileSync(path.join(DATA, "credentials.json"), JSON.stringify({ sid: "stub", cookie: "stub" }));

/* ---------- 打桩上游 ---------- */
const realFetch = globalThis.fetch;
const TOKEN = `s|t|u|${Date.now() + 20 * 864e5}|x`;
const MINT = JSON.stringify({ code: "S_OK", var: { data: { data: { account: "hy0IKoxN1yEPxtbISORRpw==", token: TOKEN, userDomainId: "9" } } } });

let script = [];       // 每次 /chat/v2/add 依次取一条输出文本
let chatCalls = 0;
let seenDialogues = [];

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("queryUserToken")) return new Response(MINT, { headers: { "content-type": "application/json" } });
  if (u.includes("/chat/config")) return new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } });
  if (u.includes("/chat/v2/add")) {
    const body = JSON.parse(init.body || "{}");
    seenDialogues.push(body.dialogueInput?.dialogue || "");
    const entry = script[Math.min(chatCalls++, script.length - 1)] ?? "";
    const r = typeof entry === "object" ? entry : { outContent: entry };
    const sse = `data: ${JSON.stringify({ success: true, data: { sessionId: "s", flowResult: { outContent: r.outContent || "", reasoningContent: r.reasoningContent || "" } } })}\n\n`
      + `data: ${JSON.stringify({ success: true, data: { flowResult: { outContent: "", finishReason: "stop" } } })}\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  }
  return realFetch(url, init);
};

const gw = createGateway({ port: 0, dataDir: DATA, adminToken: "t" });
const PORT = await gw.start();

const TOOLS = [
  { type: "function", function: { name: "Write", description: "写文件", parameters: { type: "object", properties: { file_path: { type: "string" }, payload: { type: "string" } }, required: ["file_path", "payload"] } } },
  { type: "function", function: { name: "Read", description: "读文件", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "CallDeferredTool", description: "延迟工具", parameters: { type: "object", properties: { tool_name: { type: "string" }, args: { type: "object" } }, required: ["tool_name", "args"] } } },
];

async function ask(stream) {
  const r = await realFetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "blian_qwen38_flash", messages: [{ role: "user", content: "任务" }], tools: TOOLS, stream }),
  });
  if (!stream) {
    const j = await r.json();
    const m = j.choices?.[0]?.message || {};
    return { finish: j.choices?.[0]?.finish_reason, text: m.content || "", reasoning: m.reasoning_content || "", calls: m.tool_calls || [], usage: j.usage };
  }
  const rd = r.body.getReader(); const dec = new TextDecoder();
  let buf = "", text = "", reasoning = "", calls = [], finish = null, usage = null;
  while (true) {
    const { done, value } = await rd.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n"); buf = parts.pop();
    for (const p of parts) {
      const l = p.trim(); if (!l.startsWith("data:")) continue;
      const d = l.slice(5).trim(); if (d === "[DONE]") continue;
      let o; try { o = JSON.parse(d); } catch { continue; }
      if (o.usage) usage = o.usage;
      const ch = o.choices?.[0];
      if (ch?.delta?.content) text += ch.delta.content;
      if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
      if (ch?.delta?.tool_calls) calls.push(...ch.delta.tool_calls);
      if (ch?.finish_reason) finish = ch.finish_reason;
    }
  }
  return { finish, text, reasoning, calls, usage };
}

let pass = 0, fail = 0;
const ok = (c, m, extra = "") => { c ? (pass++, console.log(`  ✓ ${m}`)) : (fail++, console.log(`  ✗ ${m}${extra ? " → " + extra : ""}`)); };
const setScript = (arr) => { script = arr; chatCalls = 0; seenDialogues = []; };

for (const stream of [false, true]) {
  const tag = stream ? "流式" : "非流式";

  console.log(`\n=== A. invoke 方言缺闭合（${tag}） ===`);
  setScript(['<tool_call>\n<invoke name="Write"><parameter name="file_path">/a.html</parameter><parameter name="payload">+++ /a.html\n<b>x</b>']);
  {
    const o = await ask(stream);
    ok(o.calls.length === 1, "解析出 1 个调用", `got ${o.calls.length}`);
    ok(o.calls[0]?.function.name === "Write", "工具名 Write", o.calls[0]?.function.name);
    ok(!/<tool_call>|<invoke/.test(o.text), "正文无协议残留", JSON.stringify(o.text.slice(0, 40)));
    ok(o.finish === "tool_calls", "finish_reason=tool_calls", o.finish);
  }

  console.log(`\n=== B. JSON 截断 → 空参数补发（${tag}） ===`);
  setScript(['明白了。\n<tool_call>\n{"name": "Write", "arguments": {"payload": "+++ /big.html\\n<div class=\\"a']);
  {
    const o = await ask(stream);
    ok(o.calls.length === 1 && o.calls[0].function.name === "Write", "补发 Write 空参数调用", `got ${o.calls.length}`);
    ok(o.calls[0]?.function.arguments === "{}", "不携带半截 payload", o.calls[0]?.function.arguments);
    ok(o.text.includes("[网关]"), "正文有原因说明");
    ok(o.finish === "tool_calls", "finish_reason=tool_calls（循环不中断）", o.finish);
  }

  console.log(`\n=== C. 畸形工具名归一（${tag}） ===`);
  setScript(['<tool_call>\n{"name": "tool_call", "arguments": {"name": "tools__Read", "arguments": {"path": "/etc/hosts"}}}\n</tool_call>']);
  {
    const o = await ask(stream);
    ok(o.calls[0]?.function.name === "Read", "tool_call{tools__Read} → Read", o.calls[0]?.function.name);
    ok(JSON.parse(o.calls[0]?.function.arguments || "{}").path === "/etc/hosts", "参数保留");
  }

  console.log(`\n=== D. 只吐半截 <thinking> → 自动续写（${tag}） ===`);
  setScript([
    "<thinking>我需要先确认鹈鹕的喉囊位置，先看",
    '好的。\n<tool_call>\n{"name": "CallDeferredTool", "arguments": {"tool_name": "ControlHub", "args": {"action": "screenshot"}}}\n</tool_call>',
  ]);
  {
    const o = await ask(stream);
    ok(seenDialogues.length === 2, "自动发起第二次上游请求", `实际 ${seenDialogues.length} 次`);
    ok(seenDialogues[1]?.includes("只有思考"), "第二次请求带续写提示");
    ok(o.calls.length === 1, "最终拿到工具调用", `got ${o.calls.length}`);
    ok(!o.text.includes("<thinking>"), "正文无 <thinking> 残留");
    ok(o.reasoning.includes("鹈鹕"), "半截思考映射到 reasoning_content", JSON.stringify(o.reasoning.slice(0, 20)));
  }

  console.log(`\n=== E. 裸 JSON（无标签，${tag}） ===`);
  setScript(['先确认下环境。\n{"name": "Read", "arguments": {"path": "/tmp/x.txt"}}']);
  {
    const o = await ask(stream);
    ok(o.calls.length === 1 && o.calls[0].function.name === "Read", "裸 JSON 识别为调用", `got ${o.calls.length}`);
    ok(o.text.trim() === "先确认下环境。", "前面的正文保留、JSON 不残留", JSON.stringify(o.text));
    ok(o.usage?.total_tokens > 0, "usage 正常上报", JSON.stringify(o.usage?.total_tokens));
  }
  console.log(`\n=== F. 句中截断（长思考后短正文自停）→ 自动续写拼接（${tag}） ===`);
  setScript([
    { reasoningContent: "x".repeat(300), outContent: "\\n\\n我将为你构建这个完整的 Schwarzschild 黑洞" },
    { outContent: "光线追踪器，包含以下模块：\n1. 视界渲染\n2. 光子环\n3. 吸积盘。" },
  ]);
  {
    const o = await ask(stream);
    ok(seenDialogues.length === 2, "检测到截断并自动续写（第二次上游请求）", `实际 ${seenDialogues.length} 次`);
    ok(seenDialogues[1]?.includes("从中断处直接继续"), "续写请求携带截断续写指令");
    ok(seenDialogues[1]?.includes("Schwarzschild 黑洞"), "指令携带截断点原文", (seenDialogues[1] || "").slice(-120));
    ok(o.text.includes("我将为你构建") && o.text.includes("吸积盘"), "两段输出拼接为同一份回复", JSON.stringify(o.text.slice(0, 60)));
    ok(!o.text.startsWith("\\n"), "字面 \\n 残影已剥除", JSON.stringify(o.text.slice(0, 12)));
    ok(o.finish === "stop", "finish 正常收尾", o.finish);
  }
  console.log(`\n=== G. 工具调用被截断 → 定向续写补全（${tag}） ===`);
  setScript([
    '<tool_call>\n{"name": "Write", "arguments": {"file_path": "/tmp/plan.md", "payload": "计划：第一',
    '步搭建骨架，第二步填充数据。"}}\n</tool_call>',
  ]);
  {
    const o = await ask(stream);
    ok(o.calls.length === 1, "续写后解析出 1 个完整调用", `got ${o.calls.length}`);
    let a = null; try { a = JSON.parse(o.calls[0]?.function.arguments || "null"); } catch { /* 保持 null */ }
    ok(a?.file_path === "/tmp/plan.md", "file_path 完整", JSON.stringify(a?.file_path));
    ok(a?.payload === "计划：第一步搭建骨架，第二步填充数据。", "参数在截断处完整续上", JSON.stringify(a?.payload || "").slice(0, 60));
    ok(o.finish === "tool_calls", "finish_reason=tool_calls", o.finish);
    ok(seenDialogues[1]?.includes("被意外截断"), "续写请求携带截断指令", (seenDialogues[1] || "").slice(-80));
    ok(seenDialogues[1]?.includes("payload\": \"计划：第一"), "指令携带截断块尾部原文", (seenDialogues[1] || "").slice(-100));
    ok(!o.text.includes("[网关]"), "无失败提示文本", o.text.slice(0, 60));
  }
  console.log(`\n=== H. 工具调用截断 + 续写仍截断 → 回退空参数补发（${tag}） ===`);
  setScript([
    '<tool_call>\n{"name": "Write", "arguments": {"file_path": "/a.md", "payload": "AAA',
    'BBB',
  ]);
  {
    const o = await ask(stream);
    ok(o.text.includes("[网关]"), "有截断原因提示", o.text.slice(0, 60));
    let leaked = false;
    for (const c of o.calls) { try { const a = JSON.parse(c.function.arguments); if (typeof a?.payload === "string" && /AAA|BBB/.test(a.payload)) leaked = true; } catch { /* 非法参数不算泄漏 */ } }
    ok(!leaked, "绝不携带半截 payload", "");
    ok(o.calls.length >= 1 && o.calls[0].function.name === "Write", "补发空参数调用保住循环", o.calls.map((c) => c.function.name).join(","));
  }
}

await gw.stop();
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
