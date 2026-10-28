import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-floatdock-'))
process.env.DSH_HOME = tmpHome

const { apply, name, inject } = await import('../lib/index.js')

const sections = []
const routes = []
const taps = []
const effects = []

const ctx = {
  systemPrompt: {
    section(section) {
      sections.push(section)
      return () => {}
    },
  },
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex(fn) {
      taps.push(fn)
      return () => {}
    },
  },
  effect(fn) {
    effects.push(fn)
    return () => {}
  },
}

apply(ctx)

assert.equal(name, 'dsh-thinking-zh')
assert.deepEqual(inject, ['systemPrompt', 'webServer'])

// --- the feature contributed exactly one prompt section ---
assert.equal(sections.length, 1)
assert.equal(sections[0].name, 'thinking-language-zh')
assert.equal(sections[0].order, 10250)
assert.match(sections[0].text({}), /简体中文/)
assert.match(sections[0].text({}), /代码、命令、报错信息/)

// --- the feature registered only its own state route; the client asset comes
// from the module loader instead of an HTTP route ---
const stateRoute = routes.find((r) => r.path === '/dsh-thinking-zh/state')
assert.ok(stateRoute, 'feature state route registered')
assert.equal(taps.length, 0, 'no index injection is registered anymore')

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      this.headers = headers || {}
    },
    end(chunk) {
      this.body = chunk === undefined ? '' : String(chunk)
    },
  }
}

async function call(payload, { method = 'POST', contentType = 'application/json' } = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.method = method
  req.headers = contentType === null ? {} : { 'content-type': contentType }
  const res = makeRes()
  await stateRoute.handler(req, res)
  const json = res.body === '' ? null : JSON.parse(res.body)
  return { res, json }
}

// --- switch on/off and modes reach the prompt section ---
let out = await call({ enabled: false })
assert.equal(out.res.statusCode, 200)
assert.equal(out.json.state.enabled, false)
assert.equal(sections[0].text({}), '')

out = await call({ enabled: true, mode: 'mixed' })
assert.equal(out.json.state.enabled, true)
assert.equal(out.json.state.mode, 'mixed')
assert.match(sections[0].text({}), /中英混用/)

out = await call({ mode: 'auto' })
assert.equal(out.json.state.mode, 'auto')
assert.match(sections[0].text({}), /跟随用户语言/)

// --- request hardening ---
out = await call({ enabled: true }, { method: 'DELETE' })
assert.equal(out.res.statusCode, 405)
assert.equal(out.res.headers.Allow, 'GET, POST, PUT')

out = await call({ enabled: true }, { contentType: 'text/plain' })
assert.equal(out.res.statusCode, 415)

out = await call({ enabled: true }, { contentType: null })
assert.equal(out.res.statusCode, 415)

// --- corrupt state must not be trusted ---
const stateFile = path.join(tmpHome, '.dsh-thinking-zh.json')

function mountFresh() {
  const collected = []
  apply({
    systemPrompt: {
      section: (s) => {
        collected.push(s)
        return () => {}
      },
    },
    webServer: { register: () => () => {}, tapIndex: () => () => {} },
    effect: () => () => {},
  })
  return collected.at(-1)
}

fs.writeFileSync(stateFile, JSON.stringify({ enabled: false, mode: 'bogus' }), 'utf8')
assert.equal(mountFresh().text({}), '', 'boolean false must disable the section')

fs.writeFileSync(stateFile, JSON.stringify({ enabled: 'false' }), 'utf8')
assert.match(
  mountFresh().text({}),
  /简体中文/,
  'a non-boolean enabled falls back to the default instead of stringifying'
)

// --- the client half is a module-loader plugin, not an injected asset ---
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
assert.equal(manifest.dsh.client.platform, 'web', 'client platform is declared')
assert.equal(manifest.exports['./client'], './lib/client.js', 'client entry is exported')
assert.equal(manifest.exports['.'], './lib/index.js', 'host entry is exported')

const clientJs = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
assert.match(clientJs, /__ModuleLoader__\.load\(/, 'registered through the page module loader')
assert.match(clientJs, /id:\s*'dsh-thinking-zh'/, 'module id matches the package name')
assert.match(clientJs, /exports\.apply\s*=/, 'exposes apply')
assert.match(clientJs, /dsh-fb-ball/, 'floating ball is rendered')
assert.match(clientJs, /position:fixed/, 'ball is position:fixed')
assert.match(clientJs, /localStorage/, 'position is persisted')
assert.match(clientJs, /FEATURES\s*=/, 'features live in a registry')
assert.match(clientJs, /pointerdown/, 'drag gesture is wired')
assert.ok(!/data-composer-card/.test(clientJs), 'no composer DOM dependency anymore')
assert.ok(!/data-composer-seat/.test(clientJs), 'no composer seat dependency anymore')

// --- teardown is wired through ctx.effect ---
assert.equal(effects.length, 1)
assert.doesNotThrow(() => effects[0]()())

console.log('SMOKE OK')
console.log('tmpHome=' + tmpHome)
