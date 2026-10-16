/**
 * 渲染进程安全桥（面板页通过 window.lingxiDesktop 使用桌面能力）
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lingxiDesktop", {
  isDesktop: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** 打开内置邮箱登录助手（登录后自动抓取并保存凭据） */
  openLoginHelper: () => ipcRenderer.invoke("login-helper:open"),
  /** 由本机 Chrome（调试端口）抓取凭据 */
  fetchFromChrome: () => ipcRenderer.invoke("chrome:fetch"),
  /** 凭据更新事件（登录助手/Chrome 抓取成功后推送） */
  onCredentialsUpdated: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("credentials:updated", h);
    return () => ipcRenderer.removeListener("credentials:updated", h);
  },
  /** 网关运行信息 */
  gatewayInfo: () => ipcRenderer.invoke("gateway:info"),
  /** 在系统浏览器打开外链 */
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  /** 退出应用（会一并停止内嵌网关） */
  quit: () => ipcRenderer.send("app:quit"),
});
