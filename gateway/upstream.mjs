/**
 * 139 AI 上游客户端：
 *  - chat/config 模型切换（用户级全局配置 → 互斥锁保护"切模型→对话首包"临界区）
 *  - chat/v2/add SSE 流式对话（异步生成器逐事件吐出）
 *  - 认证失败自动重铸 token 并重试一次
 */
import crypto from "node:crypto";

const AI_BASE = "https://ai.yun.139.com/api/outer/assistant";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const AUTH_ERR_RE = /token|auth|login|session|认证|鉴权|登录|失效|未授权/i;

export class UpstreamError extends Error {
  constructor(message, { status = 502, upstream = null } = {}) {
    super(message);
    this.status = status;
    this.upstream = upstream;
  }
}

export class Upstream {
  constructor(tokens) {
    this.tokens = tokens;
    this._modelState = null; // 最近一次 chat/config 设置的 "modelType|think"
    this._lock = Promise.resolve();
  }

  /* ---------- 简单互斥锁 ---------- */
  async _acquire() {
    const prev = this._lock;
    let release;
    this._lock = new Promise((r) => (release = r));
    await prev;
    return release;
  }

  /* ---------- 基础请求 ---------- */
  _headers(basic, { sse = false } = {}) {
    const h = {
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
    if (sse) h.accept = "text/event-stream";
    return h;
  }

  async _fetchJson(path, body, signal) {
    const { basic } = await this.tokens.get();
    const res = await fetch(AI_BASE + path, {
      method: "POST",
      headers: this._headers(basic),
      body: JSON.stringify(body),
      signal,
    });
    return { res, json: await res.json().catch(() => null) };
  }

  /* ---------- 模型切换（须持锁调用） ---------- */
  async _ensureModelLocked(modelType, think, signal) {
    const key = `${modelType}|${think ? 1 : 0}`;
    if (this._modelState === key) return;
    const body = {
      modelType,
      sourceChannel: "10175",
      modelThinkingStatus: !!think,
      networkSearchStatus: false, // 联网由 add 请求逐次控制
      baseIdList: [],
    };
    let { res, json } = await this._fetchJson("/chat/config", body, signal);
    if ((res.status === 401 || res.status === 403) || (json && json.success === false && AUTH_ERR_RE.test(json.message || ""))) {
      // 认证失败：重铸后重试一次
      this.tokens.invalidate();
      ({ res, json } = await this._fetchJson("/chat/config", body, signal));
    }
    if (!json || json.success !== true) {
      throw new UpstreamError(`模型切换失败（${modelType}）：${json ? json.message : `HTTP ${res.status}`}`, { upstream: json });
    }
    this._modelState = key;
  }

  /* ---------- 对话主流程（异步生成器，逐 SSE 事件 yield） ---------- */
  async *chat({ model, think, dialogue, sessionId = "", webSearch = false, signal }) {
    const release = await this._acquire();
    let released = false;
    const rel = () => { if (!released) { released = true; release(); } };
    try {
      await this._ensureModelLocked(model, think, signal);

      const send = async () => {
        const { basic, userId } = await this.tokens.get();
        const body = {
          applicationType: "chat",
          sessionId: sessionId || "",
          dialogueInput: {
            dialogue,
            prompt: "",
            inputTime: new Date().toISOString(),
            command: null,
            resourceType: "0",
            resourceId: "",
            dialogueType: "0",
            commandType: 1,
            enableForceNetworkSearch: !!webSearch,
            enableAllNetworkSearch: false,
            enableAiSearch: false,
            extInfo: '{"pcVersion":"1.7.0","h5Version":"3.2.0","dialogueType":"noAiEditDialogue"}',
            versionInfo: { pcVersion: "1.7.0", h5Version: "3.2.0" },
            toolSetting: { imageToolSetting: { enableLlmDescribe: false } },
            attachment: {},
            aiWritingSetting: {},
            enableModelThinking: !!think,
            enableKnowledgeAndNetworkSearch: false,
          },
          sourceChannel: "10175",
          userId,
          continuationInfo: null,
        };
        return fetch(AI_BASE + "/chat/v2/add", {
          method: "POST",
          headers: this._headers(basic, { sse: true }),
          body: JSON.stringify(body),
          signal,
        });
      };

      let res = await send();
      // 认证失败 → 重铸重试一次
      if (res.status === 401 || res.status === 403) {
        this.tokens.invalidate();
        res = await send();
      }
      const ct = res.headers.get("content-type") || "";
      if (!res.ok || !ct.includes("event-stream")) {
        const text = await res.text().catch(() => "");
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        if (json && json.success === false && AUTH_ERR_RE.test(json.message || "")) {
          this.tokens.invalidate();
          res = await send(); // 最后一次
          if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) {
            const t2 = await res.text().catch(() => "");
            throw new UpstreamError(`上游对话失败：${t2.slice(0, 300) || `HTTP ${res.status}`}`, { status: 502 });
          }
        } else {
          throw new UpstreamError(`上游对话失败：${(json && json.message) || text.slice(0, 300) || `HTTP ${res.status}`}`, { status: res.status >= 500 ? 502 : 400, upstream: json });
        }
      }

      // 解析 SSE
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let first = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const parts = buf.split("\n\n");
        buf = parts.pop();
        for (const part of parts) {
          const dl = part.split("\n").find((l) => l.startsWith("data:"));
          if (!dl) continue;
          let ev;
          try { ev = JSON.parse(dl.slice(5)); } catch { continue; }
          if (!ev || ev.success === false) {
            throw new UpstreamError(`上游返回错误：${(ev && ev.message) || "unknown"}`, { upstream: ev });
          }
          // 首个事件到达 = 服务端已将当前模型绑定到本 dialogue，可释放模型锁
          if (first) { rel(); first = false; }
          yield ev;
        }
      }
      rel();
    } finally {
      rel();
    }
  }
}
