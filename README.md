# dsh-quick-window-launcher

用桌面快捷方式把 DeepSeek Harness web **以独立的应用窗口（app 窗口）打开**——而不是跳到默认浏览器的标签页——并提供关闭 / 重启电源控制与一个 `open_web` 工具。

插件启动时会：

- **生成桌面快捷方式**（`DeepSeek Harness.lnk`）：若 harness 未在运行则先启动，然后用**专属应用窗口**打开（Chromium / Edge 的 `--app=<url>`，无标签栏、无地址栏）。仅当本机没有安装任何 Chromium 系浏览器时才回退到系统默认浏览器。
- **在侧栏底部新增一个关闭按钮**（⏻）——优雅停止 harness（SIGTERM → 释放资源 → 落盘会话 → 退出）。
- **新增一个重启按钮**（⟳）——优雅停止进程，再由常驻看门狗拉起新实例。
- **在侧栏底部提供一组分段式电源控制按钮**：玻璃胶囊内三个纯图标分段（悬停有光晕与提示）——关闭 / 重启 / 检查 DSH 更新；侧栏收起时自动退化为独立的红色电源圆钮。
- **新增一个 DSH 更新检查按钮**（⬇）——点击后查询 npm 上 `@deepseek-ai/dsh` 的最新版本，提示**当前版本**与是否**已是最新**；发现新版本时**可一键打开可见终端执行更新**（npm 输出与权限提示全程可见，命令也会复制到剪贴板），完成后点「重启」按钮生效。
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

首次启动时，插件会把两个**纯 Node 辅助脚本**（`.cjs`）写入 `%USERPROFILE%\.dsh\logs`、拉起持久重启看门狗（同样是 node 进程），并创建/刷新桌面快捷方式 `DeepSeek Harness.lnk`（快捷方式直接指向 `node.exe`）。**全程不写任何 `.ps1` 文件、不依赖 PowerShell 运行时**——避免被火绒等杀毒软件按“新建 PowerShell 脚本”启发式直接隔离（实测复现过该问题，本版为此重写了整个宿主侧实现）。

> 新插件 bundle 需要重启才会加载。桌面快捷方式和侧栏按钮会在插件激活后出现。

## 桌面快捷方式做什么

双击桌面上的 **`DeepSeek Harness`**（目标就是 `node.exe dsh-launch-web.cjs`），启动器会：

1. 检查 harness 是否已在端口监听。
2. **多信号存活判定**：若端口未监听，还会检查任务看板账本锁（`~/.dsh/task-board/ledger-v2.lock`）的主人 PID 是否存活——若旧实例**活着但没在服务**，启动器**不会**再拉起第二个实例（那会撞上其他插件的单实例锁而死），而是写出诊断页与 `dsh-launcher.log` 并退出。
3. 若确实未运行，则（隐藏地）用插件自身运行所用的同一个 Node 二进制 / 入口启动它。
4. 等待 UI 可访问（若启动的实例提前退出，会写错误页而不是打开指向死端口的窗口）。
5. **以独立应用窗口打开**——找到 Google Chrome 或 Microsoft Edge，用 `--app=<url>` 启动，界面会在它自己的无边框窗口里打开。若没有 Chromium 系浏览器，则回退到默认浏览器。

每次启动的动作（端口/锁判定、spawn、就绪、开窗）都会写入 `~/.dsh/logs/dsh-launcher.log`；排查问题可运行：

```powershell
node "$env:USERPROFILE\.dsh\logs\dsh-launch-web.cjs" --diagnose
```

它会打印端口状态、任务板锁主人、看门狗心跳与最近日志。

## 手动创建桌面快捷方式（兜底）

正常情况插件会在每次启动时自动刷新 `DeepSeek Harness.lnk`。若极端情况下没生成（如桌面被 OneDrive 重定向且长时间未挂载），可手动执行一条命令重建：

```powershell
$l = "$env:USERPROFILE\.dsh\logs\dsh-launch-web.cjs"
$d = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d 'DeepSeek Harness.lnk'))
$s.TargetPath = (Get-Command node).Source
$s.Arguments = "`"$l`""
$s.WorkingDirectory = Split-Path $l -Parent
$s.Save()
```

> 插件自动刷新的结果会写入日志 `%USERPROFILE%\.dsh\logs\dsh-shortcut.log`，失败时可直接查看原因。

## 功能

### 关闭
侧栏底部一个红色电源图标。确认后优雅停止 harness——会话数据会落盘，页面关闭（若浏览器拦截 `window.close()`，则改写为“已关闭”提示页）。

### 重启
一个蓝色重启图标，优雅停止进程后拉起重启新实例。重启由**运行在 harness 进程树之外**的看门狗完成（harness 会清理自己的子进程，所以点击时临时 spawn 的进程会被杀掉）。页面显示“正在重启…”界面，轮询到新实例恢复后自动刷新。

看门狗带**心跳自愈与锁释放**：每处理完一次重启立即恢复监听，任何瞬时异常也会释放锁并留下日志，绝不会在第一次重启后“失聪”忽略后续请求（v0.2.5 修复了旧版此问题）。

### `open_web` 工具
模型可用 `https://…` / `http://…` URL 调用 `open_web`，在系统默认浏览器的新标签页打开——符合 harness“外部打开网页而不是内嵌”的约定。

## 配置项

该行可选配置（通过 profile patch 覆盖）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `createShortcut` | `true` | 启动时生成/刷新桌面快捷方式（指向本插件的应用窗口启动器；设为 `false` 关闭） |
| `desktopName` | `DeepSeek Harness` | 快捷方式的基础文件名 |
| `desktopPath` | （自动解析） | **手动指定桌面目录**（OneDrive 重定向、网络盘等自动解析失败时用）。解析优先级：`desktopPath` → Windows 注册表 `User Shell Folders\Desktop`（纯 Node 读取）→ `~/Desktop` |
| `watchdog` | `true` | 启动时写入并拉起重启看门狗（`/api/restart` 依赖它；设为 `false` 后重启按钮退化为仅关闭） |

示例：

```yaml
- id: quick-window-launcher
  name: 'dsh-quick-window-launcher'
  config:
    createShortcut: true
    desktopName: 'DeepSeek Harness'
    watchdog: true
```

## 安全

HTTP 路由（`/api/shutdown`、`/api/restart`）只接受回环地址客户端，拒绝跨域请求，且仅接受 POST。`open_web` 只打开 `http://` / `https://` URL。

### 杀毒软件说明（v0.2.6 起适用）

旧版实现会在 `%USERPROFILE%\.dsh\logs` 写入 `.ps1` 辅助脚本并用 PowerShell 执行——**实测火绒会把任何新建的 `.ps1` 直接隔离删除**，导致看门狗、启动器、快捷方式全部失效。**本版彻底移除 `.ps1` 文件**：

- 看门狗与应用窗口启动器都是**纯 Node `.cjs` 脚本**，由 node.exe 直接运行；桌面快捷方式的目标就是 `node.exe + .cjs`，与任何开发工具无异；
- 快捷方式的创建/刷新是启动时**一次性内联命令**（调用系统 COM），不在磁盘上留下任何脚本文件；且以**可见最小化**方式派生——实测隐藏窗口派生的 powershell 会被火绒静默杀掉（快捷方式静默消失的根因），而可见控制台下的 powershell 一直正常。代价是启动瞬间有一个一闪而过的最小化窗口；
- 打开网页用 `rundll32 url.dll,FileProtocolHandler`（Windows 经典方式）或系统原生 `open` / `xdg-open`；
- 全部脚本明文可读、无混淆无编码载荷，不触碰注册表、计划任务、服务或开机启动项；
- 所有网络访问只有：回环端口探测 + npm registry 版本查询。

常驻的只有一个 node.exe 看门狗进程（每秒轮询一次请求文件）。若不接受，把配置里的 `watchdog` 设为 `false`；卸载插件后可结束该 node.exe 进程并删除 `%USERPROFILE%\.dsh\logs` 下的 `dsh-restart-watchdog*` / `dsh-launch-web.cjs` 文件。若你的杀软曾隔离过旧版 `.ps1` 文件，升级后无需恢复它们——新版已不再使用；也可以把 `%USERPROFILE%\.dsh\logs` 加入杀软信任区以绝后患。


---

**语言 / Language:** [English](README.en.md) | [中文](README.md)
