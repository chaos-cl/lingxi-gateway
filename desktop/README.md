# 灵犀网关 · 桌面控制台

把 139 邮箱 AI 工作台（灵犀/MClaw）反代成 OpenAI 兼容 API 的**桌面管理程序**：内嵌网关 + 图形界面，用于连接账号、续期凭据和查看各模型调用量。

## 启动

依赖与 npm scripts 统一在**仓库根目录**（Electron 是单一依赖源）：

```bash
cd ..                # 回到仓库根目录
npm install          # 首次（国内可加 --registry=https://registry.npmmirror.com）
npm start            # 启动桌面控制台
```

也可以直接双击 `启动灵犀网关.command`（macOS，脚本会自动切到仓库根目录安装依赖并启动）。

启动后：

- 内嵌网关监听 **127.0.0.1:8317**（与 CLI 模式端口一致，二者互斥）
- 主窗口即管理控制台；菜单栏「网关」提供快捷操作（打开登录助手 `⌘L`、复制 Base URL、查看日志等）

## 功能

| 页面 | 能力 |
|---|---|
| **总览** | 账号（手机号/sid/cookie 状态）、Token 有效期倒计时、今日调用与 tokens、近 14 天趋势、模型分布 |
| **账号与续期** | ① **App 内置登录助手**：弹出窗口登录 139 邮箱，登录完成后自动读取 cookie（含 httpOnly 的 RMKEY / Os_Sso_Sid）→ 验证铸造 → 保存，登录态持久化<br>② 从本机 Chrome 抓取（需 `--remote-debugging-port=9222`）<br>③ 粘贴导入 sid + cookie（自动从 `Os_SSo_Sid` 提取 sid）<br>④ 一键重铸 Token |
| **调用统计** | 按模型 × 按天：调用次数、输入/输出字数、估算 tokens、平均耗时、成功率；近 7/14/30/90 天 |
| **调用日志** | 最近请求明细（模型、思考/联网/工具标记、耗时、成功失败） |
| **模型** | 139 上游 10 个模型及累计用量 |
| **设置** | 端口、默认模型、网关 API Key |

## 凭据工作原理

```
App 内置 Chromium ──登录 mail.10086.cn──▶ 读取 session cookie（含 httpOnly）
                                             │  sid 取自 cookie 的 Os_SSo_Sid
                                             ▼
                        TokenManager.mint() 验证（铸造 Basic token）
                                             ▼
                       凭据落盘（0600 权限，仅本地）
                       · CLI：gateway/credentials.json
                       · 桌面版：Electron 用户数据目录
```

- 登录助手使用持久化分区（`persist:mail139`），**首次登录后日常续期无需重复登录**；已登录时会直接抓取，窗口一闪而过
- Token 有效期约 25 天，网关到期前 1 天自动重铸；sid 会话过期（约 30 天）时才需重新登录一次

## 架构

```
desktop/
├── main.js      主进程：内嵌网关（import ../gateway/app.mjs）+ 主窗口 + 登录助手 + IPC
└── preload.js   contextBridge 安全桥（渲染进程仅能访问白名单能力）

../gateway/
├── app.mjs      可编程网关工厂（CLI 与桌面版共用同一套实现）
├── admin.mjs    管理 API（状态/凭据/续期/用量/配置）
├── usage.mjs    调用记录（data/usage.jsonl）与聚合
├── cdp.mjs      本机 Chrome（调试端口）凭据抓取
└── web/panel.html  管理面板（零依赖单文件，CLI 模式下浏览器访问 /admin 同样可用）
```

数据目录：CLI 模式用 `gateway/data/` 与 `gateway/credentials.json`；桌面版用 Electron 用户数据目录（macOS：`~/Library/Application Support/灵犀网关/`，Windows：`%APPDATA%\灵犀网关\`），首次运行会自动从开发目录迁移已有凭据。

CLI 模式（`node gateway/server.mjs`）与桌面版是同一套网关代码，二者**不要同时启动**（端口冲突）。
