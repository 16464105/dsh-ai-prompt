/**
 * dsh-prompt-library, browser half.
 *
 * One settings page under 设置 → 提示词库: the CRUD editor for the prompt
 * library. The page talks to the host half over its prefix route; the host
 * owns the file and re-registers the slash commands on every write, so the
 * page holds no state of its own beyond the form.
 *
 * Using a prompt stays in the composer: type `/` and pick it from the menu.
 *
 * No build step: DSH loads this file as a Cordis client bundle through the
 * `dsh.client` declaration in package.json. All business logic — file
 * storage, command registration — stays in the host half.
 */

window.__ModuleLoader__.load({
  id: 'dsh-prompt-library',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useCallback } = React

    const h = React.createElement
    const NS = 'dsh-prompt-library'
    const SECTION_ID = 'prompt-library'
    const API = '/dsh-prompt-library/api'

    /* ------------------------------------------------------------------ *
     * Copy
     * ------------------------------------------------------------------ */

    const zh = {
      'section': '提示词库',
      'subtitle': '维护常用提示词；在聊天输入框输入 / 即可选择发送。',
      'add': '新建提示词',
      'edit': '编辑提示词',
      'name': '名称（命令）',
      'nameHint': '小写字母开头，可含数字、-、_。输入 /<名称> 即可发送。',
      'title': '标题',
      'titleHint': '菜单里显示的名字，留空则用名称。',
      'content': '内容',
      'contentHint': '发送给 agent 的完整提示词。命令后追加的文字会拼接到末尾。',
      'description': '描述',
      'descriptionHint': '菜单里的说明文字。',
      'save': '保存',
      'saving': '保存中…',
      'saved': '已保存',
      'cancel': '取消',
      'delete': '删除',
      'deleting': '删除中…',
      'confirmDelete': '确定删除 /{name} ？',
      'use': '发送方式',
      'useHint': '输入 /{name} 直接发送，或输入 / 在菜单中选择；命令后可追加补充文字。',
      'empty.title': '还没有提示词',
      'empty.hint': '点击「新建提示词」添加第一条。保存后在输入框输入 / 就能选用。',
      'error': '出错了',
      'count': '{count} 条提示词',
    }

    const en = {
      'section': 'Prompt Library',
      'subtitle': 'Maintain reusable prompts; type / in the composer to pick one and send.',
      'add': 'New prompt',
      'edit': 'Edit prompt',
      'name': 'Name (command)',
      'nameHint': 'Lowercase letters first; digits, - and _ allowed. Type /<name> to send.',
      'title': 'Title',
      'titleHint': 'Shown in the menu; defaults to the name.',
      'content': 'Content',
      'contentHint': 'The full prompt sent to the agent. Text typed after the command is appended.',
      'description': 'Description',
      'descriptionHint': 'Shown in the menu.',
      'save': 'Save',
      'saving': 'Saving…',
      'saved': 'Saved',
      'cancel': 'Cancel',
      'delete': 'Delete',
      'deleting': 'Deleting…',
      'confirmDelete': 'Delete /{name}?',
      'use': 'How to send',
      'useHint': 'Type /{name} to send directly, or / to pick from the menu; trailing text is appended.',
      'empty.title': 'No prompts yet',
      'empty.hint': 'Click "New prompt" to add the first one. Type / in the composer to use it.',
      'error': 'Something went wrong',
      'count': '{count} prompts',
    }

    /* ------------------------------------------------------------------ *
     * Stylesheet
     * ------------------------------------------------------------------ */

    const CSS = `
.PLpage{display:flex;flex-direction:column;gap:14px;max-width:760px}
.PLhead{display:flex;align-items:baseline;gap:10px}
.PLtitle{font-size:15px;font-weight:600}
.PLsub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.PLcount{font-size:12px;color:var(--dsw-alias-label-secondary)}
.PLbtn{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 12px;height:30px;cursor:pointer;white-space:nowrap;transition:color .15s,border-color .15s,background .15s}
.PLbtn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-secondary)}
.PLbtn:disabled{opacity:.45;cursor:default}
.PLbtnPrimary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.PLbtnPrimary:hover:not(:disabled){color:#fff;opacity:.92}
.PLbtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.PLlist{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden}
.PLrow{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.PLrow:last-child{border-bottom:none}
.PLrow:hover{background:var(--dsw-alias-bg-layer-1)}
.PLcmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:var(--dsw-alias-brand-primary);flex:none}
.PLname{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.PLdesc{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.PLrowBtns{display:flex;gap:6px;flex:none}
.PLmini{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:3px 10px;height:24px;cursor:pointer;white-space:nowrap}
.PLmini:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.PLmini:disabled{opacity:.45;cursor:default}
.PLminiDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.PLform{display:flex;flex-direction:column;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px;background:var(--dsw-alias-bg-layer-1)}
.PLformHead{display:flex;align-items:center;gap:8px}
.PLformTitle{font-weight:600;font-size:13.5px;flex:1}
.PLlabel{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
.PLinput{font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;height:32px;outline:none;box-sizing:border-box;width:100%}
.PLinput:focus,.PLtextarea:focus{border-color:var(--dsw-alias-brand-primary)}
.PLtextarea{font:inherit;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px;resize:vertical;min-height:110px;outline:none;box-sizing:border-box;width:100%;line-height:1.55}
.PLhint{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.85}
.PLerror{color:var(--dsw-alias-state-error-primary);font-size:12px}
.PLok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.PLcenter{padding:26px;text-align:center;color:var(--dsw-alias-label-secondary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.PLcenterTitle{font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:6px}
.PLuse{font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 12px;line-height:1.6}
.PLuse code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-brand-primary)}
`

    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-prompt-library"]') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-prompt-library'
      tag.dataset.pluginCss = 'dsh-prompt-library'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------ *
     * API
     * ------------------------------------------------------------------ */

    /** Call the host route, surfacing the host's error message verbatim. */
    async function callApi(path, init) {
      const headers = { accept: 'application/json' }
      if (init !== undefined && init.body !== undefined) headers['content-type'] = 'application/json'
      const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
      return data
    }

    /* ------------------------------------------------------------------ *
     * Editor form
     * ------------------------------------------------------------------ */

    function PromptForm({ initial, onSaved, onCancel, t }) {
      const [name, setName] = useState(initial?.name ?? '')
      const [title, setTitle] = useState(initial?.title === initial?.name ? '' : (initial?.title ?? ''))
      const [content, setContent] = useState(initial?.content ?? '')
      const [description, setDescription] = useState(initial?.description ?? '')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [savedName, setSavedName] = useState(null)

      const submit = useCallback(async () => {
        setBusy(true)
        setError(null)
        try {
          const result = await callApi(initial === undefined ? '/prompts' : '/prompts/update', {
            method: 'POST',
            body: JSON.stringify({
              name,
              title,
              content,
              description,
              ...(initial !== undefined ? { previousName: initial.name } : {}),
            }),
          })
          setSavedName(result.name)
          setTimeout(() => { onSaved() }, 500)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [name, title, content, description, initial, onSaved])

      const canSubmit = name.trim() !== '' && content.trim() !== '' && !busy

      return h('form', { className: 'PLform', onSubmit: (event) => { event.preventDefault(); if (canSubmit) submit() } },
        h('div', { className: 'PLformHead' },
          h('span', { className: 'PLformTitle' }, initial === undefined ? t('add') : `${t('edit')} /${initial.name}`),
          error !== null ? h('span', { className: 'PLerror' }, error) : null,
          savedName !== null ? h('span', { className: 'PLok' }, t('saved')) : null,
          h('button', { type: 'button', className: 'PLmini', onClick: onCancel, disabled: busy }, t('cancel')),
          h('button', {
            type: 'submit', className: 'PLbtn PLbtnPrimary', disabled: !canSubmit,
          }, busy ? t('saving') : t('save')),
        ),
        h('div', null,
          h('label', { className: 'PLlabel' }, t('name')),
          h('input', {
            className: 'PLinput', value: name, spellCheck: false, autoFocus: true,
            placeholder: 'my-prompt',
            onChange: (event) => { setName(event.target.value) },
          }),
          h('div', { className: 'PLhint' }, t('nameHint')),
        ),
        h('div', null,
          h('label', { className: 'PLlabel' }, t('title')),
          h('input', {
            className: 'PLinput', value: title,
            onChange: (event) => { setTitle(event.target.value) },
          }),
          h('div', { className: 'PLhint' }, t('titleHint')),
        ),
        h('div', null,
          h('label', { className: 'PLlabel' }, t('content')),
          h('textarea', {
            className: 'PLtextarea', value: content, spellCheck: false,
            onChange: (event) => { setContent(event.target.value) },
          }),
          h('div', { className: 'PLhint' }, t('contentHint')),
        ),
        h('div', null,
          h('label', { className: 'PLlabel' }, t('description')),
          h('input', {
            className: 'PLinput', value: description,
            onChange: (event) => { setDescription(event.target.value) },
          }),
          h('div', { className: 'PLhint' }, t('descriptionHint')),
        ),
        initial !== undefined
          ? h('div', { className: 'PLuse' },
            `${t('use')}：`,
            h('code', null, `/${initial.name}`),
            ` — ${t('useHint').replace('{name}', initial.name)}`)
          : null,
      )
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */

    function PromptLibraryPage({ t }) {
      const [prompts, setPrompts] = useState(undefined)
      const [file, setFile] = useState('')
      const [error, setError] = useState(null)
      const [editing, setEditing] = useState(undefined) // undefined = list, null = creating, object = editing
      const [deleting, setDeleting] = useState(null)
      const [confirmName, setConfirmName] = useState(null)

      const load = useCallback(async () => {
        try {
          const data = await callApi('/prompts')
          setPrompts(data.prompts ?? [])
          setFile(data.file ?? '')
          setError(null)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const remove = useCallback(async (name) => {
        setDeleting(name)
        setError(null)
        try {
          await callApi('/prompts/delete', { method: 'POST', body: JSON.stringify({ name }) })
          setConfirmName(null)
          await load()
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setDeleting(null)
        }
      }, [load])

      const rows = prompts ?? []

      return h('div', { className: 'PLpage' },
        h('div', { className: 'PLhead' },
          h('span', { className: 'PLtitle' }, t('section')),
          h('span', { className: 'PLsub' }, t('subtitle')),
        ),

        error !== null ? h('div', { className: 'PLerror' }, `${t('error')}: ${error}`) : null,

        editing === undefined
          ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('span', { className: 'PLcount' }, t('count').replace('{count}', String(rows.length))),
            h('div', { style: { flex: 1 } }),
            h('button', {
              type: 'button', className: 'PLbtn PLbtnPrimary',
              onClick: () => { setEditing(null) },
            }, t('add')),
          )
          : null,

        editing !== undefined
          ? h(PromptForm, {
            initial: editing === null ? undefined : editing,
            t,
            onCancel: () => { setEditing(undefined) },
            onSaved: () => { setEditing(undefined); load() },
          })
          : prompts === undefined
            ? null
            : rows.length === 0
              ? h('div', { className: 'PLcenter' },
                h('div', { className: 'PLcenterTitle' }, t('empty.title')),
                h('div', null, t('empty.hint')))
              : h('div', { className: 'PLlist' },
                ...rows.map((row) => h('div', { key: row.name, className: 'PLrow' },
                  h('span', { className: 'PLcmd' }, `/${row.name}`),
                  h('span', { className: 'PLname', title: row.title }, row.title),
                  h('span', { className: 'PLdesc', title: row.description }, row.description),
                  h('span', { className: 'PLrowBtns' },
                    confirmName === row.name
                      ? h('button', {
                        type: 'button', className: 'PLmini PLminiDanger', disabled: deleting !== null,
                        onClick: () => { remove(row.name) },
                      }, deleting === row.name ? t('deleting') : t('confirmDelete').replace('{name}', row.name))
                      : null,
                    h('button', {
                      type: 'button', className: 'PLmini PLminiDanger',
                      onClick: () => { setConfirmName(confirmName === row.name ? null : row.name) },
                    }, t('delete')),
                    h('button', {
                      type: 'button', className: 'PLmini',
                      onClick: () => { setEditing(row) },
                    }, t('edit')),
                  ),
                ))),
      )
    }

    /* ------------------------------------------------------------------ *
     * Registration
     * ------------------------------------------------------------------ */

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-prompt-library: dictionaries')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: SECTION_ID,
        order: 60,
        locale: NS,
        label: () => t('section'),
      }, PromptLibraryPage))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
