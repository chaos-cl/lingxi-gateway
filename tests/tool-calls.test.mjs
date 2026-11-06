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
const { parseToolCallBlock, ToolCallExtractor, aliasTarget, adaptCallArgsToSchema, createToolCallNormalizer, parseToolChoice, renderToolChoiceDirective } = __internals;
if (!parseToolCallBlock || !ToolCallExtractor || !aliasTarget || !createToolCallNormalizer) {
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
const c0 = (ev) => JSON.stringify(ev.filter((e) => e.type === "tool_call").map((e) => e.call.function.name));

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

console.log("\n=== 16. 少一个右括号（线上 1696 字符样本）→ 结构补全 ===");
{
  // 原文结构：{name, arguments:{tool_name, args:{action, domain, params:{session_id, expression}}}} 少最后 1 个 }
  const expr = "(function(){var P=window.__PELICAN;if(!P)return 'no-P';return JSON.stringify({a:1});})()";
  const raw = '<tool_call>\n{"name": "CallDeferredTool", "arguments": {"tool_name": "ControlHub", "args": {"action": "evaluate", "domain": "browser", "params": {"session_id": "embedded-browser-panel-view-4", "expression": "' + expr + '"}}}\n</tool_call>';
  const ev = run(raw);
  const c = callsOf(ev);
  ok(c.length === 1 && c[0].function.name === "CallDeferredTool", "补右括号后成功解析", `got ${c.length}`);
  const a = c[0] ? argsOf(c[0]) : {};
  ok(a.args?.params?.expression === expr, "expression 完整无损（含引号与括号）");
  ok(a.args?.params?.session_id === "embedded-browser-panel-view-4", "嵌套字段正确");
}

console.log("\n=== 17. 字符串未闭合（真截断）不得补全 ===");
{
  const raw = '<tool_call>\n{"name": "Write", "arguments": {"payload": "+++ /a.html\\n<div class=\\"x';
  const c = callsOf(run(raw));
  ok(c.length === 1 && c[0].function.arguments === "{}", "只补发空参数调用，不伪造半截内容", c[0]?.function.arguments);
}

console.log("\n=== 18. 裸 JSON（模型不加 <tool_call> 直接吐 JSON，线上真实形态） ===");
{
  const allowed = ["ExecCommand", "Write", "Read"];
  const bare = '{"name": "ExecCommand", "arguments": {"cmd": "cd /tmp && curl -s -o /dev/null -w \'http=%{http_code}\\n\' http://127.0.0.1:8010/", "workdir": "/tmp", "yield_time_ms": 30000}}';
  const runAllowed = (raw, chunk = 0) => {
    const ex = new ToolCallExtractor(allowed);
    const out = [];
    if (chunk > 0) { for (let i = 0; i < raw.length; i += chunk) out.push(...ex.feed(raw.slice(i, i + chunk))); }
    else out.push(...ex.feed(raw));
    out.push(...ex.flush());
    return out;
  };
  const ev = runAllowed("先说一句。\n" + bare);
  ok(callsOf(ev).length === 1 && callsOf(ev)[0].function.name === "ExecCommand", "裸 JSON 被识别为工具调用", c0(ev));
  ok(argsOf(callsOf(ev)[0]).cmd.includes("http_code"), "参数完整（含 %{} 与引号）");
  ok(textOf(ev) === "先说一句。\n", "前面的正文保留、JSON 不残留", JSON.stringify(textOf(ev)));

  const evChunk = runAllowed("先说一句。\n" + bare, 5);
  ok(callsOf(evChunk).length === 1, "5 字符切片下仍识别（流式边界）", c0(evChunk));
  ok(textOf(evChunk) === "先说一句。\n", "切片下正文也不残留", JSON.stringify(textOf(evChunk)));

  const evFence = runAllowed("```json\n" + bare + "\n```");
  ok(callsOf(evFence).length === 1, "被 ```json 围栏包裹也能识别", c0(evFence));

  const evUnknown = runAllowed('代码示例：{"name": "不存在的工具", "arguments": {}} 就是这样。');
  ok(callsOf(evUnknown).length === 0, "工具名不在本次清单 → 当正文，不误吃");
  ok(textOf(evUnknown).includes("不存在的工具"), "正文内容完整保留");

  const evTrunc = runAllowed('{"name": "ExecCommand", "arguments": {"cmd": "ls -la /tmp"}');
  ok(callsOf(evTrunc).length === 1 && argsOf(callsOf(evTrunc)[0]).cmd === "ls -la /tmp", "裸 JSON 少右括号也能补全");
}

console.log("\n=== 19. 幻觉工具名 → 语义别名 + 参数适配（线上故障：模型吐清单外的 bash） ===");
{
  const allowed = ["Read", "Write", "Edit", "ExecCommand", "Grep", "Glob"];

  ok(aliasTarget("bash", allowed)?.allowed === "ExecCommand", "bash → ExecCommand", JSON.stringify(aliasTarget("bash", allowed)));
  ok(aliasTarget("read_file", allowed)?.allowed === "Read", "read_file → Read", JSON.stringify(aliasTarget("read_file", allowed)));
  ok(aliasTarget("write_file", allowed)?.allowed === "Write", "write_file → Write", JSON.stringify(aliasTarget("write_file", allowed)));
  ok(aliasTarget("run_terminal_cmd", allowed)?.allowed === "ExecCommand", "run_terminal_cmd → ExecCommand", JSON.stringify(aliasTarget("run_terminal_cmd", allowed)));
  ok(aliasTarget("完全不相关的名字", allowed) === null, "无语义重叠 → 不猜（null）");
  ok(aliasTarget("Search", ["WebSearch", "WebFetch"])?.allowed === "WebSearch", "WebSearch 语义胜出 WebFetch", JSON.stringify(aliasTarget("Search", ["WebSearch", "WebFetch"])));
  ok(aliasTarget("search", ["Grep", "Glob"]) === null, "Grep/Glob 平分 → 歧义不猜", JSON.stringify(aliasTarget("search", ["Grep", "Glob"])));

  const adapted = adaptCallArgsToSchema('{"command": "ls -la /tmp"}', { parameters: { properties: { cmd: { type: "string" } }, required: ["cmd"] } });
  ok(adapted.changed === true && JSON.parse(adapted.arguments).cmd === "ls -la /tmp", "command → cmd 参数键适配", adapted.arguments);
  const adapted2 = adaptCallArgsToSchema({ file: "/a.txt", text: "hi" }, { parameters: { properties: { file_path: {}, content: {} }, required: ["file_path", "content"] } });
  const a2 = JSON.parse(adapted2.arguments);
  ok(a2.file_path === "/a.txt" && a2.content === "hi", "file/text → file_path/content", adapted2.arguments);
  const adapted3 = adaptCallArgsToSchema('{"data": "x"}', { parameters: { properties: { payload: { type: "string" } }, required: ["payload"] } });
  ok(JSON.parse(adapted3.arguments).payload === "x", "required 缺失 + 剩余一键 → 自动补位", adapted3.arguments);
  const adapted4 = adaptCallArgsToSchema('{"cmd": "ls"}', { parameters: { properties: { cmd: { type: "string" } }, required: ["cmd"] } });
  ok(adapted4.changed === false && adapted4.arguments === null, "键已匹配时不改动原始参数串");

  const { normalize } = createToolCallNormalizer(
    [{ function: { name: "ExecCommand", parameters: { properties: { cmd: {} }, required: ["cmd"] } } }, { function: { name: "Read", parameters: { properties: { file_path: {} }, required: ["file_path"] } } }]
  );
  const c = normalize({ function: { name: "bash", arguments: '{"command": "ls -la"}' } });
  ok(c.function.name === "ExecCommand", "归一器端到端：bash → ExecCommand", c.function.name);
  ok(argsOf(c).cmd === "ls -la", "参数同步适配", c.function.arguments);
  const c2 = normalize({ function: { name: "神秘工具xyz", arguments: "{}" } });
  ok(c2.function.name === "神秘工具xyz", "无法归一 → 原样放行（客户端明确报错）", c2.function.name);
}

console.log("\n=== 20. 裸 JSON 幻觉名（canAlias 开启后也能识别） ===");
{
  const allowed = ["Read", "Write", "ExecCommand"];
  const canAlias = (n) => !!aliasTarget(n, allowed);
  const raw = '好的。\n{"name": "bash", "arguments": {"command": "ls -la"}}';
  const ex = new ToolCallExtractor(allowed, canAlias);
  const ev = [...ex.feed(raw), ...ex.flush()];
  ok(callsOf(ev).length === 1, "canAlias 下裸 JSON 幻觉名被识别为调用", c0(ev));
  const ex2 = new ToolCallExtractor(allowed); // 不给 canAlias：维持旧行为（当正文）
  const ev2 = [...ex2.feed(raw), ...ex2.flush()];
  ok(callsOf(ev2).length === 0 && textOf(ev2).includes("bash"), "未给 canAlias 时维持旧行为（正文）");
}

console.log("\n=== 21. tool_choice 强制解析与指令渲染 ===");
{
  const tools = [{ function: { name: "ExecCommand" } }, { function: { name: "Read" } }];
  ok(parseToolChoice("required", tools).required === true, "required → 强制");
  ok(parseToolChoice({ type: "function", function: { name: "Read" } }, tools).forced === "Read", "对象形态 → 指定工具");
  ok(parseToolChoice({ type: "function", function: { name: "read" } }, tools).forced === "Read", "指定工具大小写归一");
  ok(parseToolChoice("auto", tools).required === false, "auto → 不强制");
  ok(parseToolChoice("required", []).required === false, "无工具清单 → 不强制");
  const d1 = renderToolChoiceDirective({ forced: "", required: true });
  ok(d1.includes("必须") && d1.includes("<tool_call>"), "required 指令含强制措辞");
  const d2 = renderToolChoiceDirective({ forced: "Read", required: true });
  ok(d2.includes("Read"), "指定工具指令带工具名");
  ok(renderToolChoiceDirective({ forced: "", required: false }) === "", "非强制 → 空指令");
}

console.log("\n=== 22. 模型伪造的 <tool_response> 块（转录稿复述泄漏）→ 剥离 ===");
{
  const allowed = ["Read", "Edit", "ExecCommand"];
  // 线上真实形态：助手正文 + 背诵历史里的工具结果块
  const raw = "核心问题是腿穿过了轮廓。需要把腿的起点下移。\n<tool_response>\nSuccessfully edited /tmp/pelican.html\n</tool_response>\n增大臀部覆盖层：\n<tool_response>\nPage reloaded\n</tool_response>\n从截图看效果不错。";
  const ev = run(raw, 9);
  const t = textOf(ev);
  ok(!t.includes("<tool_response>") && !t.includes("Successfully edited"), "伪造的工具结果块被剥离", JSON.stringify(t.slice(0, 80)));
  ok(t.includes("核心问题") && t.includes("臀部覆盖层") && t.includes("从截图看"), "块之间的真实正文完整保留", JSON.stringify(t));
  ok(callsOf(ev).length === 0, "不误产出调用");

  // 伪造块与真实调用混在一段：调用要留下
  const mixed = "<tool_call>\n{\"name\": \"Edit\", \"arguments\": {\"file_path\": \"/a\"}}\n</tool_call>\n<tool_response>\nSuccessfully edited\n</tool_response>\n继续观察。";
  const ev2 = run(mixed, 7);
  ok(callsOf(ev2).length === 1 && callsOf(ev2)[0].function.name === "Edit", "混夹时调用仍被提取", c0(ev2));
  ok(!textOf(ev2).includes("Successfully edited") && textOf(ev2).includes("继续观察"), "伪造块剥离、后文保留", JSON.stringify(textOf(ev2)));

  // 未闭合的伪造块（流中断）：flush 静默吞掉，不回显
  const ex = new ToolCallExtractor(allowed);
  const ev3 = [...ex.feed("先说结论：好的。\n<tool_response>\nScreenshot captured 93472"), ...ex.flush()];
  ok(textOf(ev3) === "先说结论：好的。\n", "未闭合伪造块整段吞掉", JSON.stringify(textOf(ev3)));

  // 孤立的 </tool_response> 残骸
  const ev4 = run("开头\n</tool_response>\n结尾");
  ok(textOf(ev4).includes("开头") && textOf(ev4).includes("结尾") && !textOf(ev4).includes("tool_response"), "孤立闭合残骸被剥", JSON.stringify(textOf(ev4)));

  // 半截 <tool_resp 跨 chunk：feed 阶段暂存不泄漏；后续 chunk 补全后整块吞掉
  const ex5 = new ToolCallExtractor(allowed);
  const ev5a = ex5.feed("前文\n<tool_respo");
  ok(!textOf(ev5a).includes("<tool_respo"), "半截开标签暂存不泄漏（feed 阶段）", JSON.stringify(textOf(ev5a)));
  const ev5b = [...ev5a, ...ex5.feed("nse>xyz伪造</tool_response>尾文"), ...ex5.flush()];
  ok(!textOf(ev5b).includes("tool_respo") && !textOf(ev5b).includes("伪造") && textOf(ev5b).includes("尾文"), "补全后整块吞掉、后文保留", JSON.stringify(textOf(ev5b)));
  ok(textOf(run("前文\n<tool_response>xyz</tool_response>尾")).includes("尾"), "完整块过境后正文恢复");
}

console.log("\n=== 23. renderDialogue 续写边界指令（最后一条=工具结果 vs 用户消息） ===");
{
  const { renderDialogue } = __internals;
  const msgsToolTail = [
    { role: "system", content: "sys" },
    { role: "user", content: "读取文件" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path": "/a"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "文件内容" },
  ];
  const d1 = renderDialogue(msgsToolTail);
  ok(d1.includes("以 <tool_response> 结束"), "工具结果结尾 → 给出从结果继续的指令", d1.slice(0, 120));
  ok(d1.includes("助手永远不会自己输出"), "声明 tool_response 不归助手输出");
  ok(d1.includes("<tool_response>\n文件内容\n</tool_response>"), "工具结果照常渲染");
  const msgsUserTail = [
    { role: "user", content: "你好" },
    { role: "assistant", content: "好的" },
    { role: "user", content: "谢谢" },
  ];
  const d2 = renderDialogue(msgsUserTail);
  ok(d2.includes("直接回答最后一条用户消息"), "用户消息结尾 → 维持原语义");
  ok(d2.includes("不要输出 <tool_response>"), "同样带上禁输出声明");
}

console.log("\n=== 24. 句中截断判定与续写指令（线上故障：长思考后 32 字自停） ===");
const { looksTruncatedStop, stripLeadEscapes, continuationDirective } = __internals;
{
  // 线上真实样本：思考 728 字 + 正文 32 字停在句中
  ok(looksTruncatedStop("\\n\\n我将为你构建这个完整的 Schwarzschild 黑洞", "x".repeat(728)) === true, "长思考+短正文+无句读 → 截断");
  ok(looksTruncatedStop("好的，我去读取文件", "x".repeat(300)) === true, "无句读短句+长思考也判截断");
  ok(looksTruncatedStop("以下是完整代码：\n```js\nconst a = 1;", "") === true, "代码围栏未闭合 → 截断");
  ok(looksTruncatedStop("版本号是 3.7.2。", "x".repeat(728)) === false, "句读结尾 → 完整");
  ok(looksTruncatedStop("好的", "x".repeat(30)) === false, "短句+短思考 → 不误判");
  ok(looksTruncatedStop("解释如下：", "") === false, "冒号结尾 → 视为完整（后接代码等）");
  ok(looksTruncatedStop("代码写完了\n```js\nconst a = 1;\n```", "x".repeat(500)) === false, "围栏闭合 → 完整");
  ok(stripLeadEscapes("\\n\\n我将为你构建") === "我将为你构建", "字面 \\n 残影剥除", JSON.stringify(stripLeadEscapes("\\n\\n我将为你构建")));
  ok(stripLeadEscapes("正常开头") === "正常开头", "正常开头不动");
  ok(stripLeadEscapes("  缩进开头") === "  缩进开头", "纯空白开头不动（只剥含字面反斜杠的前缀）");
  const d = continuationDirective("我将为你构建这个完整的 Schwarzschild 黑洞");
  ok(d.includes("Schwarzschild 黑洞") && d.includes("从中断处直接继续"), "续写指令携带截断点原文");
}

console.log("\n=== 25. Windows 真实坏块样本回归（非法转义 / 多 JSON 块 / 杂交方言 / 裸 JSON 失败兜底） ===");
{
  // 样本①：E:\bf\OLDSSD500\炎龙… 单反斜杠路径（\b 退格、\O/\炎 非法转义）→ 完整恢复且路径不被静默改写
  const s1 = '<tool_call>\n{"name": "ExecCommand", "arguments": {"cmd": "Get-ChildItem \'E:\\bf\\OLDSSD500\\炎龙骑士团外传风之纹章\'"}}\n</tool_call>';
  const c1 = callsOf(run(s1));
  ok(c1.length === 1, "样本① 单反斜杠 Windows 路径可解析", `got ${c1.length}`);
  ok(c1[0] && argsOf(c1[0]).cmd.includes("E:\\bf\\OLDSSD500\\炎龙骑士团外传风之纹章"), "路径完整无损（\\b 未被解析成退格符）", JSON.stringify(argsOf(c1[0]).cmd));

  // 样本②：\users 的 \u 非法转义
  const s2 = '<tool_call>\n{"name": "Read", "arguments": {"path": "C:\\users\\tardis\\notes.txt"}}\n</tool_call>';
  const c2 = callsOf(run(s2));
  ok(c2[0] && argsOf(c2[0]).path === "C:\\users\\tardis\\notes.txt", "样本② \\users 路径恢复", JSON.stringify(c2[0] ? argsOf(c2[0]).path : null));

  // 样本③：驱动器上下文里 \n 与 \t 一律按路径分隔符处理（保路径正确性，丢换行会触发可见重试）
  const s3 = '<tool_call>\n{"name": "ExecCommand", "arguments": {"cmd": "echo done\\nls E:\\temp"}}\n</tool_call>';
  const c3 = callsOf(run(s3));
  const cmd3 = c3[0] ? argsOf(c3[0]).cmd : "";
  ok(cmd3 === "echo done\\nls E:\\temp", "样本③ 驱动器上下文：\\n、\\t 都按路径处理", JSON.stringify(cmd3));
  // 无驱动器上下文时 \n 保持换行
  const s3b = '<tool_call>\n{"name": "ExecCommand", "arguments": {"cmd": "echo done\\nls /tmp/x"}}\n</tool_call>';
  const cmd3b = callsOf(run(s3b))[0] ? argsOf(callsOf(run(s3b))[0]).cmd : "";
  ok(cmd3b === "echo done\nls /tmp/x", "无驱动器路径 → \\n 保持换行", JSON.stringify(cmd3b));

  // 样本④（dump-4 缩样）：裸 JSON 调用 + 嵌套第二个 <tool_call> → 两个调用都找回
  const allowed4 = ["Bash", "mcp__dosbox__screen_capture"];
  const s4 = '{"name": "mcp__dosbox__screen_capture", "arguments": {}}\n<tool_call>\n{"name": "Bash", "arguments": {"command": "TOK=$(cat token); curl -s -H \\"A: B\\"';
  const ex4 = new ToolCallExtractor(allowed4);
  const ev4 = [...ex4.feed(s4), ...ex4.flush()];
  const c4 = callsOf(ev4);
  ok(c4.length === 2 && c4[0].function.name === "mcp__dosbox__screen_capture" && c4[1].function.name === "Bash", "样本④ 块内两调用都找回（先裸 JSON 后嵌套开标签）", c0(ev4));
  ok(argsOf(c4[0]).constructor === Object && Object.keys(argsOf(c4[0])).length === 0, "无参工具的合法空参保留");
  ok(!textOf(ev4).includes("screen_capture"), "无正文泄漏", JSON.stringify(textOf(ev4)));

  // 样本⑤：杂交方言 <parameter=ExecCommand></parameter><parameter=arguments>{…}</parameter></function>
  const s5 = '<tool_call>\n<parameter=ExecCommand>\n</parameter>\n<parameter=arguments>\n{"cmd":"Get-ChildItem E:\\\\dir", "yield_time_ms": 20000}\n</parameter>\n</function>\n</tool_call>';
  const c5 = callsOf(run(s5));
  ok(c5.length === 1 && c5[0].function.name === "ExecCommand", "样本⑤ parameter=NAME 杂交方言识别", c5.map((x) => x.function.name).join(","));
  ok(c5[0] && argsOf(c5[0]).cmd === "Get-ChildItem E:\\dir" && argsOf(c5[0]).yield_time_ms === 20000, "arguments JSON 参数还原");

  // 样本⑥：裸 JSON 命中清单但解析失败（引号混杂）→ 提示 + 空参数补发，不泄漏原文
  const s6 = '{"name": "Bash", "arguments": {"command":"powershell -Command \\"Sort-Object\\","description":"List installed programs"}}';
  const ex6 = new ToolCallExtractor(["Bash"]);
  const ev6 = [...ex6.feed(s6), ...ex6.flush()];
  const c6 = callsOf(ev6);
  ok(c6.length === 1 && c6[0].function.name === "Bash" && c6[0].function.arguments === "{}", "样本⑥ 裸 JSON 解析失败 → 空参数补发（不再丢调用）", c0(ev6));
  ok(textOf(ev6).includes("[网关]"), "附带原因说明");
  ok(!textOf(ev6).includes('"name": "Bash"'), "原始 JSON 不泄漏", JSON.stringify(textOf(ev6).slice(0, 60)));

  // 回归：单体截断仍走「被截断」提示 + 空参数补发
  const s7 = '{"name": "Bash", "arguments": {"command": "TOKEN=$(cat /c/xx); curl -s -m 5 http://127.0.0.1:838';
  const ex7 = new ToolCallExtractor(["Bash"]);
  const ev7 = [...ex7.feed(s7), ...ex7.flush()];
  ok(callsOf(ev7).length === 1 && textOf(ev7).includes("被截断"), "单体截断维持提示文案", JSON.stringify(textOf(ev7).slice(0, 40)));
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
