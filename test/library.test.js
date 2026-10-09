/**
 * Unit tests for the dsh-prompt-library library model.
 *
 * Run: node --test test/library.test.js
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  COMMAND_NAME,
  MAX_CONTENT_CHARS,
  buildSentMessage,
  emptyLibrary,
  normalizeName,
  readLibrary,
  removePrompt,
  renderOverview,
  sanitizeLibrary,
  upsertPrompt,
  validatePrompt,
  writeLibrary,
} from '../lib/library.js'

test('normalizeName folds case, spaces, and punctuation to command tokens', () => {
  assert.equal(normalizeName('  Code Review  '), 'code-review')
  assert.equal(normalizeName('中文 提示'), '')
  assert.equal(normalizeName('MIXED case NAME'), 'mixed-case-name')
  assert.equal(normalizeName('trailing---dashes---'), 'trailing-dashes')
  assert.equal(normalizeName('multi   ___   space'), 'multi-space')
  assert.equal(normalizeName(''), '')
  assert.equal(normalizeName(undefined), '')
  // Long names clamp to the cap.
  assert.equal(normalizeName('a'.repeat(100)).length, 40)
})

test('normalizeName keeps registry-legal names intact', () => {
  for (const name of ['code-review', 'review2', 'my_prompt', 'a']) {
    const normalized = normalizeName(name)
    assert.ok(COMMAND_NAME.test(normalized), `${normalized} should match the command grammar`)
  }
})

test('validatePrompt accepts a good prompt and fills defaults', () => {
  const fields = validatePrompt({ name: 'Daily Standup', content: '汇报今天的工作…' })
  assert.equal(fields.name, 'daily-standup')
  assert.equal(fields.content, '汇报今天的工作…')
  assert.equal(fields.description, '')
})

test('validatePrompt rejects empty name, bad name, empty content, oversize content', () => {
  assert.throws(() => validatePrompt({ name: '', content: 'x' }), /名称不能为空/)
  assert.throws(() => validatePrompt({ name: '9start', content: 'x' }), /不合法/)
  // A name that normalizes to nothing reports the empty-name error instead.
  assert.throws(() => validatePrompt({ name: '中文', content: 'x' }), /名称不能为空/)
  assert.throws(() => validatePrompt({ name: 'ok-name', content: '   ' }), /内容不能为空/)
  assert.throws(
    () => validatePrompt({ name: 'ok-name', content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }),
    /过长/,
  )
  assert.throws(() => validatePrompt({ name: 'help', content: 'x' }), /help/)
})

test('validatePrompt detects duplicate names against the current library', () => {
  const library = { version: 1, prompts: [{ name: 'review', content: 'x' }] }
  assert.throws(() => validatePrompt({ name: 'review', content: 'y' }, library), /已存在/)
  // Renaming a prompt to its own name is fine.
  const fields = validatePrompt({ name: 'review', content: 'y' }, library, 'review')
  assert.equal(fields.name, 'review')
})

test('upsertPrompt inserts and renames in place', () => {
  const library = emptyLibrary()
  upsertPrompt(library, { name: 'alpha', content: 'one', description: 'first' })
  assert.equal(library.prompts.length, 1)
  assert.equal(library.prompts[0].name, 'alpha')
  assert.equal(library.prompts[0].createdAt, library.prompts[0].updatedAt)

  upsertPrompt(library, { name: 'alpha', content: 'one-v2' })
  assert.equal(library.prompts.length, 1)
  assert.equal(library.prompts[0].content, 'one-v2')

  upsertPrompt(library, { name: 'alpha-renamed', content: 'one-v2' }, 'alpha')
  assert.equal(library.prompts.length, 1)
  assert.equal(library.prompts[0].name, 'alpha-renamed')
})

test('removePrompt removes exactly the named row', () => {
  const library = { version: 1, prompts: [{ name: 'a', content: 'x' }, { name: 'b', content: 'y' }] }
  assert.equal(removePrompt(library, 'a'), true)
  assert.equal(library.prompts.length, 1)
  assert.equal(removePrompt(library, 'missing'), false)
})

test('sanitizeLibrary drops malformed rows and duplicates', () => {
  const clean = sanitizeLibrary({
    version: 99,
    prompts: [
      { name: 'good', content: 'x' },
      { name: 'Bad Name', content: 'x' },
      { name: 'empty', content: '  ' },
      { name: 'good', content: 'dupe' },
      null,
      'nope',
      { name: 'ok', content: 42 },
    ],
  })
  assert.deepEqual(clean.prompts.map((prompt) => prompt.name), ['good'])
  assert.equal(clean.version, 1)
})

test('library file round-trips through read/write and corrupt files read as empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-prompt-library-'))
  try {
    const file = join(dir, 'library.json')
    const library = emptyLibrary()
    upsertPrompt(library, { name: 'round-trip', content: '内容', description: 'desc' })
    await writeLibrary(file, library)

    const raw = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(raw.prompts[0].name, 'round-trip')

    const loaded = await readLibrary(file)
    assert.equal(loaded.prompts[0].content, '内容')

    await writeFile2(file, '{corrupt')
    assert.deepEqual(await readLibrary(file), emptyLibrary())
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

async function writeFile2(file, text) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, text, 'utf8')
}

test('renderOverview lists rows and management commands', () => {
  const empty = renderOverview(emptyLibrary())
  assert.match(empty, /提示词库是空的/)
  assert.match(empty, /\/prompt-add/)

  const library = { version: 1, prompts: [
    { name: 'b-second', title: '第二', content: 'x', description: '描述 B' },
    { name: 'a-first', title: '第一', content: 'x', description: '' },
  ] }
  const overview = renderOverview(library)
  assert.match(overview, /提示词库（2 条）/)
  const aAt = overview.indexOf('/a-first')
  const bAt = overview.indexOf('/b-second')
  assert.ok(aAt !== -1 && bAt !== -1 && aAt < bAt, 'rows render name-sorted')
  assert.match(overview, /— 第一/)
  assert.match(overview, /描述 B/)
  assert.match(overview, /\/prompt-rm/)
})

test('buildSentMessage appends arguments and produces a user-role message', () => {
  const prompt = { name: 'review', title: 'Review', content: '请审查以下代码：' }

  const bare = buildSentMessage(prompt, '')
  assert.equal(bare.role, 'user')
  assert.deepEqual(bare.source, { kind: 'user' })
  assert.deepEqual(bare.content, [{ type: 'text', text: '请审查以下代码：' }])
  assert.match(bare.id, /^[0-9a-f-]{36}$/)

  const withArgs = buildSentMessage(prompt, '  重点看安全漏洞  ')
  assert.deepEqual(withArgs.content, [{ type: 'text', text: '请审查以下代码：\n\n重点看安全漏洞' }])
})
