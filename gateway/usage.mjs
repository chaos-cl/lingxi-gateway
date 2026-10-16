/**
 * 用量记录与聚合
 *  - 每次对话结束追加一行 JSONL（gateway/data/usage.jsonl）
 *  - 聚合：按天 × 按模型（面板展示用）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
let DATA_DIR = DEFAULT_DIR;
let FILE = path.join(DATA_DIR, "usage.jsonl");
const MAX_LINES = 50000; // 超出后压缩保留最近部分，防止无限增长

/** 指定数据目录（桌面版打包后 asar 只读，需指向用户数据目录） */
export function setUsageDir(dir) {
  DATA_DIR = dir;
  FILE = path.join(dir, "usage.jsonl");
}

function ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

/** 追加一条调用记录 */
export function recordUsage(entry) {
  ensureDir();
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + "\n";
  try { fs.appendFileSync(FILE, line); } catch { /* 记录失败不影响主流程 */ }
}

/** 读取全部记录（可选时间过滤），并对超大文件做一次压缩 */
export function readUsage({ sinceMs = 0 } = {}) {
  try {
    const raw = fs.readFileSync(FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_LINES) {
      const kept = lines.slice(-Math.floor(MAX_LINES * 0.7));
      try { fs.writeFileSync(FILE, kept.join("\n") + "\n"); } catch { /* ignore */ }
    }
    const out = [];
    for (const l of lines) {
      try {
        const r = JSON.parse(l);
        if (!sinceMs || r.ts >= sinceMs) out.push(r);
      } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

const dayKey = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const estTokens = (chars) => Math.ceil((chars || 0) * 0.6);

/**
 * 聚合视图：近 N 天 × 模型
 * 返回 { days: [...日期], totals: {...}, byDay: {date: {...}}, byModel: {...}, modelNames: {...} }
 */
export function aggregate({ days = 14 } = {}) {
  const now = new Date();
  const dayList = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    dayList.push(dayKey(d.getTime()));
  }
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1)).getTime();
  const rows = readUsage({ sinceMs: since });

  const byDay = {};
  for (const d of dayList) byDay[d] = { date: d, calls: 0, ok: 0, errors: 0, think: 0, search: 0, promptChars: 0, contentChars: 0, reasoningChars: 0, outputTokens: 0, elapsedMs: 0, models: {} };
  const byModel = {};
  const modelNames = {};
  const totals = { calls: 0, ok: 0, errors: 0, promptChars: 0, contentChars: 0, reasoningChars: 0, outputTokens: 0, elapsedMs: 0, firstTs: null, lastTs: null, todayCalls: 0, todayTokens: 0 };
  const today = dayKey(Date.now());

  for (const r of rows) {
    const d = dayKey(r.ts);
    const bucket = byDay[d];
    if (!bucket) continue;
    const ok = r.ok !== false;
    const outChars = (r.contentChars || 0) + (r.reasoningChars || 0);
    const outTok = estTokens(outChars);

    bucket.calls++; ok ? bucket.ok++ : bucket.errors++;
    if (r.think) bucket.think++;
    if (r.search) bucket.search++;
    bucket.promptChars += r.promptChars || 0;
    bucket.contentChars += r.contentChars || 0;
    bucket.reasoningChars += r.reasoningChars || 0;
    bucket.outputTokens += outTok;
    bucket.elapsedMs += r.elapsedMs || 0;
    const m = (bucket.models[r.model] ||= { calls: 0, errors: 0, outputTokens: 0, elapsedMs: 0 });
    m.calls++; if (!ok) m.errors++; m.outputTokens += outTok; m.elapsedMs += r.elapsedMs || 0;

    const mm = (byModel[r.model] ||= { model: r.model, name: r.modelName || r.model, calls: 0, ok: 0, errors: 0, think: 0, search: 0, promptChars: 0, contentChars: 0, reasoningChars: 0, outputTokens: 0, elapsedMs: 0, lastTs: 0 });
    mm.calls++; ok ? mm.ok++ : mm.errors++;
    if (r.think) mm.think++;
    if (r.search) mm.search++;
    mm.promptChars += r.promptChars || 0;
    mm.contentChars += r.contentChars || 0;
    mm.reasoningChars += r.reasoningChars || 0;
    mm.outputTokens += outTok;
    mm.elapsedMs += r.elapsedMs || 0;
    mm.lastTs = Math.max(mm.lastTs, r.ts);

    totals.calls++; ok ? totals.ok++ : totals.errors++;
    totals.promptChars += r.promptChars || 0;
    totals.contentChars += r.contentChars || 0;
    totals.reasoningChars += r.reasoningChars || 0;
    totals.outputTokens += outTok;
    totals.elapsedMs += r.elapsedMs || 0;
    totals.firstTs = totals.firstTs === null ? r.ts : Math.min(totals.firstTs, r.ts);
    totals.lastTs = totals.lastTs === null ? r.ts : Math.max(totals.lastTs, r.ts);
    if (d === today) { totals.todayCalls++; totals.todayTokens += outTok; }
    modelNames[r.model] = r.modelName || r.model;
  }

  return {
    generatedAt: Date.now(),
    days: dayList,
    totals,
    byDay,
    models: Object.values(byModel).sort((a, b) => b.calls - a.calls),
    modelNames,
  };
}

/** 最近 N 条调用明细（倒序） */
export function recentLogs({ limit = 60 } = {}) {
  const rows = readUsage({});
  return rows.slice(-limit).reverse().map((r) => ({
    ts: r.ts,
    model: r.model,
    modelName: r.modelName || r.model,
    ok: r.ok !== false,
    error: r.error || null,
    think: !!r.think,
    search: !!r.search,
    promptChars: r.promptChars || 0,
    contentChars: r.contentChars || 0,
    reasoningChars: r.reasoningChars || 0,
    outputTokens: estTokens((r.contentChars || 0) + (r.reasoningChars || 0)),
    elapsedMs: r.elapsedMs || 0,
    toolCalls: r.toolCalls || 0,
  }));
}

export const usageFile = FILE;
