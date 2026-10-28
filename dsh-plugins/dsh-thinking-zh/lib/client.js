/* dsh-thinking-zh client — a floating dock.
 *
 * One draggable ball lives in a page corner; clicking it opens a small panel
 * with one row per feature. The ball is mounted on <body> and positioned with
 * `position: fixed`, so it never depends on the composer's internal DOM (which
 * carries build-hashed CSS-module class names and changes between releases).
 *
 * This file is a DSH client plugin (package.json `dsh.client` +
 * `exports["./client"]`), registered through the page's module loader. That is
 * the only client path the Electron window honours: its main window loads
 * `dsh://app/`, not the HTTP origin, so `webServer.tapIndex` injection never
 * reaches it.
 *
 * Adding a feature: append a descriptor to FEATURES below and a matching
 * lib/features/<id>.js on the host side. The panel renders whatever it finds.
 */
window.__ModuleLoader__.load({
  id: 'dsh-thinking-zh',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  var BALL = 46
  var MARGIN = 14
  var POS_KEY = 'dsh-floatdock:pos:v1'

  var ICON_BALL =
    '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">' +
    '<rect x="3" y="3" width="6" height="6" rx="1.8" fill="currentColor"/>' +
    '<rect x="11" y="3" width="6" height="6" rx="1.8" fill="currentColor" opacity=".5"/>' +
    '<rect x="3" y="11" width="6" height="6" rx="1.8" fill="currentColor" opacity=".5"/>' +
    '<rect x="11" y="11" width="6" height="6" rx="1.8" fill="currentColor"/>' +
    '</svg>'

  var ICON_ZH =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<rect x="3.4" y="3.4" width="9.2" height="9.2" rx="1.6" stroke="currentColor" stroke-width="1.2"/>' +
    '<path d="M8 1.7v12.6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</svg>'

  var ICON_FISH =
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M2.7 8c1.5-2.8 3.8-4.2 6-4.2 2.3 0 4 1.5 4.7 4.2-.7 2.7-2.4 4.2-4.7 4.2-2.2 0-4.5-1.4-6-4.2Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
    '<path d="M13.4 8c.8-.8 1.5-1.3 2-1.5M13.4 8c.8.8 1.5 1.3 2 1.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" opacity=".8"/>' +
    '<circle cx="6.2" cy="6.9" r=".8" fill="currentColor"/>' +
    '</svg>'

  var ICON_GEAR =
    '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.25"/>' +
    '<path d="M8 1.9v1.5M8 12.6v1.5M1.9 8h1.5M12.6 8h1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M12.3 3.7l-1.1 1.1M4.8 11.2l-1.1 1.1" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>' +
    '</svg>'

  /* ---------------- feature registry ---------------- */

  var FEATURES = [
    {
      id: 'thinking-zh',
      title: '思考链中文',
      hint: '模型从源头用中文推理，术语保留英文',
      icon: ICON_ZH,
      api: '/dsh-thinking-zh/state',
      state: { enabled: true, mode: 'zh' },
      modes: [
        { id: 'zh', label: '中文优先' },
        { id: 'mixed', label: '中英混用' },
        { id: 'auto', label: '跟随用户' },
      ],
    },
    {
      id: 'qq-bigfish',
      title: 'QQ 大肥鱼',
      hint: '把 DeepSeek 部署到 QQ 群',
      icon: ICON_FISH,
      api: '/dsh-thinking-zh/qq-bigfish',
      // 开关走独立端点：桥接用 socialV2.paused 表示「下线」，语义与 enabled 不同。
      toggle: { path: '/dsh-thinking-zh/qq-bigfish/toggle', key: 'online', statusKey: 'online' },
      offText: '已下线',
      settings: true,
      state: { enabled: true },
    },
  ]

  var ball = null
  var panel = null
  var toastEl = null
  var toastTimer = 0
  var open = false
  var drag = null
  var lastTap = 0
  var pos = { left: 0, top: 0 }

  /* ---------------- geometry ---------------- */

  function clampPos(left, top) {
    var maxL = Math.max(MARGIN, window.innerWidth - BALL - MARGIN)
    var maxT = Math.max(MARGIN, window.innerHeight - BALL - MARGIN)
    return {
      left: Math.min(Math.max(MARGIN, left), maxL),
      top: Math.min(Math.max(MARGIN, top), maxT),
    }
  }

  function defaultPos() {
    return clampPos(window.innerWidth - BALL - 18, window.innerHeight - BALL - 132)
  }

  function loadPos() {
    try {
      var raw = JSON.parse(window.localStorage.getItem(POS_KEY) || 'null')
      if (raw && typeof raw.left === 'number' && typeof raw.top === 'number') return raw
    } catch (e) {}
    return null
  }

  function savePos() {
    try {
      window.localStorage.setItem(POS_KEY, JSON.stringify({ left: pos.left, top: pos.top }))
    } catch (e) {}
  }

  function applyPos() {
    if (!ball) return
    ball.style.left = Math.round(pos.left) + 'px'
    ball.style.top = Math.round(pos.top) + 'px'
  }

  /* ---------------- styles ---------------- */

  function injectStyle() {
    if (document.getElementById('dsh-fb-style')) return
    var style = document.createElement('style')
    style.id = 'dsh-fb-style'
    style.textContent = [
      '@keyframes dsh-fb-pop{from{opacity:0;transform:translateY(6px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes dsh-fb-fade{from{opacity:0}to{opacity:1}}',

      '.dsh-fb-ball{position:fixed;width:' + BALL + 'px;height:' + BALL + 'px;border-radius:50%;',
      'display:grid;place-items:center;z-index:2147482000;cursor:grab;touch-action:none;user-select:none;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'background:color-mix(in srgb,var(--dsw-alias-bg-layer-2,#202024) 80%,transparent);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));',
      'color:var(--dsw-alias-brand-primary,#4d6bfe);',
      'box-shadow:0 8px 26px rgba(0,0,0,.3),0 1px 0 rgba(255,255,255,.06) inset;',
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);',
      'transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;',
      'animation:dsh-fb-fade .2s ease}',
      '.dsh-fb-ball:hover{transform:scale(1.07);border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.5))}',
      '.dsh-fb-ball[data-drag="1"]{cursor:grabbing;transform:scale(1.03);transition:none}',
      '.dsh-fb-ball[data-open="1"]{border-color:var(--dsw-alias-brand-primary,rgba(77,107,254,.55))}',
      '.dsh-fb-ball svg{pointer-events:none;display:block}',

      '.dsh-fb-panel{position:fixed;z-index:2147482001;width:304px;max-width:calc(100vw - 16px);',
      'border-radius:14px;box-sizing:border-box;overflow:hidden;',
      'background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));',
      'box-shadow:0 20px 52px rgba(0,0,0,.38);',
      'color:var(--dsw-alias-label-primary,#ececec);',
      'font-family:var(--dsw-font-family,inherit);font-size:13px;',
      'animation:dsh-fb-pop .16s ease}',

      '.dsh-fb-head{display:flex;align-items:center;justify-content:space-between;',
      'padding:11px 12px 9px 14px;font-size:11.5px;font-weight:600;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-x{width:22px;height:22px;border:none;border-radius:6px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);display:grid;place-items:center;padding:0;font-size:15px;line-height:1}',
      '.dsh-fb-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));',
      'color:var(--dsw-alias-label-primary,#ececec)}',

      '.dsh-fb-sep{height:1px;background:var(--dsw-alias-border-l1,rgba(127,127,127,.18))}',

      '.dsh-fb-item{padding:2px 0 4px}',
      '.dsh-fb-row{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer}',
      '.dsh-fb-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.09))}',
      '.dsh-fb-ico{flex:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 14%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-ico svg{display:block}',
      '.dsh-fb-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dsh-fb-text b{font-weight:600;font-size:13px;line-height:1.35}',
      '.dsh-fb-text span{font-size:11.5px;line-height:1.4;color:var(--dsw-alias-label-tertiary,#8d8d94);',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',

      '.dsh-fb-switch{flex:none;width:38px;height:21px;border-radius:999px;border:none;padding:0;cursor:pointer;',
      'background:var(--dsw-alias-border-l3,#3d3d44);position:relative;transition:background .15s ease}',
      '.dsh-fb-switch[data-on="1"]{background:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-switch::after{content:"";position:absolute;top:2.5px;left:2.5px;width:16px;height:16px;',
      'border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .15s ease}',
      '.dsh-fb-switch[data-on="1"]::after{transform:translateX(17px)}',

      '.dsh-fb-modes{display:flex;gap:5px;padding:0 14px 8px 52px;flex-wrap:wrap}',
      '.dsh-fb-mode{border:none;cursor:pointer;padding:4px 10px;border-radius:7px;font-size:11.5px;line-height:1.4;',
      'font-family:inherit;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.13));',
      'color:var(--dsw-alias-label-secondary,#a5a5ad);transition:background .13s ease,color .13s ease}',
      '.dsh-fb-mode:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-mode[data-active="1"]{background:rgba(77,107,254,.16);',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 20%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600}',

      '.dsh-fb-foot{padding:8px 14px 10px;font-size:11px;line-height:1.5;',
      'color:var(--dsw-alias-label-tertiary,#7f7f87);border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',

      '.dsh-fb-toast{position:fixed;z-index:2147482002;transform:translateX(-50%);padding:7px 13px;',
      'border-radius:8px;background:var(--dsw-alias-tooltip-bg,rgba(0,0,0,.86));color:#fff;',
      'font-size:12.5px;line-height:1.4;font-family:var(--dsw-font-family,inherit);white-space:nowrap;',
      'pointer-events:none;transition:opacity .16s ease;max-width:74vw}',

      /* ── 设置按钮（在开关左边） ── */
      '.dsh-fb-gear{flex:none;width:26px;height:26px;border:none;border-radius:7px;background:transparent;cursor:pointer;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94);display:grid;place-items:center;padding:0;transition:background .13s ease,color .13s ease}',
      '.dsh-fb-gear:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-gear svg{display:block}',

      /* ── 大设置窗口 ── */
      '.dsh-fb-modal{position:fixed;inset:0;z-index:2147482100;display:grid;place-items:center;',
      'background:rgba(0,0,0,.42);-webkit-backdrop-filter:blur(2px);backdrop-filter:blur(2px);animation:dsh-fb-fade .14s ease}',
      '.dsh-fb-dialog{width:min(940px,94vw);height:min(700px,88vh);display:flex;flex-direction:column;overflow:hidden;',
      'border-radius:16px;background:var(--dsw-alias-bg-layer-1,#17171a);',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.26));box-shadow:0 28px 80px rgba(0,0,0,.5);',
      'color:var(--dsw-alias-label-primary,#ececec);font-family:var(--dsw-font-family,inherit);font-size:13px;',
      'animation:dsh-fb-pop .18s ease}',
      '.dsh-fb-dlg-head{display:flex;align-items:center;justify-content:space-between;padding:13px 14px 11px 16px;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-dlg-title{display:flex;align-items:center;gap:9px}',
      '.dsh-fb-dlg-ico{display:grid;place-items:center;width:26px;height:26px;border-radius:8px;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 15%,transparent);',
      'color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-dlg-ico svg{display:block}',
      '.dsh-fb-dlg-title b{font-size:14px;font-weight:600}',
      '.dsh-fb-dlg-sub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-tabs{display:flex;gap:4px;padding:8px 12px 0;flex-wrap:wrap;',
      'border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-tab{border:none;background:transparent;cursor:pointer;font-family:inherit;font-size:12.5px;',
      'padding:7px 12px;border-radius:8px 8px 0 0;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
      '.dsh-fb-tab:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-tab[data-active="1"]{color:var(--dsw-alias-brand-primary,#4d6bfe);font-weight:600;',
      'background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4d6bfe) 11%,transparent)}',
      '.dsh-fb-dlg-body{flex:1;overflow:auto;padding:16px}',
      '.dsh-fb-sec{margin-bottom:18px}',
      '.dsh-fb-sec h4{margin:0 0 9px;font-size:11.5px;font-weight:600;letter-spacing:.04em;',
      'color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-kv{display:flex;justify-content:space-between;gap:14px;padding:6px 0;font-size:12.5px;',
      'border-bottom:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.14))}',
      '.dsh-fb-kv:last-child{border-bottom:none}',
      '.dsh-fb-kv span:first-child{color:var(--dsw-alias-label-tertiary,#8d8d94);flex:none}',
      '.dsh-fb-kv span:last-child{text-align:right;word-break:break-all}',
      '.dsh-fb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:11px}',
      '.dsh-fb-field{display:flex;flex-direction:column;gap:5px}',
      '.dsh-fb-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary,#a5a5ad)}',
      '.dsh-fb-field small{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary,#7f7f87)}',
      '.dsh-fb-input,.dsh-fb-area{font-family:inherit;font-size:12.5px;box-sizing:border-box;width:100%;',
      'padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'background:var(--dsw-alias-bg-layer-2,#202024);color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-input:focus,.dsh-fb-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary,#4d6bfe)}',
      '.dsh-fb-area{min-height:260px;resize:vertical;line-height:1.55;margin-top:8px;',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
      '.dsh-fb-btn{border:none;cursor:pointer;font-family:inherit;font-size:12.5px;padding:8px 15px;border-radius:9px;',
      'background:var(--dsw-alias-brand-primary,#4d6bfe);color:#fff;font-weight:600;transition:filter .13s ease}',
      '.dsh-fb-btn:hover{filter:brightness(1.12)}',
      '.dsh-fb-btn[disabled]{opacity:.5;cursor:default;filter:none}',
      '.dsh-fb-btn.ghost{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-primary,#ececec);font-weight:500}',
      '.dsh-fb-btn.danger{background:rgba(206,62,62,.92)}',
      '.dsh-fb-actions{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}',
      '.dsh-fb-check{display:flex;align-items:center;gap:8px;padding:5px 0;font-size:12.5px;line-height:1.45}',
      '.dsh-fb-dot{flex:none;width:8px;height:8px;border-radius:50%}',
      '.dsh-fb-dot.ok{background:#3fbf6f}',
      '.dsh-fb-dot.bad{background:#d64040}',
      '.dsh-fb-empty{color:var(--dsw-alias-label-tertiary,#7f7f87);font-size:12.5px;padding:8px 0;line-height:1.5}',
      '.dsh-fb-warn{color:#e0a33a;font-size:11.5px;line-height:1.55;margin-top:8px}',
      '.dsh-fb-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(162px,1fr));gap:10px}',
      '.dsh-fb-card{padding:11px 13px;border-radius:11px;background:var(--dsw-alias-bg-layer-2,#202024);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.16))}',
      '.dsh-fb-card b{display:block;font-size:18px;font-weight:600;margin-bottom:3px;word-break:break-all}',
      '.dsh-fb-card span{font-size:11px;color:var(--dsw-alias-label-tertiary,#8d8d94)}',
      '.dsh-fb-thumb{width:100%;height:84px;object-fit:contain;border-radius:8px;margin-bottom:8px;display:block;',
      'background:var(--dsw-alias-bg-layer-1,#17171a)}',
      '.dsh-fb-mini{border:none;cursor:pointer;font-family:inherit;font-size:11px;padding:3px 8px;border-radius:6px;',
      'background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));',
      'color:var(--dsw-alias-label-secondary,#a5a5ad);margin-right:5px;margin-top:6px;transition:color .13s ease}',
      '.dsh-fb-mini:hover{color:var(--dsw-alias-label-primary,#ececec)}',
      '.dsh-fb-mini.danger:hover{color:#ff8a8a}',
    ].join('')
    document.head.appendChild(style)
  }

  /* ---------------- state ---------------- */

  function normalizeFeatureState(feature, value) {
    var raw = value && typeof value === 'object' ? value : {}
    // statusKey 允许 feature 用别的字段名表达开关（QQ 大肥鱼用 online）
    var key = (feature.toggle && feature.toggle.statusKey) || 'enabled'
    feature.state.enabled = typeof raw[key] === 'boolean' ? raw[key] : true
    if (feature.modes) {
      var ids = feature.modes.map(function (m) { return m.id })
      feature.state.mode = ids.indexOf(raw.mode) !== -1 ? raw.mode : ids[0]
    }
  }

  function patchFeature(feature, patch, okText) {
    var prev = { enabled: feature.state.enabled, mode: feature.state.mode }
    if (typeof patch.enabled === 'boolean') feature.state.enabled = patch.enabled
    if (patch.mode) feature.state.mode = patch.mode
    renderPanel()

    // feature 可用 toggle 指定独立端点与字段名：QQ 大肥鱼的开关语义是「上线/下线」，
// 走 /qq-bigfish/toggle 且 body 为 { online: bool }，与 thinking-zh 的 { enabled } 不同。
    var target = (feature.toggle && feature.toggle.path) || feature.api
    var body = patch
    if (feature.toggle && typeof patch.enabled === 'boolean') {
      body = {}
      body[feature.toggle.key || 'online'] = patch.enabled
    }

    fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then(function (data) {
        if (data && data.state) normalizeFeatureState(feature, data.state)
        renderPanel()
        if (okText) toast(okText)
      })
      .catch(function () {
        feature.state.enabled = prev.enabled
        feature.state.mode = prev.mode
        renderPanel()
        toast('保存失败，请重试')
      })
  }

  function syncFeature(feature) {
    return fetch(feature.api, { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null
      })
      .then(function (data) {
        if (!data || !data.state) return
        normalizeFeatureState(feature, data.state)
        if (open) renderPanel()
      })
      .catch(function () {})
  }

  /* ---------------- panel ---------------- */

  function togglePanel() {
    if (open) closePanel()
    else openPanel()
  }

  function openPanel() {
    if (open) return
    open = true
    ball.dataset.open = '1'

    panel = document.createElement('div')
    panel.className = 'dsh-fb-panel'
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', '小工具箱')

    var head = document.createElement('div')
    head.className = 'dsh-fb-head'
    var title = document.createElement('span')
    title.textContent = '小工具箱'
    var close = document.createElement('button')
    close.type = 'button'
    close.className = 'dsh-fb-x'
    close.setAttribute('aria-label', '关闭')
    close.textContent = '✕'
    close.addEventListener('click', function (e) {
      e.stopPropagation()
      closePanel()
    })
    head.appendChild(title)
    head.appendChild(close)

    var body = document.createElement('div')
    body.className = 'dsh-fb-body'

    var foot = document.createElement('div')
    foot.className = 'dsh-fb-foot'
    foot.textContent = '拖动小球可移动位置 · 双击小球复位'

    var sep = document.createElement('div')
    sep.className = 'dsh-fb-sep'

    panel.appendChild(head)
    panel.appendChild(body)
    panel.appendChild(sep)
    panel.appendChild(foot)
    document.body.appendChild(panel)

    renderPanel()
    positionPanel()

    setTimeout(function () {
      document.addEventListener('pointerdown', onDocDown, true)
    }, 0)
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('resize', positionPanel)
  }

  function closePanel() {
    if (!open) return
    open = false
    if (ball) ball.dataset.open = '0'
    if (panel && panel.parentNode) panel.parentNode.removeChild(panel)
    panel = null
    document.removeEventListener('pointerdown', onDocDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('resize', positionPanel)
  }

  function onDocDown(e) {
    if (!open) return
    if (panel && panel.contains(e.target)) return
    if (ball && (e.target === ball || ball.contains(e.target))) return
    closePanel()
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') closePanel()
  }

  function positionPanel() {
    if (!panel || !ball) return
    panel.style.visibility = 'hidden'
    panel.style.display = 'block'
    var pr = panel.getBoundingClientRect()
    var gap = 10
    var rightHalf = pos.left + BALL / 2 > window.innerWidth / 2
    var left = rightHalf ? pos.left + BALL - pr.width : pos.left
    left = Math.max(8, Math.min(window.innerWidth - pr.width - 8, left))
    var top = pos.top - pr.height - gap
    if (top < 8) top = Math.min(window.innerHeight - pr.height - 8, pos.top + BALL + gap)
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(Math.max(8, top)) + 'px'
    panel.style.visibility = 'visible'
  }

  function renderPanel() {
    if (!panel) return
    var body = panel.querySelector('.dsh-fb-body')
    if (!body) return
    body.textContent = ''
    for (var i = 0; i < FEATURES.length; i++) body.appendChild(featureItem(FEATURES[i]))
    if (open) positionPanel()
  }

  function featureItem(feature) {
    var item = document.createElement('div')
    item.className = 'dsh-fb-item'

    var row = document.createElement('div')
    row.className = 'dsh-fb-row'

    var ico = document.createElement('span')
    ico.className = 'dsh-fb-ico'
    ico.innerHTML = feature.icon

    var text = document.createElement('div')
    text.className = 'dsh-fb-text'
    var title = document.createElement('b')
    title.textContent = feature.title
    var hint = document.createElement('span')
    hint.textContent = feature.state.enabled ? feature.hint : (feature.offText || '已关闭')
    text.appendChild(title)
    text.appendChild(hint)

    var sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'dsh-fb-switch'
    sw.dataset.on = feature.state.enabled ? '1' : '0'
    sw.setAttribute('aria-pressed', feature.state.enabled ? 'true' : 'false')
    sw.setAttribute('aria-label', feature.title)

    function flip(e) {
      if (e) e.stopPropagation()
      var next = !feature.state.enabled
      patchFeature(
        feature,
        { enabled: next },
        next ? '已开启「' + feature.title + '」· 下一轮生效' : '已关闭「' + feature.title + '」'
      )
    }

    sw.addEventListener('click', flip)
    row.addEventListener('click', flip)

    row.appendChild(ico)
    row.appendChild(text)

    if (feature.settings) {
      // 齿轮必须自己 stopPropagation：整行点击是「切换开关」，
      // 不拦住的话点设置会顺手把机器人下线。
      var gear = document.createElement('button')
      gear.type = 'button'
      gear.className = 'dsh-fb-gear'
      gear.title = '打开设置'
      gear.setAttribute('aria-label', feature.title + ' · 设置')
      gear.innerHTML = ICON_GEAR
      gear.addEventListener('click', function (e) {
        e.stopPropagation()
        openSettings(feature)
      })
      row.appendChild(gear)
    }

    row.appendChild(sw)
    item.appendChild(row)

    if (feature.modes && feature.state.enabled) {
      var modes = document.createElement('div')
      modes.className = 'dsh-fb-modes'
      for (var i = 0; i < feature.modes.length; i++) {
        ;(function (mode) {
          var b = document.createElement('button')
          b.type = 'button'
          b.className = 'dsh-fb-mode'
          b.dataset.active = feature.state.mode === mode.id ? '1' : '0'
          b.textContent = mode.label
          b.addEventListener('click', function (e) {
            e.stopPropagation()
            patchFeature(feature, { enabled: true, mode: mode.id }, '已切换为「' + mode.label + '」· 下一轮生效')
          })
          modes.appendChild(b)
        })(feature.modes[i])
      }
      item.appendChild(modes)
    }

    return item
  }

  /* ---------------- settings modal ---------------- */

  var TABS = [
    { id: 'status', label: '状态' },
    { id: 'rhythm', label: '回复节奏' },
    { id: 'persona', label: '人格' },
    { id: 'tokens', label: 'Token 花费' },
    { id: 'stickers', label: '表情' },
    { id: 'access', label: '访问控制' },
    { id: 'backend', label: '后端' },
    { id: 'diagnose', label: '诊断' },
  ]

  // [字段路径, 显示名, 说明]
  var RHYTHM_FIELDS = [
    ['autoReplyCheckMs', '唤醒检查间隔', '毫秒。越小越「秒回」，但轮询更频繁'],
    ['send.burstMaxMessages', '单次最多几条', '一轮回复最多拆成几条消息'],
    ['send.burstIntervalMinMs', '条间最短间隔', '毫秒'],
    ['send.burstIntervalMaxMs', '条间最长间隔', '毫秒'],
    ['send.maxSendPerMinute', '每分钟峰值', '超过会被桥接限流（防 QQ 风控）'],
    ['send.maxSendPerHour', '每小时峰值', '同上'],
    ['send.maxMessageChars', '单条最大字数', '超出自动按句读切分'],
    ['wait.defaultMs', '等待消息默认时长', '毫秒。AI 调 qq_wait_for_messages 的默认值'],
    ['wait.defaultQuietMs', '静默判定窗口', '毫秒。连续安静这么久才算对方说完'],
    ['wake.batchWindowMs', '唤醒合并窗口', '毫秒。多条消息合并成一次唤醒'],
    ['wake.maxWakePerHour', '每小时最多唤醒', '防止反复自我唤醒'],
    ['context.recentLimit', '注入的历史条数', '越大上下文越全，但更慢更贵'],
    // QQ 空间：它只是一个工具，不是日程任务。这里控制「能不能发 / 一天最多几条」，
    // 不控制"什么时候发"——那由它自己或你临场决定，不存在"到点自动发"。
    ['qzone.enabled', '允许发 QQ 空间（说说）', '关掉后它调不动发说说的工具；开着也只代表"有能力发"，不会自己每天发', 'bool'],
    ['qzone.maxPerDay', '说说每天上限', '防刷屏的上限，不是任务量。默认 2 条'],
  ]

  var modal = null
  var mState = { feature: null, tab: 'status', data: {}, note: '' }

  function fetchJson(url, options) {
    return fetch(url, options || { cache: 'no-store' })
      .then(function (res) { return res.json().catch(function () { return null }) })
      .catch(function () { return null })
  }

  function postJson(url, body) {
    return fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body || {}),
    })
  }

  function h(tag, cls, text) {
    var el = document.createElement(tag)
    if (cls) el.className = cls
    if (text !== undefined && text !== null) el.textContent = text
    return el
  }

  function section(titleText, nodes) {
    var s = h('div', 'dsh-fb-sec')
    s.appendChild(h('h4', null, titleText))
    for (var i = 0; i < nodes.length; i++) s.appendChild(nodes[i])
    return s
  }

  function kv(k, v) {
    var row = h('div', 'dsh-fb-kv')
    row.appendChild(h('span', null, k))
    row.appendChild(h('span', null, (v === undefined || v === null || v === '') ? '—' : String(v)))
    return row
  }

  function statusLine(text, ok) {
    var row = h('div', 'dsh-fb-check')
    row.appendChild(h('span', 'dsh-fb-dot ' + (ok ? 'ok' : 'bad')))
    row.appendChild(h('span', null, text))
    return row
  }

  function actionsRow(buttons) {
    var row = h('div', 'dsh-fb-actions')
    for (var i = 0; i < buttons.length; i++) {
      (function (spec) {
        var b = h('button', 'dsh-fb-btn' + (spec.ghost ? ' ghost' : '') + (spec.danger ? ' danger' : ''), spec.label)
        b.type = 'button'
        b.addEventListener('click', spec.onClick)
        row.appendChild(b)
      })(buttons[i])
    }
    return row
  }

  function openSettings(feature) {
    closeSettings()
    closePanel()
    mState.feature = feature
    mState.tab = 'status'
    mState.data = {}
    mState.note = ''

    var wrap = h('div', 'dsh-fb-modal')
    wrap.setAttribute('role', 'dialog')
    wrap.setAttribute('aria-modal', 'true')
    wrap.setAttribute('aria-label', feature.title + ' 设置')
    wrap.addEventListener('click', function (e) { if (e.target === wrap) closeSettings() })

    var dlg = h('div', 'dsh-fb-dialog')
    var head = h('div', 'dsh-fb-dlg-head')
    var title = h('div', 'dsh-fb-dlg-title')
    var ico = h('span', 'dsh-fb-dlg-ico')
    ico.innerHTML = feature.icon
    title.appendChild(ico)
    title.appendChild(h('b', null, feature.title))
    title.appendChild(h('span', 'dsh-fb-dlg-sub', '设置'))
    var x = h('button', 'dsh-fb-x', '✕')
    x.type = 'button'
    x.setAttribute('aria-label', '关闭')
    x.addEventListener('click', closeSettings)
    head.appendChild(title)
    head.appendChild(x)

    var tabs = h('div', 'dsh-fb-tabs')
    var body = h('div', 'dsh-fb-dlg-body')
    dlg.appendChild(head)
    dlg.appendChild(tabs)
    dlg.appendChild(body)
    wrap.appendChild(dlg)
    document.body.appendChild(wrap)
    modal = { wrap: wrap, tabs: tabs, body: body }

    document.addEventListener('keydown', onModalKey, true)
    renderTabs()
    loadTab('status')
  }

  function closeSettings() {
    if (!modal) return
    document.removeEventListener('keydown', onModalKey, true)
    if (modal.wrap.parentNode) modal.wrap.parentNode.removeChild(modal.wrap)
    modal = null
  }

  function onModalKey(e) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      closeSettings()
    }
  }

  function renderTabs() {
    if (!modal) return
    modal.tabs.textContent = ''
    for (var i = 0; i < TABS.length; i++) {
      (function (tab) {
        var b = h('button', 'dsh-fb-tab', tab.label)
        b.type = 'button'
        b.dataset.active = mState.tab === tab.id ? '1' : '0'
        b.addEventListener('click', function () { loadTab(tab.id) })
        modal.tabs.appendChild(b)
      })(TABS[i])
    }
  }

  function setBody(nodes) {
    if (!modal) return
    modal.body.textContent = ''
    for (var i = 0; i < nodes.length; i++) modal.body.appendChild(nodes[i])
  }

  function loadTab(tabId) {
    mState.tab = tabId
    mState.note = ''
    renderTabs()
    setBody([h('div', 'dsh-fb-empty', '加载中…')])
    var f = mState.feature
    var url = f.api
    if (tabId === 'rhythm') url = f.api + '/settings'
    else if (tabId === 'persona') url = f.api + '/persona'
    else if (tabId === 'tokens') url = f.api + '/tokens'
    else if (tabId === 'stickers') url = f.api + '/stickers'
    else if (tabId === 'access') url = f.api + '/access'
    else if (tabId === 'backend') url = f.api + '/backend'
    else if (tabId === 'diagnose') url = f.api + '/diagnose'
    fetchJson(url).then(function (data) {
      if (!modal) return
      // 竞态守卫：慢页签（「后端」要 spawn PowerShell，可能 1~3 秒）的响应
      // 常常在用户已经切走之后才回来；若无条件写入 mState.data，
      // 就会拿旧页签的数据去渲染新页签（表现为"诊断"页签只剩标题）。
      if (mState.tab !== tabId) return
      mState.data = data || {}
      renderTab()
    })
  }

  function renderTab() {
    if (!modal) return
    var d = mState.data
    if (!d || d.ok === false) {
      setBody([
        h('div', 'dsh-fb-empty', '读不到数据'),
        h('div', 'dsh-fb-warn', (d && d.error) || '未知错误（桥接可能没有运行）'),
        actionsRow([{ label: '重试', onClick: function () { loadTab(mState.tab) } }]),
      ])
      return
    }
    if (mState.tab === 'status') return renderStatusTab(d)
    if (mState.tab === 'rhythm') return renderRhythmTab(d)
    if (mState.tab === 'persona') return renderPersonaTab(d)
    if (mState.tab === 'tokens') return renderTokensTab(d)
    if (mState.tab === 'stickers') return renderStickersTab(d)
    if (mState.tab === 'access') return renderAccessTab(d)
    if (mState.tab === 'backend') return renderBackendTab(d)
    if (mState.tab === 'diagnose') return renderDiagnoseTab(d)
  }

  function renderStatusTab(d) {
    var online = d.online === true
    var sl = d.snowluma || {}
    var nodes = []

    var btn = h('button', 'dsh-fb-btn' + (online ? ' ghost' : ''), online ? '下线（暂停机器人）' : '上线（恢复机器人）')
    btn.type = 'button'
    btn.addEventListener('click', function () {
      btn.disabled = true
      btn.textContent = '处理中…'
      postJson(mState.feature.toggle.path, { online: !online }).then(function (r) {
        toast(r && r.ok ? (online ? '机器人已下线' : '机器人已上线') : '操作失败')
        loadTab('status')
        syncFeature(mState.feature)
      })
    })
    nodes.push(section('开关', [btn]))

    // SnowLuma 区块**常驻显示**（不只是未运行时）。
    // 早先写成「仅在 sl.connected !== true 时显示」，结果用户点开找不到启动选项 ——
    // 那时它恰好在运行；更糟的是桥接若没跑，整页都读不到数据，连区块都渲染不出来。
    // 现在标题与按钮随状态变化，入口永远在。
    var slRunning = sl.connected === true
    var slRow = h('div', 'dsh-fb-actions')
    if (!slRunning) {
      var launchBtn = h('button', 'dsh-fb-btn', '启动 SnowLuma')
      launchBtn.type = 'button'
      launchBtn.addEventListener('click', function () {
        launchBtn.disabled = true
        launchBtn.textContent = '启动中…（等到桥接连上，最多 90 秒）'
        postJson(mState.feature.api + '/launch-snowluma', {}).then(function (res) {
          toast(res && res.ok ? (res.message || '已启动') : ((res && res.error) || '启动失败'))
          loadTab('status')
        })
      })
      slRow.appendChild(launchBtn)
    } else {
      slRow.appendChild(h('span', 'dsh-fb-check-ok', '✓ 运行中'))
    }
    var webuiBtn = h('button', 'dsh-fb-btn ghost', '打开 WebUI')
    webuiBtn.type = 'button'
    webuiBtn.addEventListener('click', function () {
      fetchJson(mState.feature.api + '/open-snowluma?target=webui').then(function (res) {
        toast(res && res.ok ? '已打开 WebUI' : ((res && res.error) || '打开失败'))
      })
    })
    var dirBtn = h('button', 'dsh-fb-btn ghost', '打开目录')
    dirBtn.type = 'button'
    dirBtn.addEventListener('click', function () {
      fetchJson(mState.feature.api + '/open-snowluma?target=dir').then(function (res) {
        toast(res && res.ok ? '已打开目录' : ((res && res.error) || '打开失败'))
      })
    })
    slRow.appendChild(webuiBtn)
    slRow.appendChild(dirBtn)
    nodes.push(section(slRunning ? 'SnowLuma（运行中）' : 'SnowLuma（未运行）', [
      slRow,
      h('div', 'dsh-fb-warn', slRunning
        ? '进程在跑，但是否能收 QQ 消息要看账号是否在线 —— 见上面的自检。'
        : '启动的是你本机已安装的 SnowLuma（路径取自 config.json 的 snowluma.launcherPath），本工具不包含也不分发它。若启动后仍收不到 QQ 消息，通常是要去 WebUI 扫码登录。'),
    ]))

    nodes.push(section('自检', [
      statusLine('DSH 已就绪' + (d.mode ? '（模式 ' + d.mode + '）' : ''), d.dshReady === true),
      statusLine('SnowLuma 已连接' + (sl.accountOnline ? '（账号在线）' : ''), sl.connected === true),
      statusLine('SnowLuma 上游健康' + (sl.goodSource ? '（来源 ' + sl.goodSource + '）' : ''), sl.good === true),
      statusLine('机器人上线中', online),
    ]))

    nodes.push(section('连接信息', [
      kv('桥接目录', d.bridge && d.bridge.dir),
      kv('控制台', d.bridge && d.bridge.consoleUrl),
      kv('DSH 地址', d.bridge && d.bridge.baseUrl),
      kv('管理员 QQ', d.ownerQQ),
      kv('私聊白名单', (d.allowPrivate || []).join('、')),
      kv('群白名单', (d.allowGroups || []).length ? d.allowGroups.join('、') : '（未接入任何群）'),
      kv('当前角色', d.role || '（未启用角色扮演）'),
      kv('角色模式', d.roleMode),
    ]))

    if (sl.hint) nodes.push(h('div', 'dsh-fb-warn', 'SnowLuma 提示：' + sl.hint))
    setBody(nodes)
  }

  function getPath(obj, pathStr) {
    var parts = pathStr.split('.')
    var cur = obj
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined
      cur = cur[parts[i]]
    }
    return cur
  }

  function renderRhythmTab(d) {
    var r = d.rhythm || {}
    var grid = h('div', 'dsh-fb-grid')
    for (var i = 0; i < RHYTHM_FIELDS.length; i++) {
      (function (spec) {
        var field = h('div', 'dsh-fb-field')
        field.appendChild(h('label', null, spec[1]))
        var v = getPath(r, spec[0])
        var input
        if (spec[3] === 'bool') {
          // 布尔项渲染成勾选框：用数字框让用户填 1/0 太反人类。
          input = h('input')
          input.type = 'checkbox'
          input.checked = v === true
        } else {
          input = h('input', 'dsh-fb-input')
          input.type = 'number'
          input.value = (v === undefined || v === null) ? '' : String(v)
        }
        input.dataset.key = spec[0]
        field.appendChild(input)
        field.appendChild(h('small', null, spec[2]))
        grid.appendChild(field)
      })(RHYTHM_FIELDS[i])
    }

    var nodes = [section('回复节奏（保存后即时生效）', [grid])]
    nodes.push(actionsRow([
      { label: '保存', onClick: function () { saveRhythm(r) } },
      { label: '放弃改动', ghost: true, onClick: function () { loadTab('rhythm') } },
    ]))
    nodes.push(h('div', 'dsh-fb-warn', '提醒：发送频率调得越高，触发 QQ 风控的风险越大。默认值（每分钟 8 条 / 每小时 60 条）是保守的。'))
    if (mState.note) nodes.push(h('div', 'dsh-fb-warn', mState.note))
    setBody(nodes)
  }

  function saveRhythm(original) {
    if (!modal) return
    // 深拷贝后逐字段覆盖：必须整体回写，因为桥接的 config 接口是浅合并，
    // 子对象（send/wait/wake）传局部会把其余字段清掉。
    var rhythm = JSON.parse(JSON.stringify(original || {}))
    var inputs = modal.body.querySelectorAll('input[data-key]')
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i]
      var parts = input.dataset.key.split('.')
      var cur = rhythm
      for (var k = 0; k < parts.length - 1; k++) {
        if (!cur[parts[k]] || typeof cur[parts[k]] !== 'object') cur[parts[k]] = {}
        cur = cur[parts[k]]
      }
      if (input.type === 'checkbox') {
        cur[parts[parts.length - 1]] = input.checked === true
        continue
      }
      var num = Number(input.value)
      if (input.value === '' || !isFinite(num)) continue
      cur[parts[parts.length - 1]] = num
    }
    setBody([h('div', 'dsh-fb-empty', '保存中…')])
    postJson(mState.feature.api + '/settings', { rhythm: rhythm }).then(function (res) {
      if (res && res.ok) {
        toast('节奏已保存')
        loadTab('rhythm')
      } else {
        mState.note = (res && res.error) || '保存失败'
        renderRhythmTab(mState.data)
      }
    })
  }

  function renderPersonaTab(d) {
    var list = Array.isArray(d.roles) ? d.roles : []
    var summaries = Array.isArray(d.summaries) ? d.summaries : []
    var limits = d.limits || {}
    var nodes = []

    var pick = h('select', 'dsh-fb-input')
    var opt0 = h('option', null, '（未启用角色扮演）')
    opt0.value = ''
    pick.appendChild(opt0)
    for (var i = 0; i < list.length; i++) {
      var o = h('option', null, list[i])
      o.value = list[i]
      if (d.current === list[i]) o.selected = true
      pick.appendChild(o)
    }

    // 当前角色常驻回显。toast 一闪就过，而下拉框在"切换其实没生效"时会回到空白，
// 用户根本看不出到底切没切。这一行跟着 loadTab 重新渲染，是权威状态。
    var currentLine = h('div', 'dsh-fb-empty')
    currentLine.textContent = d.current
      ? ('当前角色：' + d.current + '（已生效，下一轮唤醒起按这张卡说话）')
      : '当前角色：未启用（选一张卡 → 点「设为当前角色」）'

    var meta = h('div', 'dsh-fb-empty')
    var warn = h('div', 'dsh-fb-warn')
    var area = h('textarea', 'dsh-fb-area')
    area.placeholder = '选择上方角色卡后在这里编辑…'

    function loadOne(name) {
      if (!name) { area.value = ''; meta.textContent = ''; warn.textContent = ''; return }
      fetchJson(mState.feature.api + '/persona?name=' + encodeURIComponent(name)).then(function (one) {
        area.value = (one && (one.content || one.text)) || ''
        var s = null
        for (var j = 0; j < summaries.length; j++) if (summaries[j].name === name) s = summaries[j]
        if (s) {
          meta.textContent = s.chars + ' 字 · 实际注入 ' + s.injectedV2 + ' 字 · ' + s.lines + ' 行'
          warn.textContent = s.truncated
            ? ('⚠ 角色卡 ' + s.chars + ' 字，超过注入上限 ' + (limits.injectMaxChars || '?') + ' 字，超出部分不会生效（可调高上限，但过大也会拖慢每轮）')
            : ''
        } else { meta.textContent = ''; warn.textContent = '' }
      })
    }
    pick.addEventListener('change', function () { loadOne(pick.value) })

    nodes.push(section('角色卡（人格层）', [currentLine, pick, meta, area]))

    var limitInput = h('input', 'dsh-fb-input')
    limitInput.type = 'number'
    limitInput.value = String(limits.injectMaxChars || '')
    var limitField = h('div', 'dsh-fb-field')
    limitField.appendChild(h('label', null, '注入字数上限（当前 ' + (limits.injectMaxChars || '?') + '）'))
    limitField.appendChild(limitInput)
    nodes.push(section('上限与统计', [
      limitField,
      kv('角色数', list.length),
      kv('名称长度上限', limits.nameMax),
      kv('单卡字节上限', limits.contentMaxBytes),
    ]))

    nodes.push(actionsRow([
      { label: '保存角色卡', onClick: function () {
        if (!pick.value) { toast('请先选择一个角色卡'); return }
        postJson(mState.feature.api + '/persona', { action: 'save', name: pick.value, content: area.value }).then(function (res) {
          toast(res && res.ok ? '角色卡已保存' : ((res && res.error) || '保存失败'))
          loadTab('persona')
        })
      } },
      { label: '设为当前角色', ghost: true, onClick: function () {
        postJson(mState.feature.api + '/persona', { action: 'activate', name: pick.value || null }).then(function (res) {
          // 提示里带上"这次到底切成了谁"：以前只说"已切换当前角色"，而桥接那边
          // 因为字段名不一致其实清空了角色，用户看到成功的提示、下拉框却是空的。
          var ok = res && res.ok
          toast(ok
            ? (res.role ? ('已切换到「' + res.role + '」，下一轮唤醒生效') : '已取消角色扮演')
            : ((res && res.error) || '切换失败'))
          loadTab('persona')
        })
      } },
      { label: '应用上限', ghost: true, onClick: function () {
        postJson(mState.feature.api + '/persona', { action: 'limit', injectMaxChars: Number(limitInput.value) }).then(function (res) {
          toast(res && res.ok ? '上限已更新' : ((res && res.error) || '更新失败'))
          loadTab('persona')
        })
      } },
      { label: '删除', danger: true, onClick: function () {
        if (!pick.value) return
        postJson(mState.feature.api + '/persona', { action: 'delete', name: pick.value }).then(function (res) {
          toast(res && res.ok ? '已删除' : ((res && res.error) || '删除失败'))
          loadTab('persona')
        })
      } },
    ]))
    if (warn.textContent) nodes.push(warn)
    setBody(nodes)
    loadOne(pick.value)
  }

  function renderTokensTab(d) {
    var t = d.totals || {}
    var b = t.buckets || {}
    var tier = d.nowTier || {}
    var symbol = d.symbol || '¥'
    var total = b.cacheMiss || 0
    var hit = b.cacheHit || 0
    var out = b.output || 0
    var money = (t.cost !== undefined) ? t.cost : (t.money !== undefined ? t.money : (t.cny !== undefined ? t.cny : null))

    var cards = h('div', 'dsh-fb-cards')
    function card(value, label) {
      var c = h('div', 'dsh-fb-card')
      c.appendChild(h('b', null, value))
      c.appendChild(h('span', null, label))
      return c
    }
    cards.appendChild(card(money === null ? '—' : (symbol + Number(money).toFixed(4)), '累计花费（' + (d.currency || 'CNY') + '）'))
    cards.appendChild(card(String(total + hit + out), '总 token'))
    cards.appendChild(card(String(total), '未命中输入'))
    cards.appendChild(card(String(hit), '缓存命中输入'))
    cards.appendChild(card(String(out), '输出'))

    var nodes = [section('用量与花费', [cards])]
    if (tier.model) {
      nodes.push(section('当前计价（' + (tier.tierLabel || '') + '）', [
        kv('模型', tier.label || tier.model),
        kv('未命中输入', tier.cacheMiss + ' 元/百万'),
        kv('缓存命中', tier.cacheHit + ' 元/百万'),
        kv('输出', tier.output + ' 元/百万'),
        kv('峰谷倍率', d.priceTable ? (d.priceTable.peakMultiplier + '×（高峰时段）') : '—'),
      ]))
    }
    nodes.push(h('div', 'dsh-fb-warn', '价目表版本 ' + (d.priceVersion || '?') + '，按 DeepSeek 官方价折算。你若在用 qwen 等第三方模型，需要在桥接 config.json 的 pricing.models 里登记该模型价格，否则这里会按默认价估算。'))
    nodes.push(actionsRow([{ label: '刷新', ghost: true, onClick: function () { loadTab('tokens') } }]))
    setBody(nodes)
  }

  function renderStickersTab(d) {
    var list = Array.isArray(d.stickers) ? d.stickers : []
    var total = (d.total === undefined || d.total === null) ? list.length : d.total
    var api = mState.feature.api + '/stickers'
    var nodes = []

    // ── 上传 ──
    // 不走 window.prompt：Electron 里它不可靠；这里用隐藏 file input + 常驻备注框。
    var fileInput = h('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/png,image/jpeg,image/gif,image/webp'
    fileInput.style.display = 'none'
    document.body.appendChild(fileInput)

    var noteInput = h('input', 'dsh-fb-input')
    noteInput.placeholder = '备注（可选，≤20 字）'
    noteInput.maxLength = 20
    noteInput.style.maxWidth = '240px'

    var pickBtn = h('button', 'dsh-fb-btn', '选择图片上传')
    pickBtn.type = 'button'
    pickBtn.addEventListener('click', function () { fileInput.click() })

    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0]
      if (!file) return
      if (file.size > 2 * 1024 * 1024) {
        toast('图片 ' + (file.size / 1048576).toFixed(2) + 'MB，超过 2MB 上限')
        return
      }
      pickBtn.disabled = true
      pickBtn.textContent = '上传中…'
      var reader = new FileReader()
      reader.onload = function () {
        postJson(api, { action: 'upload', data: String(reader.result || ''), note: noteInput.value || '' })
          .then(function (res) {
            toast(res && res.ok ? '已加入 QQ 收藏表情' : ((res && res.error) || '上传失败'))
            loadTab('stickers')
          })
      }
      reader.onerror = function () { toast('读取文件失败') }
      reader.readAsDataURL(file)
    })

    var upRow = h('div', 'dsh-fb-actions')
    upRow.appendChild(pickBtn)
    upRow.appendChild(noteInput)
    nodes.push(section('上传新表情', [
      upRow,
      h('div', 'dsh-fb-warn', '支持 png / jpg / gif / webp，单张上限 2MB。上传会直接加入你 QQ 账号的收藏表情，之后 AI 通过 qq_list_stickers 就能看到并使用它。'),
    ]))

    // ── 列表 ──
    var grid = h('div', 'dsh-fb-cards')
    if (!list.length) {
      grid.appendChild(h('div', 'dsh-fb-empty', '还没有收藏表情。上传一张试试；也可以让机器人在群里「偷图」（它会自己判断哪张有意思）。'))
    }
    for (var i = 0; i < list.length; i++) {
      (function (s) {
        var card = h('div', 'dsh-fb-card')
        if (s.url) {
          var img = h('img', 'dsh-fb-thumb')
          img.src = s.url
          img.alt = s.desc || '表情'
          img.loading = 'lazy'
          card.appendChild(img)
        }
        card.appendChild(h('span', null, s.desc || s.localNote || '(无备注)'))
        card.appendChild(h('span', null, String(s.id || '').slice(-14)))

        var editBtn = h('button', 'dsh-fb-mini', '改备注')
        editBtn.type = 'button'
        editBtn.addEventListener('click', function () {
          if (card.querySelector('.dsh-fb-inline-edit')) return
          var row = h('div', 'dsh-fb-actions dsh-fb-inline-edit')
          var input = h('input', 'dsh-fb-input')
          input.value = s.desc || ''
          input.maxLength = 20
          input.style.maxWidth = '130px'
          var save = h('button', 'dsh-fb-mini', '保存')
          save.type = 'button'
          save.addEventListener('click', function () {
            postJson(api, { action: 'remark', stickerId: s.id, remark: input.value.slice(0, 20) })
              .then(function (res) {
                toast(res && res.ok ? '备注已更新' : ((res && res.error) || '更新失败'))
                loadTab('stickers')
              })
          })
          var cancel = h('button', 'dsh-fb-mini', '取消')
          cancel.type = 'button'
          cancel.addEventListener('click', function () { if (row.parentNode) row.parentNode.removeChild(row) })
          row.appendChild(input)
          row.appendChild(save)
          row.appendChild(cancel)
          card.appendChild(row)
        })
        card.appendChild(editBtn)

        // 二次确认不用 window.confirm（Electron 下不可靠）：按钮点两下才真删。
        var delBtn = h('button', 'dsh-fb-mini danger', '删除')
        delBtn.type = 'button'
        delBtn.addEventListener('click', function () {
          if (delBtn.dataset.armed === '1') {
            postJson(api, { action: 'delete', stickerId: s.id }).then(function (res) {
              toast(res && res.ok ? '已删除' : ((res && res.error) || '删除失败'))
              loadTab('stickers')
            })
            return
          }
          delBtn.dataset.armed = '1'
          delBtn.textContent = '确认删除？'
          setTimeout(function () {
            if (delBtn.parentNode) { delBtn.dataset.armed = '0'; delBtn.textContent = '删除' }
          }, 4000)
        })
        card.appendChild(delBtn)
        grid.appendChild(card)
      })(list[i])
    }
    nodes.push(section('收藏表情（' + total + ' 个）', [grid]))

    nodes.push(actionsRow([
      { label: '刷新', ghost: true, onClick: function () { loadTab('stickers') } },
      { label: '同步 QQ 收藏', ghost: true, onClick: function () {
        postJson(api, { action: 'sync' }).then(function (res) {
          toast(res && res.ok ? ('已同步 ' + (res.total || 0) + ' 个') : ((res && res.error) || '同步失败'))
          loadTab('stickers')
        })
      } },
    ]))
    setBody(nodes)
  }

  function renderAccessTab(d) {
    var allow = d.allow || { private: [], groups: [] }
    var deny = d.deny || { private: [], groups: [] }
    var api = mState.feature.api + '/access'
    var nodes = []

    nodes.push(section('管理员（Owner：全部工具权限）', [
      statusLine('管理员 QQ：' + (d.ownerQQ || '（未设置）'), !!d.ownerQQ),
      h('div', 'dsh-fb-warn', '只有管理员能用工具。改管理员请去桥接控制台 http://127.0.0.1:3100 的「访问与安全」页（这里故意不提供，避免误改把自己锁在外面）。'),
    ]))

    function bucket(title, kind, list, isDeny, emptyHint) {
      var rows = []
      if (!list.length) {
        rows.push(h('div', 'dsh-fb-empty', emptyHint))
      } else {
        for (var i = 0; i < list.length; i++) {
          (function (id) {
            var row = h('div', 'dsh-fb-actions')
            var lab = h('span', null, String(id))
            lab.style.minWidth = '150px'
            lab.style.fontSize = '12px'
            row.appendChild(lab)
            // 管理员账号受保护：踢出它是当前最反直觉的坑 ——
            // reserved2 模式的准入只看 allow/deny，不看 ownerQQ，
            // 所以把自己踢出 = 自己彻底收不到服务（虽然还能用工具箱救回来）。
            var isOwnerRow = !isDeny && String(id) === String(d.ownerQQ || '')
            var btn = h('button', 'dsh-fb-mini' + (isDeny ? '' : ' danger'), isDeny ? '解除拉黑' : '踢出（拉黑）')
            btn.type = 'button'
            if (isOwnerRow) {
              btn.disabled = true
              btn.textContent = '管理员（不可踢出）'
              btn.style.opacity = '0.5'
              btn.style.cursor = 'not-allowed'
            } else {
              btn.addEventListener('click', function () {
                postJson(api, { action: isDeny ? 'unblock' : 'block', kind: kind, id: id }).then(function (res) {
                  toast(res && res.ok ? (isDeny ? '已解除' : '已踢出并拉黑') : ((res && res.error) || '操作失败'))
                  loadTab('access')
                })
              })
            }
            row.appendChild(btn)
            rows.push(row)
          })(list[i])
        }
      }
      nodes.push(section(title + '（' + list.length + '）', rows))
    }

    bucket('私聊白名单（可用只读工具）', 'private', allow.private, false, '还没有授权的私聊。')
    bucket('群白名单', 'group', allow.groups, false, '还没有授权的群。')
    bucket('私聊黑名单（不读、不存、不回）', 'private', deny.private, true, '黑名单为空。')
    bucket('群黑名单（不读、不存、不回）', 'group', deny.groups, true, '黑名单为空。')

    // 添加区
    var idInput = h('input', 'dsh-fb-input')
    idInput.placeholder = 'QQ 号 或 群号'
    idInput.style.maxWidth = '150px'
    var kindSel = h('select', 'dsh-fb-input')
    var o1 = h('option', null, '私聊'); o1.value = 'private'
    var o2 = h('option', null, '群'); o2.value = 'group'
    kindSel.appendChild(o1); kindSel.appendChild(o2)
    var addAllow = h('button', 'dsh-fb-btn', '加入白名单')
    addAllow.type = 'button'
    addAllow.addEventListener('click', function () { send('allow') })
    var addBlock = h('button', 'dsh-fb-btn ghost', '拉黑')
    addBlock.type = 'button'
    addBlock.addEventListener('click', function () { send('block') })
    function send(act) {
      var v = String(idInput.value || '').trim()
      if (!/^\d+$/.test(v)) { toast('请输入纯数字的 QQ 号或群号'); return }
      postJson(api, { action: act, kind: kindSel.value, id: v }).then(function (res) {
        toast(res && res.ok ? (act === 'allow' ? '已加入白名单' : '已拉黑') : ((res && res.error) || '操作失败'))
        loadTab('access')
      })
    }
    var addRow = h('div', 'dsh-fb-actions')
    addRow.appendChild(idInput); addRow.appendChild(kindSel)
    addRow.appendChild(addAllow); addRow.appendChild(addBlock)
    nodes.push(section('手动添加', [
      addRow,
      h('div', 'dsh-fb-warn', '白名单 = 允许它跟机器人对话；黑名单 = 完全无视（消息不进上下文、不消耗 token）。两个名单互斥，加入一边会自动从另一边移除。'),
      h('div', 'dsh-fb-warn', '⚠️ 当前是 reserved2 模式：准入只看白名单，不看管理员身份 —— 所以管理员账号也必须在白名单里才会被响应（本页已禁止踢出管理员，避免误操作把自己锁在外面）。'),
    ]))

    nodes.push(actionsRow([
      { label: '刷新', ghost: true, onClick: function () { loadTab('access') } },
    ]))
    setBody(nodes)
  }

  function renderBackendTab(d) {
    var list = Array.isArray(d.backends) ? d.backends : []
    var nodes = [section('桥接当前指向', [kv('DSH 地址', d.current)])]

    var rows = []
    if (!list.length) {
      rows.push(h('div', 'dsh-fb-empty', d.supported === false ? '当前平台不支持自动发现（仅 Windows）' : '没有发现运行中的 DSH 实例'))
    }
    for (var i = 0; i < list.length; i++) {
      (function (bk) {
        var row = h('div', 'dsh-fb-kv')
        row.appendChild(h('span', null, bk.label + ' · PID ' + bk.pid))
        row.appendChild(h('span', null, bk.url + (bk.current ? ' ← 当前' : '')))
        rows.push(row)
        if (!bk.current) {
          rows.push(actionsRow([{ label: '切换到' + bk.label, ghost: true, onClick: function () {
            postJson(mState.feature.api + '/backend', { url: bk.url }).then(function (res) {
              toast(res && res.ok ? (res.restartNote || '已切换') : ((res && res.error) || '切换失败'))
              loadTab('backend')
            })
          } }]))
        }
      })(list[i])
    }
    nodes.push(section('可用的 DSH 实例', rows))
    nodes.push(h('div', 'dsh-fb-warn', '切换会让桥接改连另一个 DSH 并自动重启。注意取舍：桌面端被关闭时机器人会一并下线；CLI 版可以独立常驻。'))
    setBody(nodes)
  }

  function renderDiagnoseTab(d) {
    var checks = Array.isArray(d.checks) ? d.checks : []
    var rows = []
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i]
      rows.push(statusLine(c.name + (c.detail ? '：' + c.detail : ''), c.ok === true))
    }
    var nodes = [section(d.ok ? '自检全部通过' : '自检发现问题', rows)]
    if (d.model) nodes.push(section('DSH 模型', [kv('当前模型', (d.model.provider ? d.model.provider + ' / ' : '') + (d.model.model || '—')), kv('思考强度', d.model.reasoningEffort)]))
    nodes.push(actionsRow([{ label: '重新检测', onClick: function () { loadTab('diagnose') } }]))
    setBody(nodes)
  }

  /* ---------------- toast ---------------- */

  function toast(text) {
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl)
    var cx = Math.max(80, Math.min(window.innerWidth - 80, pos.left + BALL / 2))
    var cy = Math.max(8, pos.top - 44)
    var el = document.createElement('div')
    el.className = 'dsh-fb-toast'
    el.textContent = text
    el.style.left = Math.round(cx) + 'px'
    el.style.top = Math.round(cy) + 'px'
    document.body.appendChild(el)
    toastEl = el
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      el.style.opacity = '0'
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el)
        if (toastEl === el) toastEl = null
      }, 180)
    }, 1900)
  }

  /* ---------------- ball ---------------- */

  function resetPos(announce) {
    pos = defaultPos()
    applyPos()
    savePos()
    if (open) positionPanel()
    if (announce) toast('已复位到默认位置')
  }

  function createBall() {
    var el = document.createElement('div')
    el.className = 'dsh-fb-ball'
    el.id = 'dsh-floatdock-ball'
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '0')
    el.setAttribute('aria-label', '打开小工具箱')
    el.title = '小工具箱 · 点击展开 / 拖动移动 / 双击复位'
    el.innerHTML = ICON_BALL

    el.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return
      e.preventDefault()
      try { el.setPointerCapture(e.pointerId) } catch (err) {}
      drag = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, moved: false }
    })

    el.addEventListener('pointermove', function (e) {
      if (!drag) return
      var dx = e.clientX - drag.x
      var dy = e.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return
      drag.moved = true
      el.dataset.drag = '1'
      pos = clampPos(drag.left + dx, drag.top + dy)
      applyPos()
      if (open) positionPanel()
    })

    function finish() {
      if (!drag) return
      var moved = drag.moved
      drag = null
      el.dataset.drag = '0'
      if (moved) {
        savePos()
        return
      }
      var now = Date.now()
      if (now - lastTap < 320) {
        lastTap = 0
        closePanel()
        resetPos(true)
        return
      }
      lastTap = now
      togglePanel()
    }

    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', function () {
      if (!drag) return
      drag = null
      el.dataset.drag = '0'
      savePos()
    })

    el.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        togglePanel()
      }
    })

    return el
  }

  /* ---------------- boot ---------------- */

  function boot() {
    injectStyle()

    ball = createBall()
    var saved = loadPos() || defaultPos()
    pos = clampPos(saved.left, saved.top)
    applyPos()
    document.body.appendChild(ball)
    savePos()

    for (var i = 0; i < FEATURES.length; i++) syncFeature(FEATURES[i])

    window.addEventListener('resize', function () {
      var next = clampPos(pos.left, pos.top)
      if (next.left !== pos.left || next.top !== pos.top) {
        pos = next
        applyPos()
        savePos()
      }
      if (open) positionPanel()
    })

    window.addEventListener('focus', function () {
      for (var j = 0; j < FEATURES.length; j++) syncFeature(FEATURES[j])
    })
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return
      for (var j = 0; j < FEATURES.length; j++) syncFeature(FEATURES[j])
    })
  }

  function apply() {
    if (window.__dshFloatDock) return
    window.__dshFloatDock = true
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot)
    } else {
      boot()
    }
  }

  exports.name = 'dsh-thinking-zh'
  exports.inject = []
  exports.apply = apply

  return module.exports
  },
})
