/**
 * dsh-quick-window-launcher — Client half (static bundle).
 *
 * Renders ONE grouped action cluster beside Settings at the sidebar foot, via
 * the `sidebar.footer.action` list slot declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`:
 *   - a DSH update check (amber, ⬇)
 *   - a restart action (blue, ⟳)
 *   - a shutdown action (red, ⏻)
 *
 * Anti-clipping layout: the product flows this slot's occupants inline next to
 * the cost-meter panel, and a narrow sidebar clips the trailing part of that
 * line (verified pixel-level: only the first two ~30px occupants stayed
 * visible; individually-registered trailing buttons vanished). Registering all
 * three buttons as a SINGLE self-contained, flex-wrappable group makes partial
 * clipping impossible — the trio either fits on the current line or wraps onto
 * its own line below, always fully visible.
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
        // Only the restart-page "manual refresh" button is styled via CSS. The
        // sidebar footer buttons use inline styles instead: they are immune to
        // product stylesheet rules and never leak into other plugins' styles.
        '.dsh-cl-retry { margin-top: 18px; padding: 8px 18px; border-radius: 8px; border: 1px solid rgba(59,130,246,.4); background: transparent; color: #93c5fd; font-size: 13px; cursor: pointer; }',
        '.dsh-cl-retry:hover { background: rgba(59,130,246,.12); }',
      ].join(' ')
      document.head.appendChild(tag)
    }

    var React = require('react')

    /**
     * Build one compact 26px circle action button. Icon-only on purpose: the
     * footer action line is shared with cost-panel text and other plugins'
     * buttons, so its free width is unpredictable across installs — labeled
     * pills clipped the trailing button at default sidebar width. A fixed
     * ~90px icon trio always fits; each button carries a `title` tooltip and
     * a distinct accent color for readability. Inline styles only: the
     * product's own stylesheet cannot stretch or hide the button, and no CSS
     * is injected into the page (zero effect on other plugins).
     * @param {object} o - { color, ico, title, pending, onClick, hover, setHover }.
     * @returns {object} the React button element.
     */
    function roundBtn(o) {
      return React.createElement(
        'button',
        {
          type: 'button',
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '26px',
            height: '26px',
            minWidth: '26px',
            maxWidth: '26px',
            flex: '0 0 auto',
            margin: '0',
            padding: '0',
            border: '1px solid transparent',
            borderRadius: '50%',
            background: o.hover ? hexA(o.color, 0.18) : 'rgba(127, 127, 127, 0.16)',
            cursor: o.pending ? 'wait' : 'pointer',
            color: o.color,
          },
          title: o.title,
          'aria-label': o.title,
          disabled: !!o.pending,
          onClick: o.onClick,
          onMouseEnter: function () { o.setHover(true) },
          onMouseLeave: function () { o.setHover(false) },
        },
        React.createElement('span', { style: BTN_ICO }, o.ico),
      )
    }

    /** Convert a #rrggbb color to an rgba string with the given alpha. */
    function hexA(hex, a) {
      var r = parseInt(hex.slice(1, 3), 16)
      var g = parseInt(hex.slice(3, 5), 16)
      var b = parseInt(hex.slice(5, 7), 16)
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')'
    }

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

    // Shared inline style pieces for the footer buttons. Buttons are built
    // with inline styles only (see roundBtn) so the product stylesheet can
    // never stretch or hide them; the single wrap-enabling declaration for
    // the slot container is injected separately in apply() and documented
    // there.
    var BTN_ICO = { fontSize: '12px', lineHeight: 1 }
    var BTN_COLORS = { shutdown: '#e5534b', restart: '#3b82f6', update: '#f59e0b' }

    /** Shutdown button: confirm + POST /api/shutdown. */
    function ShutdownAction() {
      var [pending, setPending] = React.useState(false)
      var [hover, setHover] = React.useState(false)
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
      return roundBtn({ color: BTN_COLORS.shutdown, ico: pending ? '…' : '⏻', title: title, pending: pending, onClick: onClick, hover: hover, setHover: setHover })
    }

    /** Restart button: confirm + POST /api/restart. */
    function RestartAction() {
      var [pending, setPending] = React.useState(false)
      var [hover, setHover] = React.useState(false)
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
      return roundBtn({ color: BTN_COLORS.restart, ico: pending ? '…' : '⟳', title: title, pending: pending, onClick: onClick, hover: hover, setHover: setHover })
    }

    /** DSH update check: ask the host for current vs latest @deepseek-ai/dsh version. */
    function DshUpdateAction() {
      var [pending, setPending] = React.useState(false)
      var [hover, setHover] = React.useState(false)
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
      return roundBtn({ color: BTN_COLORS.update, ico: pending ? '…' : '⬇', title: title, pending: pending, onClick: onClick, hover: hover, setHover: setHover })
    }

    /**
     * All three actions as ONE slot occupant. The slot container is a
     * single-row flex line (`.footerActions{display:flex}`) shared with the
     * cost meter and any other registrants — with no wrapping, trailing
     * occupants get clipped at the sidebar edge on narrow installs.
     *
     * Two coordinated pieces fix this generically:
     *  1. apply() injects one namespaced declaration enabling `flex-wrap` on
     *     that container, so ANY occupant wraps gracefully instead of being
     *     clipped, on every installation.
     *  2. This component claims `flex: 0 0 100%`, which in a wrappable flex
     *     container always lands on its OWN full-width row — below the cost
     *     block, directly above the settings seat, at every sidebar width.
     *
     * Adaptive density: the collapsed rail physically fits one 26px circle,
     * so it shows only the red shutdown button; the expanded sidebar gets the
     * full pill of three fixed 26px icon circles (~90px), color-coded with
     * `title` tooltips. Inline styles only; zero other CSS touched.
     */
    function QuickActions(props) {
      var wide = !!(props && props.wide)
      if (!wide) return React.createElement(ShutdownAction, null)
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            padding: '2px 0',
            flex: '0 0 100%',
            maxWidth: '100%',
          },
        },
        React.createElement(
          'div',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: '2px',
              padding: '3px',
              borderRadius: '999px',
              background: 'rgba(127, 127, 127, 0.10)',
              border: '1px solid rgba(127, 127, 127, 0.14)',
              flex: '0 0 auto',
            },
          },
          React.createElement(DshUpdateAction, null),
          React.createElement(RestartAction, null),
          React.createElement(ShutdownAction, null),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // One namespaced declaration: let the footer action line wrap instead
        // of clipping trailing occupants. Scoped to the container's stable
        // CSS-module name substring, so it keeps working across builds and
        // benefits every plugin that registers into this slot. Removed with
        // the fiber on stop/update/undefine.
        ctx.effect(() => {
          if (typeof document === 'undefined') return
          var tagId = 'dsh-quick-window-launcher/footer-actions-wrap'
          if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
          var tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-quick-window-launcher'
          tag.dataset.pluginCss = tagId
          tag.textContent = '[class*="footerActions"]{flex-wrap:wrap}'
          document.head.appendChild(tag)
          return function () {
            if (tag.parentNode) tag.parentNode.removeChild(tag)
          }
        }, 'quick-window-launcher: footer wrap css')

        ctx.effect(() => ctx.slots.inject('sidebar.footer.action', () => {
          var disposers = []
          disposers.push(ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'quick-actions',
            // Sort after every other known occupant (cost meter = 0, etc.) so
            // the dedicated row lands directly above the settings seat.
            order: 900000,
            registrant: 'dsh-quick-window-launcher',
          }, QuickActions))
          return function () { for (var i = 0; i < disposers.length; i++) disposers[i]() }
        }))
      },
    }
  },
})
