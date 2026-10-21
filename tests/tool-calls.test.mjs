/**
 * 工具调用解析回归测试（零依赖，node 即可跑）
 *
 *   node tests/tool-calls.test.mjs
 *
 * 覆盖上游模型实际出现过的三种方言（JSON / HERMES XML / <invoke> XML）、
 * 一个块内多个并行调用、跨 chunk 切断、以及输出被上游截断时的降级行为。
 * 样本来自 OpenBitFun 会话日志中的真实模型输出。
 */
import { createGateway, __internals } from "../gateway/app.mjs";

// 只做构造（不 start），取内部解析器
createGateway({ dataDir: "/tmp/lx-selftest", adminToken: "selftest" });
const { parseToolCallBlock, ToolCallExtractor } = __internals;
if (!parseToolCallBlock || !ToolCallExtractor) {
  console.error("无法取得解析器（__internals 未填充）");
  process.exit(1);
}

let pass = 0, fail = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? " → " + extra : ""}`); }
};
const callsOf = (events) => events.filter((e) => e.type === "tool_call").map((e) => e.call);
const textOf = (events) => events.filter((e) => e.type === "text").map((e) => e.text).join("");
const argsOf = (c) => JSON.parse(c.function.arguments);

function run(raw, chunkSize = 0) {
  const ex = new ToolCallExtractor();
  const out = [];
  if (chunkSize > 0) {
    for (let i = 0; i < raw.length; i += chunkSize) out.push(...ex.feed(raw.slice(i, i + chunkSize)));
  } else out.push(...ex.feed(raw));
  out.push(...ex.flush());
  return out;
}

/* ---------------- 真实样本（截自会话日志） ---------------- */

const S_HERMES_EMPTY = `<tool_call>\n<function=Read>\n</function>\n</tool_call>`;

const S_INVOKE = `<tool_call>\n<invoke name="Edit"><parameter name="file_path">/Users/chaos/demo/index.html</parameter><parameter name="old_string">const edges = new THREE.EdgesGeometry(geo, 30);\nscene.add(edges);</parameter><parameter name="new_string">const edgeRoot = new THREE.Group();\nedgeRoot.name = 'outlines';\nscene.add(edgeRoot);`;

const S_JSON_TRUNCATED = `<tool_call>\n{"name": "Write", "arguments": {"payload": "+++ /Users/chaos/demo/index.html\\n<!DOCTYPE html>\\n<html>\\n<head>\\n<script src=\\"https://unpkg.com/three@0.160.0/build/three.module.js`;

const S_HERMES_OK = `<tool_call>\n<function=ExecCommand>\n<parameter=cmd>\ncd /tmp && ls -l | wc -l -c index.html && grep -c "three" index.html\n</parameter>\n</function>\n</tool_call>`;

console.log("\n=== 1. HERMES XML（空参数） ===");
{
  const ev = run(S_HERMES_EMPTY);
  const c = callsOf(ev);
  ok(c.length === 1, "产出 1 个 tool_call", `got ${c.length}`);
  ok(c[0]?.function.name === "Read", "工具名 = Read", c[0]?.function.name);
  ok(!textOf(ev).includes("<function="), "正文无协议残留");
}

console.log("\n=== 2. <invoke> 方言（未闭合 + 大段代码参数） ===");
{
  const ev = run(S_INVOKE);
  const c = callsOf(ev);
  const a = c[0] ? argsOf(c[0]) : {};
  ok(c.length === 1, "产出 1 个 tool_call", `got ${c.length}`);
  ok(c[0]?.function.name === "Edit", "工具名 = Edit", c[0]?.function.name);
  ok(!!a.file_path?.endsWith("index.html"), "file_path 未把下一个标签吞进去", a.file_path);
  ok((a.old_string || "").includes("EdgesGeometry"), "old_string 含代码");
  ok((a.new_string || "").includes("edgeRoot"), "new_string 含代码");
  ok(!textOf(ev).includes("<invoke"), "正文无协议残留");
}

console.log("\n=== 3. JSON 被上游截断（补发空参数调用，保住 agent 循环） ===");
{
  const ev = run(S_JSON_TRUNCATED);
  const t = textOf(ev);
  const c = callsOf(ev);
  ok(c.length === 1 && c[0].function.name === "Write", "补发 Write 空参数调用", `got ${c.length}`);
  ok(c[0]?.function.arguments === "{}", "绝不携带半截 payload（避免写坏文件）", c[0]?.function.arguments);
  ok(t.includes("[网关]") && t.includes("Write"), "提示里带工具名与原因", t.slice(0, 50));
  ok(!t.includes('"arguments"') && !t.includes("<tool_call>"), "正文无原始协议泄漏");
}

console.log("\n=== 4. HERMES XML（命令含引号/管道） ===");
{
  const c = callsOf(run(S_HERMES_OK));
  ok(c.length === 1, "产出 1 个 tool_call", `got ${c.length}`);
  ok(c[0]?.function.name === "ExecCommand", "工具名 = ExecCommand", c[0]?.function.name);
  const a = c[0] ? argsOf(c[0]) : {};
  ok((a.cmd || "").includes("wc -l -c index.html"), "cmd 完整");
  ok((a.cmd || "").includes('grep -c "three"'), "cmd 内引号未被破坏");
}

console.log("\n=== 5. JSON 方言（原有能力不回归） ===");
{
  const c = callsOf(run('<tool_call>\n{"name": "Edit", "arguments": {"file_path": "/a.txt", "old_string": "a", "new_string": "b"}}\n</tool_call>'));
  ok(c.length === 1 && c[0].function.name === "Edit", "正常 JSON");
  const c2 = callsOf(run('<tool_call>\n{"name": "ExecCommand", "arguments": {"cmd": "grep "foo" bar.txt"}}\n</tool_call>'));
  ok(c2.length === 1, "未转义引号可抢救", `got ${c2.length}`);
  ok(c2[0] && argsOf(c2[0]).cmd.includes('"foo"'), "引号内容保留");
}

console.log("\n=== 6. 跨 chunk 切断（流式边界） ===");
{
  const raw = `前文<tool_call>\n<function=Read>\n<parameter=path>\n/Users/a b.txt\n</parameter>\n</function>\n</tool_call>后文`;
  const ev = run(raw, 7);
  const c = callsOf(ev);
  ok(c.length === 1 && c[0].function.name === "Read", "7 字符切片下仍解析");
  ok(c[0] && argsOf(c[0]).path === "/Users/a b.txt", "参数含空格正确");
  const t = textOf(ev);
  ok(t.startsWith("前文") && t.endsWith("后文"), "正文前后文保留", JSON.stringify(t));
}

console.log("\n=== 7. 一个块内并行多个调用 ===");
{
  const raw = `<tool_call>\n<function=Read>\n<parameter=path>\n/a\n</parameter>\n</function>\n<function=Read>\n<parameter=path>\n/b\n</parameter>\n</function>\n</tool_call>`;
  const c = callsOf(run(raw));
  ok(c.length === 2, "产出 2 个并行调用", `got ${c.length}`);
  ok(c[0].index === 0 && c[1].index === 1, "index 递增", c.map((x) => x.index).join(","));
  ok(argsOf(c[1]).path === "/b", "第二个参数正确");
}

console.log("\n=== 8. 多余闭合标签 / 普通正文不误判 ===");
{
  const ev = run(`<tool_call>\n<function=Read>\n<parameter=path>\n/a\n</parameter>\n</function>\n</tool_call>\n\n</tool_call>\n\n</tool_call>`);
  ok(callsOf(ev).length === 1, "解析出 1 个调用");
  ok(!textOf(ev).includes("</tool_call>"), "无多余闭合标签残留", JSON.stringify(textOf(ev)));
  const ev2 = run("这段代码的 arguments 对象是函数入参，注意别混淆。");
  ok(callsOf(ev2).length === 0 && textOf(ev2).includes("arguments"), "正文含 arguments 原样保留");
}

console.log("\n=== 9. 包装层剥离（模型把 tool_call 当函数名） ===");
{
  const raw = '<tool_call>\n{"name": "tool_call", "arguments": {"name": "Read", "arguments": {"path": "/a.txt"}}}\n</tool_call>';
  const c = callsOf(run(raw));
  ok(c.length === 1, "产出 1 个调用");
  ok(c[0]?.function.name === "Read", "嵌套层被剥开 → Read", c[0]?.function.name);
  ok(c[0] && argsOf(c[0]).path === "/a.txt", "内层参数保留");

  const raw2 = '<tool_call>\n{"name": "function", "arguments": {"tool_name": "ExecCommand", "params": {"cmd": "ls"}}}\n</tool_call>';
  const c2 = callsOf(run(raw2));
  ok(c2[0]?.function.name === "ExecCommand", "tool_name/params 变体也能剥开", c2[0]?.function.name);
  ok(c2[0] && argsOf(c2[0]).cmd === "ls", "params 作为参数");
}

console.log("\n=== 10. 宽松 JSON 修复（裸换行 / 尾随逗号） ===");
{
  const raw = '<tool_call>\n{"name": "Write", "arguments": {"file_path": "/a.txt", "payload": "line1\nline2,\nline3",}}\n</tool_call>';
  const c = callsOf(run(raw));
  ok(c.length === 1, "裸换行+尾随逗号仍可解析", `got ${c.length}`);
  const a = c[0] ? argsOf(c[0]) : {};
  ok(a.payload === "line1\nline2,\nline3", "多行内容完整保留", JSON.stringify(a.payload));
}

console.log("\n=== 11. 提示语区分「格式不完整」与「被截断」 ===");
{
  const closedBad = textOf(run('<tool_call>\n{"name": "Write", "arguments": {"payload": }}\n</tool_call>'));
  ok(closedBad.includes("格式不完整") && !closedBad.includes("被截断"), "已闭合但不合法 → 格式不完整", closedBad.slice(0, 60));
  const unclosed = textOf(run('<tool_call>\n{"name": "Write", "arguments": {"payload": "+++ /a\\n<div'));
  ok(unclosed.includes("被截断"), "未闭合 → 被截断", unclosed.slice(0, 60));
  ok(!/疑似达到上游单次输出长度上限/.test(unclosed), "不再武断归因于上游上限");
}

console.log("\n=== 15. JSON 头 + XML 结尾的杂交体（线上真实样本） ===");
{
  // 原文只有 53 字符：{"name": "CallDeferredTool",\n</parameter>\n</invoke>
  const ev = run('<tool_call>\n{"name": "CallDeferredTool",\n</parameter>\n</invoke>\n</tool_call>');
  const c = callsOf(ev);
  ok(c.length === 1 && c[0].function.name === "CallDeferredTool", "识别出工具名并补发调用", JSON.stringify(c.map((x) => x.function.name)));
  ok(c[0]?.function.arguments === "{}", "参数为空（交给客户端校验后让模型重试）");
  ok(textOf(ev).includes("格式不完整"), "附带原因说明");
}

console.log("\n=== 12. 弯引号 “”（真实故障：模型用中文引号写 JSON） ===");
{
  const raw = '<tool_call>\n{"name": "CallDeferredTool", "arguments": {"tool_name": "ControlHub", "args": {"action": "evaluate", "domain": “browser”, "params": {"code": "document.title"}}}}\n</tool_call>';
  const c = callsOf(run(raw));
  ok(c.length === 1, "弯引号块可解析", `got ${c.length}`);
  ok(c[0]?.function.name === "CallDeferredTool", "工具名正确", c[0]?.function.name);
  const a = c[0] ? argsOf(c[0]) : {};
  ok(a.args?.domain === "browser", "弯引号包裹的值被正确还原", JSON.stringify(a.args?.domain));
  ok(a.tool_name === "ControlHub", "同块其它字段不受影响");
}

console.log("\n=== 13. 全角冒号/逗号 ===");
{
  const raw = '<tool_call>\n{"name"："Read", "arguments"：{"path"："/a.txt"}}\n</tool_call>';
  const c = callsOf(run(raw));
  ok(c.length === 1, "全角标点可解析", `got ${c.length}`);
  ok(c[0] && argsOf(c[0]).path === "/a.txt", "参数正确");
}

console.log("\n=== 14. 正文里的中文引号不能被破坏 ===");
{
  const raw = '<tool_call>\n{"name": "Write", "arguments": {"file_path": "/a.txt", "payload": "他说“你好”然后走了"}}\n</tool_call>';
  const c = callsOf(run(raw));
  ok(c.length === 1, "仍可解析");
  ok(c[0] && argsOf(c[0]).payload === "他说“你好”然后走了", "值内弯引号原样保留", JSON.stringify(c[0] ? argsOf(c[0]).payload : null));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
