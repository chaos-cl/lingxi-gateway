#!/usr/bin/env node
/**
 * 139邮箱 AI工作台（灵犀）→ OpenAI 兼容网关 · CLI 入口
 *
 *   node gateway/server.mjs
 *
 * 端点：
 *   GET  /healthz                  健康检查（含 token 状态）
 *   GET  /v1/models                模型列表（OpenAI 格式）
 *   GET  /v1/models/:id            单模型
 *   POST /v1/chat/completions      对话（stream / 非流式；支持 tools 工具调用）
 *   GET  /admin                    管理面板（连接账号 / 续期 / 用量统计）
 *
 * 实现见 app.mjs（同一套代码也被 desktop 桌面 App 复用）。
 */
import { createGateway } from "./app.mjs";

const gw = createGateway({});
gw.start().catch((e) => {
  console.error("启动失败:", e.message);
  process.exit(1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await gw.stop().catch(() => {});
    process.exit(0);
  });
}
