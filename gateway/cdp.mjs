/**
 * 从本机已登录的 Chrome（远程调试端口）抓取 139 邮箱凭据
 *  - 探测 9222~9225 / 9333 调试端口
 *  - 通过 CDP WebSocket 执行 Network.getCookies 读取 mail.10086.cn 全量 cookie（含 httpOnly）
 *  - sid 直接取自 Os_SSo_Sid cookie（已实测等于会话 sid），无需读页面 URL
 * Node 22+ 自带全局 WebSocket，零依赖。
 */

const MIME_NOTE = "需要 Chrome 以 --remote-debugging-port=9222 启动（或用 App 内置登录助手）";

async function httpJson(url, timeoutMs = 1200) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 探测本机可用的 Chrome 调试端点 */
export async function probeChromeDebug(ports = [9222, 9223, 9224, 9225, 9333]) {
  for (const port of ports) {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`);
    if (v?.webSocketDebuggerUrl) {
      return { port, browser: v.Browser || "Chrome", protocolVersion: v["Protocol-Version"] || "" };
    }
  }
  return null;
}

/** 简易 CDP 客户端（page 级 WebSocket） */
class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message || "CDP error")) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} 超时`)); }, 8000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("CDP WebSocket 连接超时")); }, 5000);
    ws.addEventListener("open", () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); });
  });
}

const MAIL_COOKIE_URLS = [
  "https://smsrebuild10.mail.10086.cn/file/disk",
  "https://appmail10.mail.10086.cn/",
  "https://mail.10086.cn/",
];

/** cookie 数组 → Cookie 请求头（按 name 去重，保留首次出现） */
export function cookiesToHeader(cookies) {
  const seen = new Set();
  const parts = [];
  for (const c of cookies) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    parts.push(`${c.name}=${c.value}`);
  }
  return parts.join("; ");
}

/** 从 cookie 数组提取凭据（sid 取自 Os_SSo_Sid） */
export function credentialsFromCookies(cookies) {
  const sidCookie = cookies.find((c) => c.name === "Os_SSo_Sid");
  const header = cookiesToHeader(cookies);
  return { sid: sidCookie?.value || "", cookie: header, cookieCount: cookies.length };
}

/**
 * 从本机 Chrome 抓取凭据。
 * 返回 { ok, sid, cookie, cookieCount, port, browser, source } 或 { ok:false, reason, detail }
 */
export async function fetchCredentialsFromChrome({ ports } = {}) {
  const probe = await probeChromeDebug(ports);
  if (!probe) {
    return { ok: false, reason: "no_debug_port", detail: MIME_NOTE };
  }
  const targets = (await httpJson(`http://127.0.0.1:${probe.port}/json/list`)) || [];
  const pageTarget = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!pageTarget) {
    return { ok: false, reason: "no_page_target", detail: "调试端口已开启，但没有可用页面标签" };
  }
  let session;
  try {
    const ws = await connectWs(pageTarget.webSocketDebuggerUrl);
    session = new CdpSession(ws);
    const { cookies } = await session.send("Network.getCookies", { urls: MAIL_COOKIE_URLS });
    const all = cookies || [];
    const mail = all.filter((c) => /mail\.10086\.cn$/.test(c.domain.replace(/^\./, "")));
    const cred = credentialsFromCookies(mail.length ? mail : all);
    if (!cred.sid || !cred.cookie) {
      return { ok: false, reason: "no_mail_cookies", detail: "未找到 139 邮箱 cookie（该浏览器可能未登录邮箱）", port: probe.port, browser: probe.browser };
    }
    return { ok: true, ...cred, port: probe.port, browser: probe.browser, source: "chrome-cdp" };
  } catch (e) {
    return { ok: false, reason: "cdp_error", detail: e.message, port: probe.port };
  } finally {
    session?.close();
  }
}
