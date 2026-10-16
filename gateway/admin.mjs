/**
 * 管理 API（面板/桌面 App 使用）
 *   GET  /admin/api/status            综合状态（凭据/token/服务器/今日用量）
 *   POST /admin/api/credentials       粘贴导入 {sid, cookie} → 验证铸造 → 保存
 *   POST /admin/api/credentials/auto  从本机 Chrome CDP 抓取 → 验证 → 保存（可 dryRun）
 *   POST /admin/api/renew             重铸 token（sid 仍有效时的一键续期）
 *   GET  /admin/api/usage?days=14     用量聚合（按天 × 按模型）
 *   GET  /admin/api/logs?limit=60     最近调用明细
 *   GET  /admin/api/config            读配置
 *   POST /admin/api/config            写配置 {apiKey, defaultModel, port}
 *   GET  /admin/api/models            模型表 + 各模型累计用量
 *
 * 安全：全部要求 X-Admin-Token（面板/App 注入）；凭据回显一律脱敏。
 */
import { aggregate, recentLogs } from "./usage.mjs";
import { fetchCredentialsFromChrome, probeChromeDebug } from "./cdp.mjs";
import { MODELS } from "./models.mjs";

const maskSid = (sid) => (sid && sid.length > 12 ? `${sid.slice(0, 8)}…${sid.slice(-4)}` : sid ? "…" : "");
const cookieNames = (header) =>
  String(header || "").split(";").map((p) => p.split("=")[0].trim()).filter(Boolean);

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

/** cookie 输入规范化：接受完整 Cookie 头 / 换行分隔 / 分号分隔 */
export function normalizeCookieInput(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const pairs = [];
  const seen = new Set();
  for (const chunk of text.split(/[;\n\r]+/)) {
    const t = chunk.trim();
    if (!t || !t.includes("=")) continue;
    let [k, ...rest] = t.split("=");
    k = k.trim().replace(/^Cookie:/i, "").trim();
    const v = rest.join("=").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    pairs.push(`${k}=${v}`);
  }
  return pairs.join("; ");
}

function tokenView(tokens) {
  const c = tokens.cache;
  if (!c) return { cached: false };
  const now = Date.now();
  return {
    cached: true,
    phone: c.phone ? `${c.phone.slice(0, 3)}****${c.phone.slice(-4)}` : "",
    expiresAt: c.expiryMs || null,
    remainingMs: c.expiryMs ? Math.max(0, c.expiryMs - now) : null,
    expired: c.expiryMs ? c.expiryMs <= now : false,
    mintedAt: c.mintedAt || null,
    userId: c.userId || "",
  };
}

function credentialsView(creds) {
  return {
    hasSid: !!creds.sid,
    sidMasked: maskSid(creds.sid),
    sidLength: (creds.sid || "").length,
    cookieCount: cookieNames(creds.cookie).length,
    cookieNames: cookieNames(creds.cookie).slice(0, 40),
    hasOsSsoSid: cookieNames(creds.cookie).includes("Os_SSo_Sid"),
    hasRmkey: cookieNames(creds.cookie).includes("RMKEY"),
  };
}

export function createAdminApi(ctx) {
  const { tokens, upstream, getCredentials, saveCredentials, getConfig, saveConfig, startedAt, version } = ctx;

  /** 验证凭据：临时 mint 一次，确认可用 */
  async function verifyCredentials(sid, cookie) {
    const probe = new (tokens.constructor)({ sid, cookie });
    try {
      const t = await probe.mint();
      return { ok: true, phone: t.phone ? `${t.phone.slice(0, 3)}****${t.phone.slice(-4)}` : "", userId: t.userId || "" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return async function handleAdmin(req, res, url) {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (!path.startsWith("/admin/api/")) return false;

    // 鉴权
    const token = req.headers["x-admin-token"] || url.searchParams.get("token") || "";
    if (!ctx.adminToken || token !== ctx.adminToken) {
      json(res, 401, { error: "管理令牌无效（X-Admin-Token）" });
      return true;
    }

    try {
      /* ---------- 状态 ---------- */
      if (req.method === "GET" && path === "/admin/api/status") {
        const creds = getCredentials();
        const agg = aggregate({ days: 1 });
        json(res, 200, {
          version,
          server: {
            port: getConfig().port,
            startedAt,
            uptimeMs: Date.now() - startedAt,
            currentModelState: upstream._modelState,
          },
          credentials: credentialsView(creds),
          token: tokenView(tokens),
          today: {
            calls: agg.totals.calls,
            errors: agg.totals.errors,
            outputTokens: agg.totals.todayTokens,
          },
          chrome: await probeChromeDebug(),
        });
        return true;
      }

      /* ---------- 凭据导入（粘贴） ---------- */
      if (req.method === "POST" && path === "/admin/api/credentials") {
        const body = await readJsonBody(req);
        const sid = String(body.sid || "").trim();
        const cookie = normalizeCookieInput(body.cookie);
        if (!sid || !cookie) return json(res, 400, { error: "需要同时提供 sid 与 cookie" }), true;
        const v = await verifyCredentials(sid, cookie);
        if (!v.ok) return json(res, 400, { error: `凭据验证失败：${v.error}` }), true;
        saveCredentials({ sid, cookie });
        tokens.updateCreds({ sid, cookie });
        await tokens.get(true).catch(() => null);
        json(res, 200, { ok: true, verified: v, credentials: credentialsView(getCredentials()), token: tokenView(tokens) });
        return true;
      }

      /* ---------- 凭据导入（本机 Chrome CDP 抓取） ---------- */
      if (req.method === "POST" && path === "/admin/api/credentials/auto") {
        const body = await readJsonBody(req).catch(() => ({}));
        const found = await fetchCredentialsFromChrome();
        if (!found.ok) return json(res, 200, { ok: false, reason: found.reason, detail: found.detail, port: found.port || null }), true;
        const v = await verifyCredentials(found.sid, found.cookie);
        if (!v.ok) {
          return json(res, 200, { ok: false, reason: "verify_failed", detail: `从 Chrome 抓到凭据但验证失败：${v.error}`, sidMasked: maskSid(found.sid) }), true;
        }
        if (body.dryRun) {
          return json(res, 200, { ok: true, dryRun: true, sidMasked: maskSid(found.sid), cookieCount: found.cookieCount, browser: found.browser, verified: v }), true;
        }
        saveCredentials({ sid: found.sid, cookie: found.cookie });
        tokens.updateCreds({ sid: found.sid, cookie: found.cookie });
        await tokens.get(true).catch(() => null);
        json(res, 200, { ok: true, source: "chrome-cdp", sidMasked: maskSid(found.sid), cookieCount: found.cookieCount, browser: found.browser, verified: v, token: tokenView(tokens) });
        return true;
      }

      /* ---------- 确保 token 已铸造（面板打开时调用，便于展示账号信息） ---------- */
      if (req.method === "POST" && path === "/admin/api/token/ensure") {
        if (tokens.cache) return json(res, 200, { ok: true, already: true, token: tokenView(tokens) }), true;
        const creds = getCredentials();
        if (!creds.sid || !creds.cookie) return json(res, 200, { ok: false, reason: "no_credentials", hint: "尚未连接账号" }), true;
        try {
          await tokens.get();
          json(res, 200, { ok: true, token: tokenView(tokens) });
        } catch (e) {
          json(res, 200, { ok: false, reason: "mint_failed", error: e.message, hint: "凭据可能已过期，请重新连接账号" });
        }
        return true;
      }

      /* ---------- 一键续期（重铸 token） ---------- */
      if (req.method === "POST" && path === "/admin/api/renew") {
        tokens.invalidate();
        try {
          await tokens.get(true);
          json(res, 200, { ok: true, token: tokenView(tokens) });
        } catch (e) {
          json(res, 200, { ok: false, error: e.message, hint: "sid 可能已过期：请在面板重新连接账号（粘贴导入或从 Chrome 抓取）" });
        }
        return true;
      }

      /* ---------- 用量 ---------- */
      if (req.method === "GET" && path === "/admin/api/usage") {
        const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days")) || 14));
        json(res, 200, aggregate({ days }));
        return true;
      }
      if (req.method === "GET" && path === "/admin/api/logs") {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 60));
        json(res, 200, { logs: recentLogs({ limit }) });
        return true;
      }

      /* ---------- 模型 ---------- */
      if (req.method === "GET" && path === "/admin/api/models") {
        const agg = aggregate({ days: 90 });
        const byId = new Map(agg.models.map((m) => [m.model, m]));
        json(res, 200, {
          models: MODELS.map((m) => ({
            id: m.id, name: m.name, maxInput: m.maxInput, thinkable: m.thinkable, desc: m.desc,
            usage: byId.get(m.id) || { calls: 0, outputTokens: 0, errors: 0, elapsedMs: 0 },
          })),
        });
        return true;
      }

      /* ---------- 配置 ---------- */
      if (req.method === "GET" && path === "/admin/api/config") {
        const c = getConfig();
        json(res, 200, { port: c.port, defaultModel: c.defaultModel, apiKeySet: !!c.apiKey, apiKeyMasked: c.apiKey ? `${c.apiKey.slice(0, 6)}…` : "" });
        return true;
      }
      if (req.method === "POST" && path === "/admin/api/config") {
        const body = await readJsonBody(req);
        const patch = {};
        if (typeof body.defaultModel === "string" && MODELS.some((m) => m.id === body.defaultModel)) patch.defaultModel = body.defaultModel;
        if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
        if (body.port !== undefined) {
          const p = Number(body.port);
          if (Number.isInteger(p) && p > 0 && p < 65536) patch.port = p;
        }
        saveConfig(patch);
        const c = getConfig();
        json(res, 200, { ok: true, port: c.port, defaultModel: c.defaultModel, apiKeySet: !!c.apiKey, restartHint: patch.port !== undefined ? "端口修改需重启后生效" : null });
        return true;
      }

      json(res, 404, { error: `未知管理接口: ${path}` });
      return true;
    } catch (e) {
      json(res, 500, { error: e.message });
      return true;
    }
  };
}
