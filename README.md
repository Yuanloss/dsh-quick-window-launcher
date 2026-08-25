# dsh-quick-window-launcher

用桌面快捷方式把 DeepSeek Harness web **以独立的应用窗口（app 窗口）打开**——而不是跳到默认浏览器的标签页——并提供关闭 / 重启电源控制与一个 `open_web` 工具。

插件启动时会：

- **生成桌面快捷方式**（`DeepSeek Harness.lnk`）：若 harness 未在运行则先启动，然后用**专属应用窗口**打开（Chromium / Edge 的 `--app=<url>`，无标签栏、无地址栏）。仅当本机没有安装任何 Chromium 系浏览器时才回退到系统默认浏览器。
- **在侧栏底部新增一个关闭按钮**（⏻）——优雅停止 harness（SIGTERM → 释放资源 → 落盘会话 → 退出）。
- **新增一个重启按钮**（⟳）——优雅停止进程，再由常驻看门狗拉起新实例。
- **让两个按钮自适应侧栏**（56px 收起态显示纯图标圆钮，展开态显示 图标+文字 徽章）。
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

首次启动时，插件会把辅助脚本写入 `%USERPROFILE%\.dsh\logs`、拉起持久重启看门狗，并创建桌面快捷方式（仅当其不存在时——绝不会覆盖你自己创建的快捷方式）。

> 新插件 bundle 需要重启才会加载。桌面快捷方式和侧栏按钮会在插件激活后出现。

## 桌面快捷方式做什么

双击桌面上的 **`DeepSeek Harness`**，启动器会：

1. 检查 harness 是否已在端口监听。
2. 若未运行，则（隐藏地）用插件自身运行所用的同一个 Node 二进制 / 入口启动它。
3. 等待 UI 可访问。
4. **以独立应用窗口打开**——找到 Google Chrome 或 Microsoft Edge，用 `--app=<url>` 启动，界面会在它自己的无边框窗口里打开（没有标签栏、没有地址栏）。若没有 Chromium 系浏览器，则回退到默认浏览器。

## 功能

### 关闭
侧栏底部一个红色电源图标。确认后优雅停止 harness——会话数据会落盘，页面关闭（若浏览器拦截 `window.close()`，则改写为“已关闭”提示页）。

### 重启
一个蓝色重启图标，优雅停止进程后拉起重启新实例。重启由**运行在 harness 进程树之外**的看门狗完成（harness 会清理自己的子进程，所以点击时临时 spawn 的进程会被杀掉）。页面显示“正在重启…”界面，轮询到新实例恢复后自动刷新。

### 自适应位置（`props.wide`）
两个按钮都使用 `sidebar.footer.action` 槽位传下来的侧栏 `wide` 列状态：收起态是纯图标圆钮，展开态是 图标+文字 徽章。不再针对任何产品 CSS 类名。

### `open_web` 工具
模型可用 `https://…` / `http://…` URL 调用 `open_web`，在系统默认浏览器的新标签页打开——符合 harness“外部打开网页而不是内嵌”的约定。

## 配置项

该行可选配置（通过 profile patch 覆盖）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `createShortcut` | `true` | 启动时生成桌面快捷方式（设为 `false` 关闭） |
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
