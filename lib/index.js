/**
 * dsh-prompt-library, host half.
 *
 * Cordis plugin that turns a small JSON file of prompts into slash commands:
 * one command per prompt, discovered in the composer's `/` menu, executing
 * directly against the session's agent. Executing a prompt submits its
 * content as a real user message (`agent.followup` with a user-role message),
 * so the model sees exactly what a hand-typed prompt would have sent — the
 * command itself never becomes a model message.
 *
 * Management lives in the Web GUI settings: this half serves one prefix
 * route (`/dsh-prompt-library/api`) with CRUD over the library, and the
 * browser half renders the settings page against it. Prompt commands are
 * re-registered whenever the file changes — whether the edit came from the
 * settings page, a manual editor, or the watcher debounce — so there is
 * exactly one command surface and one storage owner (the file).
 *
 * @module dsh-prompt-library
 */

import { watch } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import {
  buildSentMessage,
  normalizeName,
  readLibrary,
  removePrompt,
  sanitizeLibrary,
  upsertPrompt,
  validatePrompt,
  writeLibrary,
} from './library.js'

const ROUTE_PREFIX = '/dsh-prompt-library'
const PLUGIN_ID = 'dsh-prompt-library'

/**
 * Bumped whenever the host half changes shape; logged on activation and
 * reported by `/api/ping` so a loaded build is identifiable.
 */
const PLUGIN_REVISION = '2'

/** Debounce for the file watcher: editors fire many events per save. */
const WATCH_DEBOUNCE_MS = 300

/** Resolve the default library path under the Harness home. */
function defaultLibraryPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'prompt-library.json')
}

/** Resolve this plugin's library path from config, falling back to the home. */
function libraryPath(config) {
  if (typeof config?.libraryPath === 'string' && config.libraryPath !== '') {
    return isAbsolute(config.libraryPath) ? config.libraryPath : join(process.cwd(), config.libraryPath)
  }
  return defaultLibraryPath()
}

/**
 * Build the host half's state.
 * @param {object} config - the row's resolved config.
 * @returns {object} state.
 */
function createState(config) {
  return {
    file: libraryPath(config),
    /** Disposers for prompt commands currently registered. */
    disposers: [],
    /** In-flight re-registration, collapsed so watchers never stack. */
    registering: null,
    /** The fs watcher disposer, installed in apply(). */
    stopWatching: undefined,
  }
}

/** Read and JSON-parse a request body, bounded in size. */
function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 512 * 1024) reject(new Error('request body too large'))
    })
    req.on('end', () => {
      if (!raw.trim()) return resolvePromise({})
      try {
        resolvePromise(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error?.message ?? error}`))
      }
    })
    req.on('error', reject)
  })
}

/** Write one JSON response. */
function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/**
 * Register one slash command per prompt. Collapsed: concurrent calls share
 * one run, and a run always reflects the file as of its read.
 * @param {object} ctx - the cordis context.
 * @param {object} state - plugin state.
 * @returns {Promise<void>} resolves when the registration set matches the file.
 */
async function reregisterPrompts(ctx, state) {
  if (state.registering !== null) return state.registering

  state.registering = (async () => {
    const commands = ctx.get('commands')
    if (commands === undefined) return
    const library = await readLibrary(state.file)
    for (const dispose of state.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // A layer that already went away has nothing left to dispose.
      }
    }
    for (const prompt of library.prompts ?? []) {
      const row = prompt
      state.disposers.push(commands.register({
        name: row.name,
        description: row.description !== ''
          ? row.description
          : `发送提示词「${row.title}」`,
        input: { hint: '[附加说明…]' },
        handler: ({ agent, rawInput }) => {
          agent.followup(buildSentMessage(row, rawInput))
          return { kind: 'success', text: `已发送「${row.title}」${rawInput === '' ? '' : `（附加：${rawInput.trim()}）`}` }
        },
      }))
    }
  })()

  try {
    await state.registering
  } finally {
    state.registering = null
  }
}

/**
 * Build the HTTP route handler for the settings page's API.
 * @param {object} ctx - the cordis context.
 * @param {object} state - plugin state.
 */
function createRoute(ctx, state) {
  return {
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
      try {
        if (req.method === 'GET' && path === '/api/ping') {
          return sendJson(res, 200, { ok: true, plugin: PLUGIN_ID, revision: PLUGIN_REVISION, file: state.file })
        }

        if (req.method === 'GET' && path === '/api/prompts') {
          const library = await readLibrary(state.file)
          return sendJson(res, 200, {
            file: state.file,
            prompts: [...(library.prompts ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1)),
          })
        }

        if (req.method === 'POST' && (path === '/api/prompts' || path === '/api/prompts/update')) {
          const body = await readJsonBody(req)
          const library = await readLibrary(state.file)
          const creating = path === '/api/prompts'
          const selfName = creating ? undefined : body.previousName
          const fields = validatePrompt({
            name: body.name,
            content: body.content,
            description: body.description,
            title: body.title,
          }, library, selfName)
          upsertPrompt(library, fields, selfName)
          await writeLibrary(state.file, library)
          await reregisterPrompts(ctx, state)
          return sendJson(res, 200, { ok: true, name: fields.name })
        }

        if (req.method === 'POST' && path === '/api/prompts/delete') {
          const body = await readJsonBody(req)
          const name = normalizeName(body?.name)
          if (name === '') throw new Error('需要提示词名称')
          const library = await readLibrary(state.file)
          if (!removePrompt(library, name)) throw new Error(`/${name} 不存在`)
          await writeLibrary(state.file, library)
          await reregisterPrompts(ctx, state)
          return sendJson(res, 200, { ok: true })
        }

        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ error: 'not found' }))
      } catch (error) {
        sendJson(res, 400, { error: String(error?.message ?? error) })
      }
    },
  }
}

/** Build the host half's command wiring: seed + watch. */
function createCommandWiring(ctx, state) {
  return () => {
    const commands = ctx.get('commands')
    if (commands === undefined) {
      ctx.logger?.warn?.(`${PLUGIN_ID}: no commands service; prompt commands stay idle`)
      return undefined
    }

    // Seed from disk before the watcher fires, so the first / menu already
    // lists the persisted prompts.
    void reregisterPrompts(ctx, state)

    // Watch the library file: editors fire save bursts, so collapse them.
    let timer
    try {
      const watcher = watch(state.file, () => {
        clearTimeout(timer)
        timer = setTimeout(() => { void reregisterPrompts(ctx, state) }, WATCH_DEBOUNCE_MS)
      })
      watcher.unref?.()
      state.stopWatching = () => { clearTimeout(timer); watcher.close() }
    } catch {
      // No watcher (missing file is fine — it appears on first save; exotic
      // filesystems may refuse). The settings page still works: its writes
      // re-register directly.
      ctx.logger?.warn?.(`${PLUGIN_ID}: cannot watch ${state.file}; external edits apply on reload`)
    }

    return () => {
      clearTimeout(timer)
      state.stopWatching?.()
      for (const dispose of state.disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // Already gone.
        }
      }
    }
  }
}

/**
 * Activate the host half.
 *
 * Config keys (all optional):
 *   - `libraryPath` — where the library file lives; defaults to
 *     `<DSH_HOME>/prompt-library.json`. Tests point this at a temp file.
 *
 * @param {object} ctx - the cordis context owning this plugin.
 * @param {object} [config] - the row's config from the profile patch.
 */
export function apply(ctx, config) {
  const state = createState(config ?? {})

  ctx.effect(createCommandWiring(ctx, state), `${PLUGIN_ID}: commands`)

  // The Web carrier is optional: a headless composition simply never mounts
  // the settings API, and prompt commands keep working either way.
  ctx.effect(() => ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register(createRoute(ctx, state)))
  }).dispose)

  ctx.logger?.info?.(`${PLUGIN_ID} v${PLUGIN_REVISION}: prompt library at ${state.file}`)
}

export { PLUGIN_REVISION, PLUGIN_ID }

/** Re-exported for tests and reuse. */
export { sanitizeLibrary }
