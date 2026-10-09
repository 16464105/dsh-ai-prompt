/**
 * dsh-prompt-library, prompt library model.
 *
 * Pure storage and naming logic for the prompt library: no cordis, no node
 * plugins beyond `node:fs/promises` and `node:crypto`. The host half in
 * `index.js` wires this module into the human-command registry; tests drive
 * it directly.
 *
 * One library file holds every prompt:
 *
 *     { "version": 1, "prompts": [{ "name", "title", "content", "description", "createdAt", "updatedAt" }] }
 *
 * `name` is the slash-command token (lowercase, `[a-z][a-z0-9_-]*` — the
 * exact grammar the Host command registry enforces); it doubles as the
 * command the composer claims. Everything else is display metadata.
 *
 * @module dsh-prompt-library/library
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** On-disk schema version of the library file. */
export const LIBRARY_VERSION = 1

/** The command-name grammar the Host command registry accepts. */
export const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/u

/** Per-prompt content cap: prompts are chat-sized payloads, not documents. */
export const MAX_CONTENT_CHARS = 32_000

/** Per-prompt title/name cap, keeping the `/` menu row readable. */
export const MAX_NAME_CHARS = 40

/** Per-prompt description cap shown in discovery. */
export const MAX_DESCRIPTION_CHARS = 200

/** How many prompts one library may hold. */
export const MAX_PROMPTS = 500

/**
 * Normalize a free-form name to a command token: lowercase, fold spaces and
 * disallowed punctuation to `-`, collapse runs, trim edge dashes.
 * @param {string} raw - the operator's name, any case or spacing.
 * @returns {string} the normalized token, possibly empty.
 */
export function normalizeName(raw) {
  const folded = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return folded.slice(0, MAX_NAME_CHARS).replace(/-+$/g, '')
}

/**
 * Validate one prompt update against the library.
 * @param {unknown} input - candidate `{ name, content, description? }`.
 * @param {{ prompts?: { name: string }[] }} [library] - current library, for
 *   duplicate-name checks (`undefined` skips the check).
 * @param {string} [selfName] - the prompt's own name when renaming.
 * @returns {{ name: string, content: string, description: string }} the
 *   validated fields, with `description` defaulting to `''`.
 * @throws {Error} with an operator-readable message on any violation.
 */
export function validatePrompt(input, library, selfName) {
  if (typeof input !== 'object' || input === null) throw new Error('a prompt object is required')

  const name = normalizeName(input.name)
  if (name === '') throw new Error('提示词名称不能为空（仅限小写字母、数字、- 和 _）')
  if (!COMMAND_NAME.test(name)) throw new Error(`名称 "${name}" 不合法：仅限小写字母开头，小写字母、数字、- 或 _`)
  if (name === 'help') throw new Error('"help" 已被系统占用，请换一个名称')

  const content = typeof input.content === 'string' ? input.content : ''
  if (content.trim().length === 0) throw new Error('提示词内容不能为空')
  if (content.length > MAX_CONTENT_CHARS) {
    throw new Error(`提示词内容过长（${content.length} > ${MAX_CONTENT_CHARS} 字符）`)
  }

  const description = typeof input.description === 'string'
    ? input.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
    : ''

  if (library !== undefined && name !== selfName) {
    const clash = (library.prompts ?? []).some((prompt) => prompt.name === name)
    if (clash) throw new Error(`/${name} 已存在，请换一个名称`)
  }

  return { name, content, description }
}

/** Build the empty persisted library. */
export function emptyLibrary() {
  return { version: LIBRARY_VERSION, prompts: [] }
}

/**
 * Sanitize a parsed library file: drop malformed rows, coerce unknown
 * versions to the current shape, never throw.
 * @param {unknown} parsed - the JSON.parse result, untrusted.
 * @returns {{ version: number, prompts: object[] }} a well-formed library.
 */
export function sanitizeLibrary(parsed) {
  if (typeof parsed !== 'object' || parsed === null) return emptyLibrary()
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : []
  const clean = []
  const seen = new Set()
  for (const row of prompts) {
    if (typeof row !== 'object' || row === null) continue
    const name = typeof row.name === 'string' ? row.name : ''
    const content = typeof row.content === 'string' ? row.content : ''
    if (!COMMAND_NAME.test(name) || content.trim() === '' || seen.has(name)) continue
    seen.add(name)
    clean.push({
      name,
      title: typeof row.title === 'string' && row.title.trim() !== '' ? row.title : name,
      content,
      description: typeof row.description === 'string' ? row.description : '',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
    })
  }
  return { version: LIBRARY_VERSION, prompts: clean.slice(0, MAX_PROMPTS) }
}

/**
 * Read and sanitize the library file.
 * @param {string} file - absolute library path.
 * @returns {Promise<{ version: number, prompts: object[] }>} the library;
 *   a missing or corrupt file reads as empty.
 */
export async function readLibrary(file) {
  try {
    return sanitizeLibrary(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return emptyLibrary()
  }
}

/**
 * Atomically persist the library: write a temp sibling, then rename over the
 * target so a crash can never leave a half-written file.
 * @param {string} file - absolute library path.
 * @param {{ version: number, prompts: object[] }} library - the library.
 */
export async function writeLibrary(file, library) {
  await mkdir(dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(temp, `${JSON.stringify(library, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Insert or update one prompt.
 * @param {{ version: number, prompts: object[] }} library - mutated in place.
 * @param {{ name: string, content: string, description?: string, title?: string }} input - validated fields.
 * @param {string} [selfName] - when renaming, the prompt's previous name.
 * @returns {object} the stored prompt row.
 */
export function upsertPrompt(library, input, selfName) {
  const now = new Date().toISOString()
  const prompts = library.prompts ?? (library.prompts = [])
  const existing = prompts.find((prompt) => prompt.name === (selfName ?? input.name))
  if (existing === undefined) {
    if (prompts.length >= MAX_PROMPTS) throw new Error(`提示词数量已达上限（${MAX_PROMPTS}）`)
    const row = {
      name: input.name,
      title: input.title?.trim() || input.name,
      content: input.content,
      description: input.description ?? '',
      createdAt: now,
      updatedAt: now,
    }
    prompts.push(row)
    return row
  }
  existing.name = input.name
  existing.title = input.title?.trim() || input.name
  existing.content = input.content
  existing.description = input.description ?? ''
  existing.updatedAt = now
  return existing
}

/**
 * Remove one prompt by name.
 * @param {{ version: number, prompts: object[] }} library - mutated in place.
 * @param {string} name - exact command token.
 * @returns {boolean} whether a row was removed.
 */
export function removePrompt(library, name) {
  const prompts = library.prompts ?? []
  const at = prompts.findIndex((prompt) => prompt.name === name)
  if (at === -1) return false
  prompts.splice(at, 1)
  return true
}

/**
 * Render the `/prompts` overview text: one row per prompt plus the exact
 * management commands. Kept ASCII-plain so it renders the same in every UI.
 * @param {{ prompts: object[] }} library - current library.
 * @returns {string} the overview.
 */
export function renderOverview(library) {
  const prompts = [...(library.prompts ?? [])].sort((a, b) => (a.name < b.name ? -1 : 1))
  if (prompts.length === 0) {
    return [
      '提示词库是空的。',
      '',
      '添加第一个提示词：',
      '  /prompt-add <名称> <提示词内容>',
      '',
      '之后在输入框输入 / 即可在菜单里选择它，回车直接发送。',
      '管理：/prompt-list /prompt-show <名称> /prompt-edit <名称> <新内容> /prompt-rm <名称>',
    ].join('\n')
  }
  const rows = prompts.map((prompt) => {
    const description = prompt.description !== '' ? ` — ${prompt.description}` : ''
    return `  /${prompt.name} — ${prompt.title}${description}`
  })
  return [
    `提示词库（${prompts.length} 条）：`,
    ...rows,
    '',
    '发送：输入 / 选择，或 /<名称> 直接发送；参数会追加到提示词之后。',
    '管理：/prompt-add <名称> <内容> · /prompt-show <名称> · /prompt-edit <名称> <新内容> · /prompt-rm <名称>',
  ].join('\n')
}

/**
 * Build the message this plugin appends for a *sent* prompt: one text block
 * carrying the prompt content, with any operator arguments appended.
 * @param {object} prompt - the stored prompt row.
 * @param {string} rawInput - trailing arguments from the command line.
 * @returns {{ role: string, source: object, content: object[], id: string }}
 *   a user-role message shaped exactly like `createUserMessage` output.
 */
export function buildSentMessage(prompt, rawInput) {
  const args = typeof rawInput === 'string' ? rawInput.trim() : ''
  const text = args === '' ? prompt.content : `${prompt.content}\n\n${args}`
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
    id: randomUUID(),
  }
}
