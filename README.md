# dsh-quick-window-launcher

用桌面快捷方式把 DeepSeek Harness web **以独立的应用窗口（app 窗口）打开**——而不是跳到默认浏览器的标签页——并提供关闭 / 重启电源控制与一个 `open_web` 工具。

插件启动时会：

- **生成桌面快捷方式**（`DeepSeek Harness.lnk`）：若 harness 未在运行则先启动，然后用**专属应用窗口**打开（Chromium / Edge 的 `--app=<url>`，无标签栏、无地址栏）。仅当本机没有安装任何 Chromium 系浏览器时才回退到系统默认浏览器。
- **在侧栏底部新增一个关闭按钮**（⏻）——优雅停止 harness（SIGTERM → 释放资源 → 落盘会话 → 退出）。
- **新增一个重启按钮**（⟳）——优雅停止进程，再由常驻看门狗拉起新实例。
- **在侧栏底部提供三个小巧的纯图标圆钮**（30px，悬停有提示）：关闭 / 重启 / 检查 DSH 更新。
- **新增一个 DSH 更新检查按钮**（⬇）——点击后查询 npm 上 `@deepseek-ai/dsh` 的最新版本，并提示**当前版本**与是否**已是最新**。
- **注册 `open_web` 模型工具**——在系统默认浏览器的**新标签页**打开指定 URL。

所有数据都在运行时从当前 harness 推导——Node 二进制、dsh 入口脚本、工作目录、监听端口，以及 `~/.dsh/logs`。
---

## 安装

该插件面向 `web` 配置文件。用 `dsh` 插件命令添加：

```powershell
dsh plugin --profile web add Yuanloss/dsh-quick-window-launcher
```

然后（重新）启动 harness：

```powershell
dsh web
```

首次启动时，插件会把辅助脚本写入 `%USERPROFILE%\.dsh\logs`、拉起持久重启看门狗，并创建/刷新桌面快捷方式 `DeepSeek Harness.lnk`。

> 新插件 bundle 需要重启才会加载。桌面快捷方式和侧栏按钮会在插件激活后出现。

## 桌面快捷方式做什么

双击桌面上的 **`DeepSeek Harness`**，启动器会：

1. 检查 harness 是否已在端口监听。
2. 若未运行，则（隐藏地）用插件自身运行所用的同一个 Node 二进制 / 入口启动它。
3. 等待 UI 可访问。
4. **以独立应用窗口打开**——找到 Google Chrome 或 Microsoft Edge，用 `--app=<url>` 启动，界面会在它自己的无边框窗口里打开（没有标签栏、没有地址栏）。若没有 Chromium 系浏览器，则回退到默认浏览器。

## 手动创建桌面快捷方式（兜底）

正常情况插件会在启动时自动创建 `DeepSeek Harness.lnk`。若你的桌面被 OneDrive 等重定向、或启动瞬间磁盘未就绪导致没自动生成，可手动执行（二选一）：

**方式 A：运行插件已生成好的脚本**
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.dsh\logs\dsh-ensure-desktop-shortcut.ps1"
```

**方式 B：一条 PowerShell 命令手动创建**
```powershell
$l = "$env:USERPROFILE\.dsh\logs\dsh-launch-web.ps1"
$d = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'DeepSeek Harness.lnk'))
$s.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
$s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$l`""
$s.WorkingDirectory = (Split-Path $l -Parent)
$s.Save()
```

> 创建结果会写入日志 `%USERPROFILE%\.dsh\logs\dsh-shortcut.log`，失败时可直接查看原因。

## 功能

### 关闭
侧栏底部一个红色电源图标。确认后优雅停止 harness——会话数据会落盘，页面关闭（若浏览器拦截 `window.close()`，则改写为“已关闭”提示页）。

### 重启
一个蓝色重启图标，优雅停止进程后拉起重启新实例。重启由**运行在 harness 进程树之外**的看门狗完成（harness 会清理自己的子进程，所以点击时临时 spawn 的进程会被杀掉）。页面显示“正在重启…”界面，轮询到新实例恢复后自动刷新。

### 按钮样式
三个按钮都是 30×30 的纯图标圆钮（关闭 ⏻ 红、重启 ⟳ 蓝、检查 DSH 更新 ⬇ 琥珀），用固定尺寸 + `flex: 0 0 auto` 保证不被侧栏 flex 布局拉伸变形，hover 有 title 提示。不再依赖任何产品 CSS 类名。

### `open_web` 工具
模型可用 `https://…` / `http://…` URL 调用 `open_web`，在系统默认浏览器的新标签页打开——符合 harness“外部打开网页而不是内嵌”的约定。

## 配置项

该行可选配置（通过 profile patch 覆盖）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `createShortcut` | `true` | 启动时生成/刷新桌面快捷方式（指向本插件的应用窗口启动器；设为 `false` 关闭） |
| `desktopName` | `DeepSeek Harness` | 快捷方式的基础文件名 |

示例：

```yaml
- id: quick-window-launcher
  name: 'dsh-quick-window-launcher'
  config:
    createShortcut: true
    desktopName: 'DeepSeek Harness'
```

## 安全

HTTP 路由（`/api/shutdown`、`/api/restart`）只接受回环地址客户端，拒绝跨域请求，且仅接受 POST。`open_web` 只打开 `http://` / `https://` URL。


---

**语言 / Language:** [English](README.en.md) | [中文](README.md)
