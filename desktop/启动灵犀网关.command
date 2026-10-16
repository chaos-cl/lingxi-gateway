#!/bin/bash
# 双击启动「灵犀网关」桌面控制台（macOS）
# 注意：依赖与 npm scripts 都在仓库根目录，这里切换到上一级
cd "$(dirname "$0")/.." || exit 1
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖（需要几分钟，Electron 二进制较大）…"
  npm install --no-audit --no-fund --registry=https://registry.npmmirror.com || { echo "依赖安装失败"; read -r; exit 1; }
fi
npm start
