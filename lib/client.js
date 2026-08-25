/**
 * dsh-quick-window-launcher — Client half (static bundle).
 *
 * Renders two actions beside Settings at the sidebar foot, via the
 * `sidebar.footer.action` list slot declared by `@deepseek-ai/dsh-client-ui-sidebar`:
 *   - a restart action (blue, ⟳)
 *   - a shutdown action (red, ⏻)
 *
 * Adaptive placement: the slot owner passes each action the column state as
 * `props.wide` (false = 56px rail). When wide, an action renders as a pill with
 * an icon + a text label; in the rail it collapses to a plain icon-only circle.
 * This replaces the previous hard-coded (and version-fragile) CSS-module class
 * targeting — the owner's `wide` prop is the stable contract.
 *
 * Shutdown POSTs to `/api/shutdown`; the host gracefully stops the dsh web
 * process (SIGTERM -> dispose -> flush persistence -> exit). The page is then
 * rewritten to a "closed" note or closed if the browser allows it.
 *
 * Restart POSTs to `/api/restart`; the host drives a detached watchdog that
 * relaunches a fresh instance after this process exits. The page shows a
 * "restarting" wait screen that polls until the fresh instance answers, then
 * reloads — with a long patience window and a manual-refresh fallback so it
 * can never silently dead-end.
 *
 * The reset to a previous build that used class names like `hHd-Xa_root` has
 * been dropped: those are unstable build-hashed selectors, so nothing here
 * targets product CSS.
 */
window.__ModuleLoader__.load({
  id: 'dsh-quick-window-launcher',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    // ── CSS ─────────────────────────────────────────────────────────────
    var STYLE_TAG = 'dsh-quick-window-launcher/sidebar.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + STYLE_TAG + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-quick-window-launcher'
      tag.dataset.pluginCss = STYLE_TAG
      tag.textContent = [
        // Base action: a compact icon-only circle (kept small so several of
        // them fit in one footer row).
        '.dsh-cl-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; cursor: pointer; border: 1px solid transparent; border-radius: 50%; background: transparent; transition: background-color .12s ease, color .12s ease, border-color .12s ease, box-shadow .12s ease; }',
        '.dsh-cl-btn .dsh-cl-ico { font-size: 14px; line-height: 1; }',
        // Footer action container: let the row wrap and align so the update,
        // remote, shutdown and restart actions all stay visible (this restores
        // the layout the previous shutdown-button plugin provided).
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions { align-items: center; gap: 6px; padding: 2px 0 6px; flex-wrap: wrap; }',
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions .cm-footer-stack { flex-direction: row; align-items: center; gap: 6px; width: auto; flex: 0 1 auto; }',
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions .cm-footer-stack .cm-foot { width: auto; height: 28px; padding: 0 8px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.10)); font-size: 12px; }',
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions .cm-footer-stack .cm-foot:hover { background: var(--dsw-alias-interactive-bg-hover); }',
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions .cm-bbox { min-width: 0; }',
        '.hHd-Xa_root:not(.hHd-Xa_collapsed) .hHd-Xa_footerActions .fThDlq_entryRow { flex: none; gap: 4px; }',
        '.dsh-cl-btn:disabled { opacity: .5; cursor: default; }',
        '.dsh-cl-btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-2), 0 0 0 4px var(--dsw-alias-state-error-primary, #e5534b); }',
        // Shutdown action (danger red).
        '.dsh-cl-btn.dsh-cl-shutdown { color: var(--dsw-alias-state-error-primary, #e5534b); }',
        '.dsh-cl-btn.dsh-cl-shutdown:hover { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 14%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 38%, transparent); }',
        '.dsh-cl-btn.dsh-cl-shutdown:active { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #e5534b) 24%, transparent); }',
        '.dsh-cl-btn.dsh-cl-shutdown:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-2), 0 0 0 4px var(--dsw-alias-state-error-primary, #e5534b); }',
        // Restart action (business blue).
        '.dsh-cl-btn.dsh-cl-restart { color: var(--dsw-alias-state-business-primary, #3b82f6); }',
        '.dsh-cl-btn.dsh-cl-restart:hover { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 14%, transparent); border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 38%, transparent); }',
        '.dsh-cl-btn.dsh-cl-restart:active { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 24%, transparent); }',
        '.dsh-cl-btn.dsh-cl-restart:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-2), 0 0 0 4px var(--dsw-alias-state-business-primary, #3b82f6); }',
        // DSH update check action (amber, for "newer harness version").
        '.dsh-cl-btn.dsh-cl-update { color: #f59e0b; }',
        '.dsh-cl-btn.dsh-cl-update:hover { background: color-mix(in srgb, #f59e0b 14%, transparent); border-color: color-mix(in srgb, #f59e0b 38%, transparent); }',
        '.dsh-cl-btn.dsh-cl-update:active { background: color-mix(in srgb, #f59e0b 24%, transparent); }',
        '.dsh-cl-btn.dsh-cl-update:focus-visible { box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-2), 0 0 0 4px #f59e0b; }',
        // Manual-refresh button on the restart wait page.
        '.dsh-cl-retry { margin-top: 18px; padding: 8px 18px; border-radius: 8px; border: 1px solid rgba(59,130,246,.4); background: transparent; color: #93c5fd; font-size: 13px; cursor: pointer; }',
        '.dsh-cl-retry:hover { background: rgba(59,130,246,.12); }',
      ].join(' ')
      document.head.appendChild(tag)
    }

    var React = require('react')

    /**
     * Try to close the current tab/window; the browser may block window.close()
     * (only script-open windows / PWA windows allow it). On failure, rewrite the
     * page into a "closed" notice.
     */
    function closeCurrentPage() {
      try {
        var w = window.open('', '_self', '')
        if (w) { w.close(); return }
      } catch (e) { /* popup blocked -> fall through */ }
      try { window.close() } catch (e) { /* ignore */ }
      setTimeout(function () {
        try {
          if (document.body) {
            document.open()
            document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness 已关闭</title>')
            document.write('<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.box{text-align:center;padding:24px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{font-size:14px;opacity:.75;margin:0 0 20px;line-height:1.6}code{background:rgba(255,255,255,.08);border-radius:4px;padding:2px 6px;font-size:12px}</style></head>')
            document.write('<body><div class="box"><h1>⏻ DeepSeek Harness 已关闭</h1>')
            document.write('<p>当前进程已优雅停止，会话数据已保存。<br>下次使用请双击桌面上的 <code>DeepSeek Harness</code> 快捷方式重新启动。</p>')
            document.write('<p style="font-size:12px;opacity:.5">此页面未自动关闭，可手动关闭此标签页。</p>')
            document.write('</div></body></html>')
            document.close()
          }
        } catch (e2) { /* page already gone */ }
      }, 1200)
    }

    /**
     * Rewrite the page into a "restarting" wait screen. Unlike a fixed-number
     * retry, the poll window is long, the elapsed seconds are shown, and a
     * manual-refresh button is always available so the screen can never dead-end.
     */
    function showRestartingPage() {
      setTimeout(function () {
        try {
          if (document.body) {
            document.open()
            document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>DeepSeek Harness 正在重启</title>')
            document.write('<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;background:#0f1115;color:#e5e7eb;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.box{text-align:center;padding:24px;max-width:420px}h1{font-size:20px;font-weight:600;margin:0 0 12px}p{font-size:14px;opacity:.75;margin:0 0 8px;line-height:1.6}.spin{width:28px;height:28px;margin:0 auto 18px;border:3px solid rgba(255,255,255,.15);border-top-color:#3b82f6;border-radius:50%;animation:dshspin .8s linear infinite}@keyframes dshspin{to{transform:rotate(360deg)}}.warn{color:#fbbf24;font-weight:600;margin-top:10px}.muted{font-size:12px;opacity:.5}</style></head>')
            document.write('<body><div class="box"><div class="spin"></div><h1>DeepSeek Harness 正在重启…</h1>')
            document.write('<p id="dshWait">正在等待服务恢复…</p>')
            document.write('<p class="muted">服务重启通常只需几秒到几十秒。若页面没有自动恢复，可稍后手动刷新。</p>')
            document.write('<button type="button" class="dsh-cl-retry" onclick="window.location.reload()">手动刷新</button>')
            document.write('</div></body></html>')
            document.close()
            // Poll until the fresh instance answers. A GET on /api/shutdown
            // returns 405 once that route exists, which is the "new host up" signal.
            var tries = 0
            var startedAt = Date.now()
            var poll = setInterval(function () {
              tries += 1
              var el = document.getElementById('dshWait')
              var secs = Math.round((Date.now() - startedAt) / 1000)
              if (el) {
                if (secs > 150) {
                  el.innerHTML = '服务长时间未恢复（已等待 ' + secs + ' 秒）。<br><span class="warn">请检查服务是否成功启动</span>，或点击下方按钮手动刷新。'
                } else if (secs > 45) {
                  el.textContent = '已等待 ' + secs + ' 秒，通常很快就好…'
                } else {
                  el.textContent = '已等待 ' + secs + ' 秒…'
                }
              }
              fetch('/api/shutdown', { method: 'GET' }).then(function (r) {
                if (r.status === 405) { clearInterval(poll); window.location.reload() }
              }).catch(function () { /* not ready yet; keep waiting */ })
              if (tries > 240) clearInterval(poll)
            }, 1500)
          }
        } catch (e2) { /* ignore */ }
      }, 300)
    }

    /** Shutdown button: confirm + POST /api/shutdown. Adapts to rail/wide. */
    function ShutdownAction(props) {
      var [pending, setPending] = React.useState(false)
      var onClick = function () {
        if (pending) return
        var ok = window.confirm('确定要关闭 DeepSeek Harness 吗？\n\n当前进程将被优雅停止（会话数据会保存），页面也会随之关闭。下次使用请双击桌面上的 "DeepSeek Harness" 快捷方式重新启动。')
        if (!ok) return
        setPending(true)
        fetch('/api/shutdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.ok) { setTimeout(closeCurrentPage, 400) }
            else { window.alert('关闭请求失败：' + ((j && j.error && j.error.message) || '未知错误')); setPending(false) }
          })
          .catch(function () { setTimeout(closeCurrentPage, 400) })
      }
      var title = pending ? '正在关闭…' : '关闭 DeepSeek Harness'
      return React.createElement(
        'button',
        { type: 'button', className: 'dsh-cl-btn dsh-cl-shutdown', title: title, 'aria-label': title, disabled: pending, onClick: onClick },
        React.createElement('span', { className: 'dsh-cl-ico' }, pending ? '…' : '⏻'),
      )
    }

    /** Restart button: confirm + POST /api/restart. Adapts to rail/wide. */
    function RestartAction(props) {
      var [pending, setPending] = React.useState(false)
      var onClick = function () {
        if (pending) return
        var ok = window.confirm('确定要重启 DeepSeek Harness 吗？\n\n进程将被优雅停止后自动重新启动（会话数据会保存）。页面会自动恢复，无需手动操作。')
        if (!ok) return
        setPending(true)
        fetch('/api/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.ok) { showRestartingPage() }
            else { window.alert('重启请求失败：' + ((j && j.error && j.error.message) || '未知错误')); setPending(false) }
          })
          .catch(function () { showRestartingPage() })
      }
      var title = pending ? '正在重启…' : '重启 DeepSeek Harness'
      return React.createElement(
        'button',
        { type: 'button', className: 'dsh-cl-btn dsh-cl-restart', title: title, 'aria-label': title, disabled: pending, onClick: onClick },
        React.createElement('span', { className: 'dsh-cl-ico' }, pending ? '…' : '⟳'),
      )
    }

    /** DSH update check: ask the host for current vs latest @deepseek-ai/dsh version. */
    function DshUpdateAction(props) {
      var [pending, setPending] = React.useState(false)
      var onClick = function () {
        if (pending) return
        setPending(true)
        fetch('/api/dsh-update-check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json() })
          .then(function (j) {
            setPending(false)
            if (j && j.ok && j.value) {
              var v = j.value
              var cur = v.current || 'unknown'
              var latest = v.latest || ''
              var msg
              if (v.updateAvailable) {
                msg = '发现 DSH 新版本！\n\n当前版本：v' + cur + '\n最新版本：v' + latest + '\n\n升级命令：\nnpm install -g @deepseek-ai/dsh@latest\n然后重启 dsh web。'
              } else if (cur === 'unknown') {
                msg = '无法确定当前 DSH 版本。\nnpm 最新版本：v' + latest
              } else {
                msg = 'DSH 已是最新版本：v' + cur + '\n（npm 最新 v' + latest + '）'
              }
              window.alert(msg)
            } else {
              var err = ((j && j.value && j.value.error) || (j && j.error && j.error.message) || '未知错误')
              window.alert('检查 DSH 更新失败：' + err)
            }
          })
          .catch(function () { setPending(false); window.alert('检查 DSH 更新失败：无法连接 DSH 服务。') })
      }
      var title = pending ? '正在检查更新…' : '检查 DSH 更新'
      return React.createElement(
        'button',
        { type: 'button', className: 'dsh-cl-btn dsh-cl-update', title: title, 'aria-label': title, disabled: pending, onClick: onClick },
        React.createElement('span', { className: 'dsh-cl-ico' }, pending ? '…' : '⬇'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => {
          var disposers = []
          disposers.push(ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'restart',
            order: 99,
            registrant: 'dsh-quick-window-launcher',
          }, RestartAction))
          disposers.push(ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'dsh-update-check',
            order: 98,
            registrant: 'dsh-quick-window-launcher',
          }, DshUpdateAction))
          disposers.push(ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'shutdown',
            order: 100,
            registrant: 'dsh-quick-window-launcher',
          }, ShutdownAction))
          return function () { for (var i = 0; i < disposers.length; i++) disposers[i]() }
        }))
      },
    }
  },
})
