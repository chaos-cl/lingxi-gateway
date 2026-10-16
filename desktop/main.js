/**
 * 灵犀网关 · 桌面控制台（Electron 主进程）
 *
 *  职责：
 *   1. 内嵌启动网关（复用 gateway/app.mjs，无独立 Node 进程）
 *   2. 主窗口加载管理面板（gateway/web/panel.html，经 http 提供）
 *   3. 邮箱登录助手：内嵌窗口登录 mail.10086.cn → 自动读取 cookie（含 httpOnly）→ 验证铸造 → 保存
 *   4. 本机 Chrome（调试端口）抓取凭据的桥接
 *
 * 说明：139 会话 sid 与 cookie 中的 Os_Sso_Sid 一致（实测），因此登录助手只需读 cookie。
 */
const { app, BrowserWindow, ipcMain, shell, Menu, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const GATEWAY_DIR = path.join(__dirname, "..", "gateway");
// 打包后 gateway 代码在只读的 asar 内；凭据/配置/用量必须落到用户数据目录
const DATA_DIR = app.getPath("userData");
const MAIL_ENTRY = "https://mail.10086.cn/";
const MAIL_COOKIE_URLS = [
  "https://smsrebuild10.mail.10086.cn/file/disk",
  "https://appmail10.mail.10086.cn/",
  "https://mail.10086.cn/",
];

let gw = null;            // 内嵌网关实例
let mainWindow = null;
let loginWindow = null;
let loginPoll = null;
let gatewayPort = 0;
const logs = [];          // 最近日志（供面板/诊断）

async function importGateway() {
  // gateway 是 ESM，主进程用动态 import
  return await import(pathToFileURL(path.join(GATEWAY_DIR, "app.mjs")).href);
}

function pushLog(line) {
  console.log(line);
  logs.push({ ts: Date.now(), line });
  if (logs.length > 500) logs.shift();
  mainWindow?.webContents.send("gateway:log", { ts: Date.now(), line });
}

async function startGateway() {
  ensureUserData();
  const { createGateway } = await importGateway();
  gw = createGateway({ onLog: pushLog, dataDir: DATA_DIR });
  gatewayPort = await gw.start();
  return gatewayPort;
}

/** 首次运行：准备用户数据目录；开发场景下自动迁移仓库里的凭据（打包产物不含凭据） */
function ensureUserData() {
  try {
    fs.mkdirSync(path.join(DATA_DIR, "data"), { recursive: true });
    const target = path.join(DATA_DIR, "credentials.json");
    const devSource = path.join(GATEWAY_DIR, "credentials.json");
    if (!fs.existsSync(target) && fs.existsSync(devSource)) {
      fs.copyFileSync(devSource, target);
      fs.chmodSync(target, 0o600);
      pushLog("[账号] 已从开发目录迁移凭据到用户数据目录");
    }
  } catch { /* ignore */ }
}

/* ---------------- 凭据：会话 cookie → 凭据对象 ---------------- */

function cookiesToHeader(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(`${c.name}=${c.value}`);
  }
  return out.join("; ");
}

async function readMailCredentials(session) {
  const merged = [];
  const seen = new Set();
  for (const url of MAIL_COOKIE_URLS) {
    const list = await session.cookies.get({ url });
    for (const c of list) {
      if (seen.has(c.name)) continue;
      seen.add(c.name);
      merged.push(c);
    }
  }
  const sidCookie = merged.find((c) => c.name === "Os_SSo_Sid");
  return {
    sid: sidCookie?.value || "",
    cookie: cookiesToHeader(merged),
    cookieCount: merged.length,
    hasRmkey: merged.some((c) => c.name === "RMKEY"),
  };
}

/** 用凭据实战验证一次铸造（走网关同款逻辑，避免脏数据落盘） */
async function verifyCredentials(sid, cookie) {
  const { TokenManager } = await import(pathToFileURL(path.join(GATEWAY_DIR, "token.mjs")).href);
  const probe = new TokenManager({ sid, cookie });
  const t = await probe.mint();
  return { phone: t.phone, userId: t.userId, expiresAt: t.expiryMs };
}

/* ---------------- 邮箱登录助手 ---------------- */

const MAIL_PARTITION = "persist:mail139";

async function openLoginHelper() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { ok: true, reused: true };
  }
  const session = require("electron").session.fromPartition(MAIL_PARTITION);

  // 已登录过（持久分区里有有效凭据）→ 先尝试直接抓取，省去重复登录
  const existing = await readMailCredentials(session);
  if (existing.sid && existing.cookieCount > 5) {
    const v = await verifyCredentials(existing.sid, existing.cookie).catch((e) => ({ error: e.message }));
    if (!v.error) {
      gw.saveCredentials({ sid: existing.sid, cookie: existing.cookie });
      await gw.tokens.get(true).catch(() => null);
      notifyCredentials({ source: "login-helper-cached", ...v, cookieCount: existing.cookieCount });
      return { ok: true, cached: true, phone: v.phone };
    }
  }

  loginWindow = new BrowserWindow({
    width: 1120,
    height: 820,
    title: "登录 139 邮箱 · 登录完成后凭据会自动抓取",
    autoHideMenuBar: true,
    webPreferences: {
      partition: MAIL_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  loginWindow.loadURL(MAIL_ENTRY);

  // 轮询 cookie：检测到有效凭据即验证保存并关窗（最多 15 分钟）
  const deadline = Date.now() + 15 * 60 * 1000;
  loginPoll = setInterval(async () => {
    if (Date.now() > deadline) {
      stopLoginPoll();
      return;
    }
    try {
      const cred = await readMailCredentials(session);
      if (!cred.sid || cred.cookieCount < 5) return;
      const v = await verifyCredentials(cred.sid, cred.cookie);
      gw.saveCredentials({ sid: cred.sid, cookie: cred.cookie });
      await gw.tokens.get(true).catch(() => null);
      stopLoginPoll();
      notifyCredentials({ source: "login-helper", ...v, cookieCount: cred.cookieCount });
      if (loginWindow && !loginWindow.isDestroyed()) loginWindow.close();
    } catch {
      /* 尚未登录完成 / 验证失败：继续等待 */
    }
  }, 2500);

  loginWindow.on("closed", () => { loginWindow = null; stopLoginPoll(); });
  return { ok: true, opened: true };
}

function stopLoginPoll() {
  if (loginPoll) { clearInterval(loginPoll); loginPoll = null; }
}

function notifyCredentials(payload) {
  pushLog(`[账号] 凭据已更新：${payload.phone || ""}（来源 ${payload.source}，cookie ${payload.cookieCount} 项）`);
  mainWindow?.webContents.send("credentials:updated", payload);
}

/* ---------------- 本机 Chrome 抓取 ---------------- */

async function fetchFromChrome() {
  const { fetchCredentialsFromChrome } = await import(pathToFileURL(path.join(GATEWAY_DIR, "cdp.mjs")).href);
  const found = await fetchCredentialsFromChrome();
  if (!found.ok) return found;
  const v = await verifyCredentials(found.sid, found.cookie).catch((e) => ({ error: e.message }));
  if (v.error) return { ok: false, reason: "verify_failed", detail: `抓取到凭据但验证失败：${v.error}` };
  gw.saveCredentials({ sid: found.sid, cookie: found.cookie });
  await gw.tokens.get(true).catch(() => null);
  notifyCredentials({ source: "chrome-cdp", ...v, cookieCount: found.cookieCount });
  return { ok: true, browser: found.browser, cookieCount: found.cookieCount, ...v };
}

/* ---------------- 窗口 ---------------- */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    title: "灵犀网关 · 控制台",
    backgroundColor: "#0b1220",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${gatewayPort}/admin`);
  // 渲染进程日志与加载失败 → 主进程日志（便于诊断面板问题）
  mainWindow.webContents.on("console-message", (...args) => {
    const d = args[1];
    const msg = d && typeof d === "object" ? d.message : args[2];
    const line = d && typeof d === "object" ? d.lineNumber : args[3];
    pushLog(`[渲染] ${msg}${line ? " @" + line : ""}`);
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => pushLog(`[渲染] 加载失败 ${code} ${desc} ${url}`));
  mainWindow.webContents.on("render-process-gone", (_e, details) => pushLog(`[渲染] 进程退出: ${JSON.stringify(details)}`));
  mainWindow.on("closed", () => { mainWindow = null; });

  // 自检模式（LINGXI_SELFTEST=1）：窗口加载后跑渲染进程诊断 + 截图，便于无人值守验收
  if (process.env.LINGXI_SELFTEST === "1") {
    mainWindow.webContents.once("did-finish-load", async () => {
      await new Promise((r) => setTimeout(r, 3500));
      // 窗口被其他应用遮挡时 capturePage 只会返回旧帧 → 短暂置顶保证真实绘制
      try { mainWindow.showInactive(); mainWindow.setAlwaysOnTop(true, "floating"); mainWindow.moveTop(); } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 900));
      const shot = async (file) => {
        const img = await mainWindow.webContents.capturePage();
        require("node:fs").writeFileSync(file, img.toPNG());
      };
      try {
        const diag = await mainWindow.webContents.executeJavaScript(`(async () => {
          const out = { bridge: !!window.lingxiDesktop, tokenDefined: typeof TOKEN !== 'undefined' };
          try {
            const r = await fetch('/admin/api/status', { headers: { 'X-Admin-Token': TOKEN } });
            out.statusHttp = r.status;
            const d = await r.json();
            out.version = d.version;
            out.sidMasked = d.credentials && d.credentials.sidMasked;
            out.cookieCount = d.credentials && d.credentials.cookieCount;
            out.tokenCached = d.token && d.token.cached;
          } catch (e) { out.fetchErr = String(e); }
          out.footState = document.querySelector('#footState')?.textContent;
          out.kPhone = document.querySelector('#kPhone')?.textContent;
          out.kExpiry = document.querySelector('#kExpiry')?.textContent;
          out.usageRows = document.querySelectorAll('#miniModels tr').length;
          out.bars = document.querySelectorAll('#miniBars .bar').length;
          out.activeTab = document.querySelector('nav a.active')?.textContent?.trim();
          return out;
        })()`);
        pushLog("[自检] " + JSON.stringify(diag));
        await shot("/tmp/lingxi-selftest.png");
        pushLog("[自检] 截图1 总览 ✓");
        // 追加：切到「账号与续期」再截一张
        await mainWindow.webContents.executeJavaScript(`document.querySelector('nav a[data-tab="account"]').click(); true;`);
        await new Promise((r) => setTimeout(r, 1200));
        await shot("/tmp/lingxi-selftest-account.png");
        pushLog("[自检] 截图2 账号 ✓");
        // 再切「调用统计」
        await mainWindow.webContents.executeJavaScript(`document.querySelector('nav a[data-tab="usage"]').click(); true;`);
        await new Promise((r) => setTimeout(r, 1800));
        await shot("/tmp/lingxi-selftest-usage.png");
        // 再切「调用日志」
        await mainWindow.webContents.executeJavaScript(`document.querySelector('nav a[data-tab="logs"]').click(); true;`);
        await new Promise((r) => setTimeout(r, 1200));
        await shot("/tmp/lingxi-selftest-logs.png");
        try { mainWindow.setAlwaysOnTop(false); } catch { /* ignore */ }
        pushLog("[自检] 完成，四张截图就绪");
        setTimeout(() => app.quit(), 1500); // 自检模式：完成后退出，避免占用端口
      } catch (e) {
        pushLog("[自检] 失败: " + (e && e.message));
      }
    });
  }
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "网关",
      submenu: [
        { label: "刷新面板", accelerator: "CmdOrCtrl+R", click: () => mainWindow?.reload() },
        { label: "打开邮箱登录助手", accelerator: "CmdOrCtrl+L", click: () => openLoginHelper() },
        { label: "从本机 Chrome 抓取凭据", click: () => fetchFromChrome() },
        { type: "separator" },
        { label: "在浏览器打开面板", click: () => shell.openExternal(`http://127.0.0.1:${gatewayPort}/admin`) },
        { label: "复制 Base URL", click: () => require("electron").clipboard.writeText(`http://127.0.0.1:${gatewayPort}/v1`) },
        { type: "separator" },
        { label: "查看网关日志", click: showLogs },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function showLogs() {
  const text = logs.slice(-200).map((l) => new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false }) + "  " + l.line).join("\n");
  dialog.showMessageBox(mainWindow, { title: "网关日志", message: "最近日志", detail: text || "(无)", buttons: ["确定"], type: "info" });
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle("login-helper:open", async () => {
    try { return await openLoginHelper(); }
    catch (e) { return { ok: false, reason: "error", detail: e.message }; }
  });
  ipcMain.handle("chrome:fetch", async () => {
    try { return await fetchFromChrome(); }
    catch (e) { return { ok: false, reason: "error", detail: e.message }; }
  });
  ipcMain.handle("gateway:info", () => ({
    port: gatewayPort,
    baseUrl: `http://127.0.0.1:${gatewayPort}/v1`,
    adminToken: gw?.adminToken || "",
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    logs: logs.slice(-100),
  }));
  ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));
  ipcMain.on("app:quit", () => app.quit());
}

/* ---------------- 生命周期 ---------------- */

app.whenReady().then(async () => {
  try {
    await startGateway();
  } catch (e) {
    dialog.showErrorBox("网关启动失败", String(e.message || e));
    app.quit();
    return;
  }
  registerIpc();
  buildMenu();
  createMainWindow();

  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", async () => { stopLoginPoll(); try { await gw?.stop(); } catch { /* ignore */ } });
