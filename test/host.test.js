/**
 * Unit tests for the dsh-prompt-library host half.
 *
 * The cordis context is stubbed with the minimum surface the plugin uses:
 * `ctx.get('commands')`, `ctx.inject(['webServer'])`, `ctx.effect`, and
 * `ctx.logger`. The command registry stub mirrors the real contract that
 * matters here — register() returns an exact disposer, and duplicate names
 * within one layer throw. The route handler is exercised through Node's
 * http stack over an ephemeral port, like a real carrier would.
 *
 * Run: node --test test/host.test.js
 */

import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, PLUGIN_REVISION } from '../lib/index.js'
import { emptyLibrary, upsertPrompt, writeLibrary } from '../lib/library.js'

/** Minimal command-registry stub with the real duplicate-name rule. */
class CommandRegistryStub {
  constructor() {
    this.commands = new Map()
  }

  register(definition) {
    if (typeof definition.handler !== 'function') throw new TypeError('handler must be a function')
    if (this.commands.has(definition.name)) {
      throw new Error(`command "${definition.name}" is already registered`)
    }
    this.commands.set(definition.name, definition)
    return () => { this.commands.delete(definition.name) }
  }
}

/** Minimal cordis-context stub capturing effects and exposing services. */
class CtxStub {
  constructor({ commands = true } = {}) {
    this.services = new Map()
    if (commands) this.services.set('commands', new CommandRegistryStub())
    /** Routes registered against the (stub) web carrier. */
    this.routes = []
    /** Disposers captured from the inner webCtx effects. */
    this.routeDisposers = []
    this.effects = []
    this.logs = []
    const self = this
    this.logger = {
      info: (message) => { self.logs.push(['info', message]) },
      warn: (message) => { self.logs.push(['warn', message]) },
    }
  }

  get(name) {
    return this.services.get(name)
  }

  inject(names, callback) {
    // Only ['webServer'] is ever requested. The inner effect's disposer is
    // captured so tests can fire teardown exactly like the real context.
    const webCtx = {
      effect: (callback2) => {
        const dispose = callback2() ?? (() => {})
        this.routeDisposers.push(dispose)
        return { dispose }
      },
      webServer: {
        register: (route) => {
          this.routes.push(route)
          return () => {
            const at = this.routes.indexOf(route)
            if (at !== -1) this.routes.splice(at, 1)
          }
        },
      },
    }
    callback(webCtx)
    return { dispose: () => {} }
  }

  effect(callback, _label) {
    this.effects.push({ callback })
    const dispose = callback()
    if (dispose !== undefined) this.effects.at(-1).dispose = dispose
    return () => this.effects.at(-1)?.dispose?.()
  }
}

/** Serve one stub route over a real ephemeral port and return a base URL.
 *
 * The real carrier hands prefix routes the FULL pathname (prefix included),
 * so the wrapper passes `req.url` through untouched and tests call the
 * prefixed URLs.
 */
async function serveRoute(route) {
  const server = http.createServer((req, res) => {
    Promise.resolve(route.handler(req, res)).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  return {
    base: `http://127.0.0.1:${port}${route.path}`,
    close: () => new Promise((resolve) => { server.close(resolve) }),
  }
}

/** JSON fetch helper. */
async function json(base, path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const body = await res.json()
  return { status: res.status, body }
}

async function makeLibraryFile(prompts = []) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-host-'))
  const file = join(dir, 'library.json')
  const library = emptyLibrary()
  for (const prompt of prompts) upsertPrompt(library, prompt)
  await writeLibrary(file, library)
  return { dir, file }
}

/** Activate the plugin and wait for the async seed registration to drain. */
async function activate(config, { commands = true } = {}) {
  const ctx = new CtxStub({ commands })
  apply(ctx, config)
  await new Promise((resolve) => setTimeout(resolve, 25))
  return ctx
}

test('prompt commands register from the file; no management commands exist', async () => {
  const { dir, file } = await makeLibraryFile([
    { name: 'review', content: '请审查代码', description: '代码审查' },
  ])
  try {
    const ctx = await activate({ libraryPath: file })
    const commands = ctx.services.get('commands')
    assert.ok(commands.commands.has('review'), '/review should be registered')
    assert.equal(commands.commands.get('review').description, '代码审查')
    for (const gone of ['prompts', 'prompt-add', 'prompt-show', 'prompt-edit', 'prompt-rm']) {
      assert.equal(commands.commands.has(gone), false, `/${gone} must not exist anymore`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a prompt command submits a user-role message via agent.followup', async () => {
  const { dir, file } = await makeLibraryFile([{ name: 'review', content: '请审查代码' }])
  try {
    const ctx = await activate({ libraryPath: file })
    const sent = []
    const handler = ctx.services.get('commands').commands.get('review').handler
    const result = await handler({ agent: { followup: (m) => { sent.push(m) } }, rawInput: ' 关注安全' })

    assert.equal(result.kind, 'success')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].role, 'user')
    assert.deepEqual(sent[0].content, [{ type: 'text', text: '请审查代码\n\n关注安全' }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('settings API: list, create, update, delete', async () => {
  const { dir, file } = await makeLibraryFile([{ name: 'existing', content: 'x' }])
  try {
    const ctx = await activate({ libraryPath: file })
    assert.equal(ctx.routes.length, 1, 'the prefix route is registered')
    const { base, close } = await serveRoute(ctx.routes[0])

    const listed = await json(base, '/api/prompts')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.prompts.map((row) => row.name), ['existing'])

    // Create
    const created = await json(base, '/api/prompts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Fresh One', content: '内容', description: '描述' }),
    })
    assert.equal(created.status, 200, JSON.stringify(created.body))
    assert.equal(created.body.name, 'fresh-one')
    // The command registered live.
    assert.ok(ctx.services.get('commands').commands.has('fresh-one'))

    // Duplicate name refused with a readable error.
    const duplicate = await json(base, '/api/prompts', {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh-one', content: 'y' }),
    })
    assert.equal(duplicate.status, 400)
    assert.match(duplicate.body.error, /已存在/)

    // Update (rename existing)
    const updated = await json(base, '/api/prompts/update', {
      method: 'POST',
      body: JSON.stringify({ previousName: 'existing', name: 'renamed', content: '新内容' }),
    })
    assert.equal(updated.status, 200, JSON.stringify(updated.body))
    const after = await json(base, '/api/prompts')
    assert.deepEqual(after.body.prompts.map((row) => row.name), ['fresh-one', 'renamed'])

    // Delete
    const deleted = await json(base, '/api/prompts/delete', {
      method: 'POST',
      body: JSON.stringify({ name: 'fresh-one' }),
    })
    assert.equal(deleted.status, 200)
    assert.equal(ctx.services.get('commands').commands.has('fresh-one'), false)

    // Ping reports the build revision.
    const ping = await json(base, '/api/ping')
    assert.equal(ping.body.revision, PLUGIN_REVISION)

    await close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('editing the file on disk is picked up by the watcher', async () => {
  const { dir, file } = await makeLibraryFile([])
  try {
    const ctx = await activate({ libraryPath: file })
    const library = emptyLibrary()
    upsertPrompt(library, { name: 'watched', content: '来自文件' })
    await writeLibrary(file, library)
    const later = new Date(Date.now() + 1100)
    const { utimes } = await import('node:fs/promises')
    await utimes(file, later, later)

    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.ok(ctx.services.get('commands').commands.has('watched'), 'watcher registered the new prompt')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('dispose removes every command and the route', async () => {
  const { dir, file } = await makeLibraryFile([{ name: 'review', content: 'x' }])
  try {
    const ctx = await activate({ libraryPath: file })
    const commands = ctx.services.get('commands')
    for (const effect of ctx.effects) effect.dispose?.()
    assert.equal(commands.commands.size, 0, 'every command registration is disposed')
    // The route's unregister is registered on the inner webCtx effect, which
    // the stub's inject() applies eagerly — capture and fire it here.
    assert.ok(ctx.routeDisposers.length >= 1, 'the route unregister effect exists')
    for (const dispose of ctx.routeDisposers.splice(0)) dispose()
    assert.equal(ctx.routes.length, 0, 'the settings route is disposed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('without a commands service the plugin still serves the settings API', async () => {
  const { dir, file } = await makeLibraryFile([])
  try {
    const ctx = await activate({ libraryPath: file }, { commands: false })
    assert.ok(ctx.logs.some(([, message]) => message.includes('no commands service')))
    const { base, close } = await serveRoute(ctx.routes[0])
    const listed = await json(base, '/api/prompts')
    assert.equal(listed.status, 200)
    assert.deepEqual(listed.body.prompts, [])
    await close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
