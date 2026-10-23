/**
 * Client-half tests.
 *
 * Mounts the real `lib/client.js` in a miniature React renderer with a stubbed
 * `fetch` and fake timers, then drives the composer button and the Settings
 * page the way a user would: click, wait, assert what changed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, installDom, loadClient, find, findAll, has, textOf, button } from './support.mjs'

const dom = installDom()
const { exports: client } = await loadClient()

/** Requests recorded by the stub `fetch`. */
let requests = []
/** Queue of canned responses; each entry is `{ status, body }` or a Promise of one. */
let responses = []

/** Install a `fetch` stub that records requests and answers from `responses`. */
function stubFetch() {
  requests = []
  responses = []
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
    const next = responses.length > 0 ? responses.shift() : { status: 200, body: { ok: true } }
    const resolved = typeof next === 'function' ? await next() : next
    return {
      ok: resolved.status >= 200 && resolved.status < 300,
      status: resolved.status,
      json: async () => resolved.body,
    }
  }
}

/** Mount one slot component of the client half against `props`. */
function mountComponent(props) {
  const slot = componentSlot()
  const renderer = createRenderer((rootProps) => slot(rootProps))
  renderer.setProps(props)
  return renderer
}

/**
 * Mount the composer button over a mutable draft, the way the host's composer
 * store behaves: `setDraft` updates the draft, and the `useInput` hook then
 * re-renders with that new value.
 * @param initialDraft - starting draft text.
 */
function mountComposer(initialDraft) {
  const slot = componentSlot()
  const state = { draft: initialDraft, writes: [] }
  const renderer = createRenderer((rootProps) => slot(rootProps))
  const props = {
    useInput: (select) => select(state),
    inputActions: {
      setDraft: (value) => {
        state.writes.push(value)
        state.draft = value
        renderer.setProps({})
      },
    },
  }
  renderer.setProps(props)
  return { renderer, state }
}

/** Pull one registered slot component out of the bundle's `apply` call. */
function componentSlot(target = 'conversation.input.left') {
  const registry = new Map()
  const slots = {
    inject(key, callback) {
      const disposer = callback()
      return disposer ?? (() => {})
    },
    register(options, component) {
      registry.set(options.name + '#' + options.id, { options, component })
      return () => registry.delete(options.name + '#' + options.id)
    },
  }
  const ctx = { get: (name) => (name === 'slots' ? slots : undefined) }
  client.apply(ctx)
  const entries = [...registry.values()]
  const match = entries.find((entry) => entry.options.name === target && typeof entry.component === 'function')
  assert.ok(match, 'client registers a component for ' + target)
  return match.component
}

/** Read the composer button element from a rendered tree. */
function composerButton(tree) {
  return find(tree, 'dsh-po-btn')
}

/** Read an input/textarea/select value. */
function control(tree, id) {
  const found = []
  const visit = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child); return }
    if (node.props?.id === id) found.push(node)
    visit(node.props?.children)
  }
  visit(tree)
  return found[0]
}

/** Click the button whose visible text is `label`. */
function click(tree, label) {
  const target = button(tree, label)
  assert.ok(target, 'button "' + label + '" exists')
  assert.notEqual(target.props.disabled, true, 'button "' + label + '" is enabled')
  target.props.onClick()
  return target
}

// ---------------------------------------------------------------- composer

test('composer: idle button renders the sparkle and announces the action', () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  const tree = renderer.render()
  const btn = composerButton(tree)
  assert.equal(btn.props.disabled, false)
  assert.equal(btn.props.title, '优化提示词')
  assert.equal(textOf(btn).trim(), '✨')
})

test('composer: the busy state shows the spinner only — no second "_" progress animation', () => {
  stubFetch()
  responses.push(() => new Promise(() => {}))
  const { renderer } = mountComposer('hello')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  renderer.render()
  const btn = composerButton(renderer.tree())
  assert.match(btn.props.className, /dsh-po-busy/)
  assert.equal(btn.props.title, '正在优化提示词…')
  assert.equal(find(renderer.tree(), 'dsh-po-progress'), undefined, 'the underscore/progress bar animation is gone')
  assert.equal(find(renderer.tree(), 'dsh-po-glyph') !== undefined, true, 'the icon sits in the animated wrapper')
})

test('composer: the stylesheet no longer defines the progress animation', () => {
  const css = dom.styleTags.map((tag) => tag.textContent).join(String.fromCharCode(10))
  assert.doesNotMatch(css, /dsh-po-progress/)
  assert.doesNotMatch(css, /dsh-po-slide/)
  assert.match(css, /dsh-po-spin/, 'the spinner animation is still there')
  assert.match(css, /dsh-po-glyph-in/, 'the icon swap has its own transition')
  assert.match(css, /prefers-reduced-motion/, 'the motion is opt-out for reduced-motion users')
})

test('composer: a successful optimization becomes undoable and restores the original text', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'polished prompt' } })
  const { renderer, state } = mountComposer('rough prompt')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()

  assert.deepEqual(state.writes, ['polished prompt'], 'the optimized text is written back once')
  assert.equal(state.draft, 'polished prompt', 'the composer draft is the optimized text')
  const btn = composerButton(renderer.tree())
  assert.match(btn.props.className, /dsh-po-undo/, 'success switches the icon to the undo affordance')
  assert.equal(btn.props.title, '撤销优化，恢复原始提示词')
  assert.equal(btn.props.disabled, false, 'the undo button stays clickable')
  assert.notEqual(textOf(btn).trim(), '✨', 'the icon is no longer the sparkle')

  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.deepEqual(state.writes, ['polished prompt', 'rough prompt'], 'undo restores the pre-click text')
  assert.equal(state.draft, 'rough prompt')
  assert.doesNotMatch(composerButton(renderer.tree()).props.className, /dsh-po-undo/)
  assert.equal(composerButton(renderer.tree()).props.title, '优化提示词')
  assert.equal(textOf(composerButton(renderer.tree())).trim(), '✨')
})

test('composer: undo is offered once and then cleared', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'v2' } })
  const { renderer, state } = mountComposer('v1')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()

  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.deepEqual(state.writes, ['v2', 'v1'])

  // The composer is back to the original text; the button must be idle again.
  const before = requests.length
  assert.equal(composerButton(renderer.tree()).props.disabled, false, 'the restored draft is optimizable again')
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.equal(requests.length, before + 1)
  assert.equal(requests.at(-1).url, '/api/prompt-optimizer')
})

test('composer: an empty draft stays disabled and never calls the endpoint', async () => {
  stubFetch()
  const { renderer } = mountComposer('   ')
  renderer.render()
  assert.equal(composerButton(renderer.tree()).props.disabled, true)
  assert.equal(requests.length, 0)
})

test('composer: editing the draft by hand drops the undo affordance', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'polished' } })
  const { renderer, state } = mountComposer('rough')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.match(composerButton(renderer.tree()).props.className, /dsh-po-undo/)

  state.draft = 'polished plus my own words'
  renderer.setProps({})
  await renderer.settle()
  assert.doesNotMatch(composerButton(renderer.tree()).props.className, /dsh-po-undo/,
    'a user edit after the optimization is not silently replaced')
  assert.equal(composerButton(renderer.tree()).props.title, '优化提示词')
})

test('composer: a failed call leaves the sparkle in place and logs the reason', async () => {
  stubFetch()
  responses.push({ status: 502, body: { error: 'model produced no output' } })
  const errors = []
  const original = console.error
  console.error = (...values) => errors.push(values.join(' '))
  try {
    const { renderer, state } = mountComposer('rough')
    renderer.render()
    composerButton(renderer.tree()).props.onClick()
    await renderer.settle()
    const btn = composerButton(renderer.tree())
    assert.equal(btn.props.title, '优化提示词', 'no undo state after a failure')
    assert.equal(textOf(btn).trim(), '✨')
    assert.deepEqual(state.writes, [], 'nothing is written back on failure')
  } finally {
    console.error = original
  }
  assert.ok(errors.some((line) => line.includes('model produced no output')), 'the failure is logged')
})

test('composer: legacy hosts still read props.input', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'legacy ok' } })
  const drafts = []
  const renderer = mountComponent({
    input: { draft: 'legacy draft' },
    inputActions: { setDraft: (value) => drafts.push(value) },
  })
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.deepEqual(drafts, ['legacy ok'])
})

// ----------------------------------------------------------------- settings

/** Mount the settings section against the stubbed config endpoint. */
function mountSettings(config, builtin) {
  const Section = componentSlot('settings.section')
  const renderer = createRenderer((props) => Section(props))
  renderer.setProps({})
  responses.push({
    status: 200,
    body: {
      config,
      builtin: builtin ?? { id: '', name: '内置默认', instruction: 'BUILTIN-INSTRUCTION' },
    },
  })
  return renderer
}

test('settings: the section loads the saved prompts and marks the default', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: 'p2',
    prompts: [
      { id: 'p1', name: '简洁版', instruction: 'KEEP IT SHORT' },
      { id: 'p2', name: '工程版', instruction: 'ENGINEERING' },
    ],
  })
  const tree = await renderer.settle()
  assert.equal(requests[0].url, '/api/prompt-optimizer/config')
  assert.equal(requests[0].method, 'GET')

  const names = findAll(tree, 'dsh-po-name').map((node) => textOf(node))
  assert.deepEqual(names, ['内置默认', '简洁版', '工程版'])
  const badges = findAll(tree, 'dsh-po-badge').map((node) => textOf(node))
  assert.deepEqual(badges, ['默认'])
  const cards = findAll(tree, 'dsh-po-card')
  assert.equal(cards.length, 3, 'the built-in prompt and both custom prompts render as cards')
})

test('settings: adding a prompt posts the complete document', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()

  click(renderer.tree(), '新增提示词')
  await renderer.settle()
  const nameInput = control(renderer.tree(), 'dsh-po-name-input')
  const text = control(renderer.tree(), 'dsh-po-instruction-input')
  nameInput.props.onChange({ target: { value: '严谨版' } })
  text.props.onChange({ target: { value: 'BE STRICT' } })
  await renderer.settle()

  responses.push({
    status: 200,
    body: { config: { defaultId: '', prompts: [{ id: 'p1', name: '严谨版', instruction: 'BE STRICT' }] } },
  })
  click(renderer.tree(), '保存')
  await renderer.settle()

  const post = requests.find((request) => request.method === 'POST')
  assert.equal(post.url, '/api/prompt-optimizer/config')
  const sent = JSON.parse(post.body)
  assert.equal(sent.config.prompts[0].name, '严谨版')
  assert.equal(sent.config.prompts[0].instruction, 'BE STRICT')
  const names = findAll(renderer.tree(), 'dsh-po-name').map((node) => textOf(node))
  assert.ok(names.includes('严谨版'), 'the saved prompt is rendered')
})

test('settings: the editor refuses an empty name or instruction', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  click(renderer.tree(), '新增提示词')
  await renderer.settle()

  click(renderer.tree(), '保存')
  await renderer.settle()
  assert.ok(textOf(renderer.tree()).includes('请填写名称'))
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0, 'nothing is posted')

  control(renderer.tree(), 'dsh-po-name-input').props.onChange({ target: { value: '有名字' } })
  await renderer.settle()
  click(renderer.tree(), '保存')
  await renderer.settle()
  assert.ok(textOf(renderer.tree()).includes('请填写提示词内容'))
})

test('settings: editing a prompt sends the updated text', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: 'p1',
    prompts: [{ id: 'p1', name: '旧名', instruction: 'OLD TEXT' }],
  })
  await renderer.settle()

  click(renderer.tree(), '编辑')
  await renderer.settle()
  control(renderer.tree(), 'dsh-po-name-input').props.onChange({ target: { value: '新名' } })
  control(renderer.tree(), 'dsh-po-instruction-input').props.onChange({ target: { value: 'NEW TEXT' } })
  await renderer.settle()

  responses.push({
    status: 200,
    body: { config: { defaultId: 'p1', prompts: [{ id: 'p1', name: '新名', instruction: 'NEW TEXT' }] } },
  })
  click(renderer.tree(), '保存')
  await renderer.settle()

  const post = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.deepEqual(post.config.prompts, [{ id: 'p1', name: '新名', instruction: 'NEW TEXT' }])
  assert.equal(post.config.defaultId, 'p1', 'editing keeps the default selection')
})

test('settings: deleting asks for confirmation and clears a matching default', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: 'p1',
    prompts: [
      { id: 'p1', name: '要删的', instruction: 'BYE' },
      { id: 'p2', name: '留下的', instruction: 'STAY' },
    ],
  })
  await renderer.settle()

  const deleteButtons = findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '删除')
  deleteButtons[0].props.onClick()
  await renderer.settle()
  assert.ok(button(renderer.tree(), '确认删除'), 'the first click only asks for confirmation')
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0)

  responses.push({
    status: 200,
    body: { config: { defaultId: '', prompts: [{ id: 'p2', name: '留下的', instruction: 'STAY' }] } },
  })
  click(renderer.tree(), '确认删除')
  await renderer.settle()

  const post = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.deepEqual(post.config.prompts.map((prompt) => prompt.id), ['p2'])
  assert.equal(post.config.defaultId, '', 'deleting the default prompt falls back to the built-in one')
})

test('settings: "设为默认" posts the new default and the badge follows it', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: '',
    prompts: [
      { id: 'p1', name: '一', instruction: 'ONE' },
      { id: 'p2', name: '二', instruction: 'TWO' },
    ],
  })
  await renderer.settle()
  assert.deepEqual(findAll(renderer.tree(), 'dsh-po-badge').map((node) => textOf(node)), ['默认'], 'the built-in row is default initially')

  const setDefaultButtons = findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '设为默认')
  responses.push({
    status: 200,
    body: { config: { defaultId: 'p1', prompts: [
      { id: 'p1', name: '一', instruction: 'ONE' },
      { id: 'p2', name: '二', instruction: 'TWO' },
    ] } },
  })
  setDefaultButtons[0].props.onClick()
  await renderer.settle()

  const post = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.equal(post.config.defaultId, 'p1')
  const cards = findAll(renderer.tree(), 'dsh-po-card')
  assert.equal(textOf(cards[1]).includes('默认'), true, 'the chosen prompt now shows the default badge')
})

test('settings: a failed save rolls back and shows the reason', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [{ id: 'p1', name: '一', instruction: 'ONE' }] })
  await renderer.settle()

  responses.push({ status: 400, body: { error: '提示词名称不能为空' } })
  const setDefaultButtons = findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '设为默认')
  setDefaultButtons[0].props.onClick()
  await renderer.settle()

  assert.ok(textOf(renderer.tree()).includes('提示词名称不能为空'), 'the server reason is shown')
  assert.deepEqual(findAll(renderer.tree(), 'dsh-po-badge').map((node) => textOf(node)), ['默认'], 'the optimistic default was rolled back')
})

test('settings: the test tab previews the selected prompt without saving', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: 'p1',
    prompts: [{ id: 'p1', name: '工程版', instruction: 'ENGINEERING' }],
  })
  await renderer.settle()

  click(renderer.tree(), '测试')
  await renderer.settle()
  assert.ok(has(renderer.tree(), 'dsh-po-tab-active'))

  const select = control(renderer.tree(), 'dsh-po-test-select')
  select.props.onChange({ target: { value: 'p1' } })
  control(renderer.tree(), 'dsh-po-test-input').props.onChange({ target: { value: '帮我修个 bug' } })
  await renderer.settle()

  responses.push({ status: 200, body: { optimized: '请修复登录页的空指针异常' } })
  click(renderer.tree(), '开始测试')
  await renderer.settle()

  const testRequest = requests.find((request) => request.url === '/api/prompt-optimizer/test')
  assert.ok(testRequest, 'the test endpoint is called')
  const sent = JSON.parse(testRequest.body)
  assert.equal(sent.instruction, 'ENGINEERING', 'the selected prompt is the one under test')
  assert.equal(sent.input, '帮我修个 bug')
  assert.equal(requests.filter((request) => request.method === 'POST').length, 1, 'testing writes no configuration')
  const preview = find(renderer.tree(), 'dsh-po-preview')
  assert.equal(textOf(preview).trim(), '请修复登录页的空指针异常')
})

test('settings: an empty test input keeps the button disabled', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  click(renderer.tree(), '测试')
  await renderer.settle()
  const start = button(renderer.tree(), '开始测试')
  assert.equal(start.props.disabled, true)
  assert.equal(requests.filter((request) => request.url === '/api/prompt-optimizer/test').length, 0)
})

test('settings: a test failure shows the model reason', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  click(renderer.tree(), '测试')
  await renderer.settle()
  control(renderer.tree(), 'dsh-po-test-input').props.onChange({ target: { value: 'x' } })
  await renderer.settle()

  responses.push({ status: 502, body: { error: 'model produced no output' } })
  click(renderer.tree(), '开始测试')
  await renderer.settle()
  assert.ok(textOf(renderer.tree()).includes('model produced no output'))
})

test('composer: an unchanged optimization does not offer a useless undo', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'same text' } })
  const { renderer } = mountComposer('same text')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.doesNotMatch(composerButton(renderer.tree()).props.className, /dsh-po-undo/)
  assert.equal(composerButton(renderer.tree()).props.title, '优化提示词')
})

test('settings: an older failed save cannot roll back a newer successful one', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: '',
    prompts: [
      { id: 'p1', name: '一', instruction: 'ONE' },
      { id: 'p2', name: '二', instruction: 'TWO' },
    ],
  })
  await renderer.settle()

  // First save: held open, then fails. Second save: resolves immediately and wins.
  let failFirst
  responses.push(() => new Promise((resolve) => { failFirst = resolve }))
  const defaults = findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '设为默认')
  defaults[0].props.onClick()
  await renderer.settle()

  responses.push({
    status: 200,
    body: { config: { defaultId: 'p2', prompts: [
      { id: 'p1', name: '一', instruction: 'ONE' },
      { id: 'p2', name: '二', instruction: 'TWO' },
    ] } },
  })
  const secondDefaults = findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '设为默认')
  secondDefaults[1].props.onClick()
  await renderer.settle()

  failFirst({ status: 400, body: { error: 'stale failure' } })
  await renderer.settle()

  const cards = findAll(renderer.tree(), 'dsh-po-card')
  assert.equal(textOf(cards[2]).includes('默认'), true, 'the newer default is still selected')
  assert.equal(textOf(renderer.tree()).includes('stale failure'), false, 'the stale failure is not surfaced')
})
