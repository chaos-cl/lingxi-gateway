/**
 * 配置加载：<dir>/config.json + <dir>/credentials.json + 环境变量（优先级最高）
 * dir 默认 gateway/；桌面版打包后传入用户数据目录（asar 内只读）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));

export const GATEWAY_DIR = DIR;
export const CRED_FILE = path.join(DIR, "credentials.json");
export const CONFIG_FILE = path.join(DIR, "config.json");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return {}; }
}

export function loadConfig(dir = DIR) {
  const cfgFile = readJson(path.join(dir, "config.json"));
  const credFile = readJson(path.join(dir, "credentials.json"));
  return {
    port: Number(process.env.GATEWAY_PORT || cfgFile.port || 8317),
    apiKey: process.env.GATEWAY_API_KEY || cfgFile.apiKey || "",
    defaultModel: cfgFile.defaultModel || "blian_qwen38_flash",
    sid: process.env.MAIL_SID || cfgFile.sid || credFile.sid || "",
    cookie: process.env.MAIL_COOKIE || cfgFile.cookie || credFile.cookie || "",
    // 缓存命中估算（上游不返回 usage，见 app.mjs 说明）；GATEWAY_CACHE_ESTIMATE=0 或 config.json {"cacheEstimate": false} 关闭
    cacheEstimate: process.env.GATEWAY_CACHE_ESTIMATE
      ? process.env.GATEWAY_CACHE_ESTIMATE !== "0"
      : cfgFile.cacheEstimate !== false,
  };
}
