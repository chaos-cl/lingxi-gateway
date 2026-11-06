/**
 * 线上真实失败样本回归（零依赖，node 即可跑）
 *
 *   node tests/real-failures.test.mjs
 *
 * 样本 = gateway 运行期落盘的 data/failed-toolcalls/failed-*.txt（Windows 机器、
 * OpenBitFun/ZCode agent 会话，2026-10-30 ~ 11-05），每个文件都是当时被整块丢弃的
 * <tool_call> 块原文。修复前：12 份全部解析失败 → 空参数补发 → agent 空转重试。
 * 修复后：10 份应完整恢复参数；2 份为上游真截断，保持"丢弃参数 + 空参数补发"的正确降级。
 *
 * 分类（详见每节标题）：
 *   A. 双开标签：连续多调用漏写上一个 </tool_call>，两个调用挤进一个块
 *   B. Windows 裸反斜杠路径（E:\bf\...）毁掉 JSON 转义 —— mac 开发期从未出现
 *   C. 结构引号被过度转义（PowerShell 嵌套引号场景）
 *   D. HERMES 缺 <function=NAME> 开标签 + parseXmlParams 尾部闭合标签残留
 *   E. 上游真截断（参数不可恢复，验证降级行为不劣化）
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { createGateway, __internals } from "../gateway/app.mjs";

createGateway({ dataDir: path.join(path.dirname(url.fileURLToPath(import.meta.url)), ".tmp-selftest"), adminToken: "selftest" });
const { parseToolCallBlock, ToolCallExtractor } = __internals;
if (!parseToolCallBlock || !ToolCallExtractor) {
  console.error("无法取得解析器（__internals 未填充）");
  process.exit(1);
}

const FIXTURES = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "fixtures", "real-failures");
const read = (f) => fs.readFileSync(path.join(FIXTURES, f), "utf8");

let pass = 0, fail = 0;
const ok = (cond, msg, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}${extra ? " → " + extra : ""}`); }
};
const callsOf = (events) => events.filter((e) => e.type === "tool_call").map((e) => e.call);
const textOf = (events) => events.filter((e) => e.type === "text").map((e) => e.text).join("");
const argsOf = (c) => { try { return JSON.parse(c.function.arguments); } catch { return {}; } };

/** 把 raw 当作"模型吐出的完整 <tool_call> 块"跑一遍流式提取（含 flush），返回事件 */
function runClosed(raw, allowed = ALLOWED) {
  const ex = new ToolCallExtractor(allowed);
  const out = [...ex.feed("<tool_call>" + raw + "</tool_call>"), ...ex.flush()];
  return out;
}
/** 把 raw 当作被截断的流尾巴（无闭合标签）跑一遍，返回事件 */
function runTruncated(raw, allowed = ALLOWED) {
  const ex = new ToolCallExtractor(allowed);
  const out = [...ex.feed(raw), ...ex.flush()];
  return out;
}

const ALLOWED = [
  "mcp__dosbox__screen_capture", "mcp__dosbox__input_key", "mcp__dosbox__mem_read",
  "Bash", "Read", "Edit", "Write", "ExecCommand",
];

/* ============ A. 双开标签：连续调用漏写中间闭合标签 ============ */

console.log("\n=== A1. screen_capture + Bash 挤进一个块（双开标签，Bash 完整） ===");
{
  const raw = read("failed-1793706577267.txt"); // \n{sc}\n<tool_call>\n{Bash...完整}}
  const c = callsOf(runClosed(raw));
  ok(c.length === 2, "恢复 2 个调用", `got ${c.length}: ${c.map((x) => x.function.name)}`);
  ok(c[0]?.function.name === "mcp__dosbox__screen_capture", "第 1 个 = screen_capture", c[0]?.function.name);
  ok(c[1]?.function.name === "Bash", "第 2 个 = Bash", c[1]?.function.name);
  const a = argsOf(c[1] ?? {});
  ok(typeof a.command === "string" && a.command.includes("memory/2241302"), "Bash command 参数完整", a.command?.slice(0, 60));
  ok(!textOf(runClosed(raw)).includes("[网关]"), "无失败提示文本");
}
console.log("\n=== A2. 同形态（Bash 以 PYEOF 收尾，完整） ===");
{
  const raw = read("failed-1793706592348.txt");
  const c = callsOf(runClosed(raw));
  ok(c.length === 2 && c[1]?.function.name === "Bash", "screen_capture + Bash 都恢复", c.map((x) => x.function.name).join(","));
  ok((argsOf(c[1] ?? {}).command || "").trim().endsWith("PYEOF"), "command 以 PYEOF 完整收尾（无残骸）", JSON.stringify((argsOf(c[1] ?? {}).command || "").slice(-20)));
}
console.log("\n=== A3. 双开标签且 Bash 被上游截断（块内 JSON 不平衡） ===");
{
  const raw = read("failed-1793706564258.txt"); // \n{sc}\n<tool_call>\n{Bash...流在 PYEOF 处被切
  const c = callsOf(runClosed(raw));
  ok(c.length >= 1 && c[0]?.function.name === "mcp__dosbox__screen_capture", "至少抢救出第 1 个完整调用", c.map((x) => x.function.name).join(","));
  // 截断的 Bash 最多按「空参数骨架」补发（与 flush 截断路径同一哲学：保循环、绝不携带半截 payload）
  const bash = c.find((x) => x.function.name === "Bash");
  ok(!bash || bash.function.arguments === "{}", "截断的 Bash 不伪造参数（至多空骨架）", bash?.function.arguments?.slice(0, 40));
}

/* ============ B. Windows 裸反斜杠路径 ============ */

console.log("\n=== B1. E:\\bf 路径单反斜杠（\\b=合法退格转义、\\O=非法转义） ===");
{
  const raw = read("failed-1793715913746.txt"); // <tool_call>\n{ExecCommand, cmd: "$g='E:\bf\OLDSSD500\炎龙...'"}
  const c = callsOf(runClosed(raw));
  ok(c.length === 1 && c[0]?.function.name === "ExecCommand", "恢复 ExecCommand", c.map((x) => x.function.name).join(","));
  const a = argsOf(c[0] ?? {});
  ok((a.cmd || "").startsWith("$g='E:\\bf\\OLDSSD500"), "路径反斜杠按字面还原（E:\\bf\\OLDSSD500）", a.cmd?.slice(0, 40));
  ok((a.cmd || "").includes("炎龙骑士团外传风之纹章"), "路径中文部分无损", "");
  ok((a.yield_time_ms ?? 0) === 12000, "数值参数无损", String(a.yield_time_ms));
}
console.log("\n=== B2. PowerShell 反斜杠 + \\`r\\`n（反引号紧跟路径反斜杠 = 非法转义） ===");
{
  const raw = read("failed-1793716091210.txt"); // HERMES 缺名形态，arguments JSON 内含 C:\`r\`n
  const c = callsOf(runClosed(raw));
  ok(c.length === 1 && c[0]?.function.name === "ExecCommand", "恢复 ExecCommand", c.map((x) => x.function.name).join(","));
  const a = argsOf(c[0] ?? {});
  ok((a.cmd || "").includes("dosbox-automation.conf"), "cmd 参数完整", a.cmd?.slice(0, 50));
  ok((a.yield_time_ms ?? 0) === 20000, "yield_time_ms = 20000", String(a.yield_time_ms));
}
console.log("\n=== B3. 注册表键名反斜杠（已正确双写，验证不劣化） ===");
{
  const raw = read("failed-1793882655353.txt"); // 过度转义 + 注册表 \\ 键名
  const c = callsOf(runClosed(raw));
  ok(c.length === 1 && c[0]?.function.name === "Bash", "恢复 Bash", c.map((x) => x.function.name).join(","));
  const a = argsOf(c[0] ?? {});
  ok((a.command || "").includes("HKLM:\\Software\\Microsoft"), "注册表键名反斜杠保持单个", JSON.stringify((a.command || "").slice(0, 80)));
  ok(a.description === "List all installed programs to find VPN/accelerator/streaming software", "description 是独立参数而非粘进 command", JSON.stringify(a.description || "").slice(0, 60));
}

/* ============ C. HERMES 缺名 + parseXmlParams 尾部闭合标签 ============ */

console.log("\n=== C1. <parameter=工具名></parameter> + <parameter=arguments>{JSON} ===");
{
  const raw = read("failed-1793716214184.txt");
  const c = callsOf(runClosed(raw));
  ok(c.length === 1 && c[0]?.function.name === "ExecCommand", "无名 HERMES 恢复出工具名", c.map((x) => x.function.name).join(","));
  ok(typeof argsOf(c[0] ?? {}).cmd === "string", "cmd 参数来自 arguments JSON", "");
}
console.log("\n=== C2. parseXmlParams 最后一个参数不得粘闭合标签残骸（预存 bug，所有 HERMES 调用受益） ===");
{
  const ev = parseToolCallBlock(`<function=ExecCommand>\n<parameter=cmd>\necho hi\n</parameter>\n</function>`, 0);
  const a = ev[0] ? JSON.parse(ev[0].function.arguments) : {};
  ok(a.cmd === "echo hi", "单参数值干净（不含 </parameter>/</function>）", JSON.stringify(a.cmd));
  const ev2 = parseToolCallBlock(`<function=Write>\n<parameter=path>/a.txt</parameter>\n<parameter=payload>\nline1\n</parameter>\n</function>`, 0);
  const a2 = ev2[0] ? JSON.parse(ev2[0].function.arguments) : {};
  ok(a2.payload === "line1" && a2.path === "/a.txt", "多参数的最后一个参数同样干净", JSON.stringify(a2));
}

/* ============ E. 上游真截断：降级行为不劣化 ============ */

console.log("\n=== E1. 真截断（模型在 cmd 字符串内复述旧输出，流中断）→ 空参数补发保循环 ===");
{
  for (const f of ["failed-1793727866593.txt", "failed-1793727900166.txt", "failed-1793374357529.txt", "failed-1793631273491.txt", "failed-1793716091210.trunc"]) {
    if (!fs.existsSync(path.join(FIXTURES, f))) continue;
    const raw = read(f);
    const ev = runTruncated(raw);
    const c = callsOf(ev);
    ok(c.length === 1 && c[0].function.arguments === "{}", `${f}: 补发空参数调用`, c.map((x) => x.function.name + x.function.arguments).join(","));
    ok(textOf(ev).includes("[网关]"), `${f}: 附带原因提示`, "");
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
