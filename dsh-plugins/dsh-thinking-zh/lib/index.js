/**
 * dsh-thinking-zh — a floating dock for DSH Desktop.
 *
 * The dock itself is one always-present ball in a corner of the page; every
 * capability is a feature listed in FEATURES. Each feature owns its host
 * wiring (prompt sections, HTTP routes) and its row in the dock panel.
 *
 * The browser half is a client plugin, not an injected script: `package.json`
 * declares `exports["./client"]` and `dsh.client`, so the page's module loader
 * loads lib/client.js in BOTH surfaces. The Electron window loads `dsh://app/`
 * rather than the HTTP origin, so `webServer.tapIndex` injection would never
 * reach it — that is why the dock is registered this way instead.
 *
 * Adding a capability: create lib/features/<id>.js exporting mount(ctx) and
 * metadata, add it to FEATURES, add a matching descriptor to FEATURES in
 * lib/client.js. Nothing else in this file changes.
 */
import * as thinkingZh from './features/thinking-zh.js'
import * as qqBigfish from './features/qq-bigfish.js'

const name = 'dsh-thinking-zh'
const inject = ['systemPrompt', 'webServer']

/** Every feature the dock can show. Keep in sync with lib/client.js. */
const FEATURES = [thinkingZh, qqBigfish]

function apply(ctx) {
  const disposers = []

  for (const feature of FEATURES) {
    const dispose = feature.mount(ctx)
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose() } catch {}
    }
  })

  console.log(`[dsh-floatdock] loaded; features=${FEATURES.map((f) => f.id).join(',')}`)
}

export { name, inject, apply }
