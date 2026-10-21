/**
 * Token 管理器：邮箱 sid+cookie → 铸造 Basic token（缓存 + 失效重铸）
 *
 * 链路（已逆向验证）：
 *   POST https://smsrebuild10.mail.10086.cn/file/disk?func=disk:queryUserToken&sid=...
 *   → var.data.data.{ account(DES加密手机号), token(RCS真实令牌), userDomainId }
 *   → DES-ECB(key="139_mail") 解密 account
 *   → Authorization: Basic base64("mobile:" + 手机号 + ":" + token)
 *
 * token 约 25 天有效（内嵌过期时间戳）；每次铸造产生新 token，旧 token 过期前仍可用，
 * 因此重铸不影响进行中的请求。
 */
import { decryptDES } from "./des.mjs";
import fs from "node:fs";
import path from "node:path";

const MINT_URL = "https://smsrebuild10.mail.10086.cn/file/disk";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const REFRESH_AHEAD_MS = 24 * 3600 * 1000; // 过期前 1 天主动刷新

export class TokenManager {
  /**
   * @param {object} opts
   * @param {string|null} [opts.cacheFile] Token 落盘路径。上游「铸造」要求 sid 对应的 cookie 足够新鲜
   *   （cookie 会随浏览器会话轮换/过期，而铸出的 token 有 ~25 天有效期），所以必须把 token 存盘复用，
   *   否则每次重启都要重新登录邮箱换凭据。
   */
  constructor({ sid, cookie, cacheFile = null }) {
    this.creds = { sid, cookie };
    this.cacheFile = cacheFile;
    this.cache = this._loadFromDisk();
    this.minting = null;
  }

  _loadFromDisk() {
    if (!this.cacheFile) return null;
    try {
      const t = JSON.parse(fs.readFileSync(this.cacheFile, "utf8"));
      if (!t?.basic || !t?.expiryMs) return null;
      if (t.expiryMs - Date.now() <= REFRESH_AHEAD_MS) return null; // 快过期，直接重铸
      return { ...t, fromDisk: true };
    } catch { return null; }
  }

  _saveToDisk(t) {
    if (!this.cacheFile || !t?.basic) return;
    try {
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({ ...t, fromDisk: undefined, savedAt: new Date().toISOString() }, null, 1), { mode: 0o600 });
    } catch { /* 落盘失败不影响本次使用 */ }
  }

  /** 是否有可用 token（含磁盘缓存，不触发网络） */
  cachedToken() {
    return this.cache && this.cache.expiryMs - Date.now() > REFRESH_AHEAD_MS ? this.cache : null;
  }

  updateCreds({ sid, cookie }) {
    if (sid) this.creds.sid = sid;
    if (cookie) this.creds.cookie = cookie;
    this.cache = null;
  }

  /** realToken 第 4 段为过期时间戳(ms) */
  static expiryOf(realToken) {
    const n = Number(String(realToken).split("|")[3]);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  async mint() {
    const { sid, cookie } = this.creds;
    if (!sid || !cookie) {
      throw new Error("缺少邮箱凭据（sid/cookie）：请登录 mail.10086.cn 后导出，写入 gateway/credentials.json 或设置 MAIL_SID/MAIL_COOKIE");
    }
    const url = `${MINT_URL}?func=disk:queryUserToken&sid=${encodeURIComponent(sid)}&cguid=${Date.now()}&randnum=${Math.random()}`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/xml",
        Accept: "text/javascript",
        Referer: "https://smsrebuild10.mail.10086.cn/proxy_2.htm",
        "User-Agent": UA,
      },
      body: "<object></object>",
    });
    const raw = await res.text();
    let j = null;
    try {
      j = JSON.parse(raw);
    } catch {
      // 上游错误体是单引号 JS 字面量（非合法 JSON），如 {'code':'FA_INVALID_SESSION','summary':'User Session Expired'}
      const code = raw.match(/['"]?code['"]?\s*:\s*['"]([A-Z_]+)['"]/)?.[1];
      const summary = raw.match(/['"]?summary['"]?\s*:\s*['"]([^'"]+)['"]/)?.[1];
      if (code) j = { code, summary };
    }
    if (!j || j.code !== "S_OK" || !j.var?.data?.data?.token) {
      if (j?.code === "FA_INVALID_SESSION") {
        throw new Error(
          "邮箱会话已过期（FA_INVALID_SESSION：User Session Expired）。请重新登录 mail.10086.cn → 打开 AI工作台 → 从 DevTools 导出新的 sid + cookie，写入 gateway/credentials.json"
        );
      }
      const detail = j ? JSON.stringify(j).slice(0, 200) : `HTTP ${res.status}，响应：${raw.slice(0, 120)}`;
      throw new Error(`token 铸造失败（${detail}）——sid/cookie 可能过期，请重新登录邮箱导出凭据`);
    }
    const T = j.var.data.data;
    const phone = decryptDES(T.account, "139_mail");
    if (!/^\d{11}$/.test(phone)) throw new Error("手机号解密异常: " + JSON.stringify(phone));
    const basic = "Basic " + Buffer.from(`mobile:${phone}:${T.token}`).toString("base64");
    return { basic, userId: T.userDomainId, phone, realToken: T.token, expiryMs: TokenManager.expiryOf(T.token), mintedAt: Date.now() };
  }

  /** 取有效 token；并发调用共享同一次铸造 */
  async get(force = false) {
    if (!force && this.cache && this.cache.expiryMs - Date.now() > REFRESH_AHEAD_MS) {
      if (this.cache.fromDisk && !this._loggedDisk) {
        this._loggedDisk = true;
        console.log(`[token] 复用磁盘缓存的 Token，有效期至 ${new Date(this.cache.expiryMs).toISOString()}（无需重新登录）`);
      }
      return this.cache;
    }
    if (!this.minting) {
      this.minting = this.mint()
        .then((t) => {
          this.cache = t;
          this._saveToDisk(t);
          const exp = t.expiryMs ? new Date(t.expiryMs).toISOString() : "未知";
          console.log(`[token] 铸造成功 ${t.phone.slice(0, 3)}****${t.phone.slice(-4)}，有效期至 ${exp}`);
          return t;
        })
        .finally(() => { this.minting = null; });
    }
    return this.minting;
  }

  invalidate() {
    this.cache = null;
    this._loggedDisk = false;
    if (this.cacheFile) { try { fs.unlinkSync(this.cacheFile); } catch { /* 无文件即成功 */ } }
  }
}
