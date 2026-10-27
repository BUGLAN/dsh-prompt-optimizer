/**
 * Client-half tests.
 *
 * Mounts the real `lib/client.js` in a miniature React renderer with a stubbed
 * `fetch` and fake timers, then drives the composer button and the Settings
 * page the way a user would: click, wait, assert what changed.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, installDom, loadClient, find, findAll, has, textOf, button, walk } from './support.mjs'

const dom = installDom()
const { exports: client } = await loadClient()

/** Requests recorded by the stub `fetch`. */
let requests = []
/** Queue of canned responses; each entry is `{ status, body }` or a Promise of one. */
let responses = []
/** Seed document returned by the one startup config GET. */
let startupConfig = { defaultId: '', prompts: [] }
/** Seed capability returned by the startup config GET. */
let startupCapabilities = { image: false }

/**
 * Install a `fetch` stub that records requests and answers from `responses`.
 *
 * The plugin issues one configuration GET when `apply()` runs (to learn whether
 * the default prompt accepts images). That startup call is answered from a
 * default document and never consumes a queued response, so each test's queue
 * describes only the calls that test makes.
 */
function stubFetch() {
  requests = []
  responses = []
  startupConfig = { defaultId: '', prompts: [] }
  startupCapabilities = { image: false }
  const startupUrl = '/api/prompt-optimizer/config'
  let startupServed = false
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    const method = init?.method ?? 'GET'
    requests.push({ url: href, method, body: init?.body })
    if (!startupServed && href === startupUrl && method === 'GET') {
      startupServed = true
      return {
        ok: true,
        status: 200,
        json: async () => ({ config: startupConfig, capabilities: startupCapabilities }),
      }
    }
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
function mountComposer(initialDraft, attachmentIds = []) {
  const slot = componentSlot()
  const state = { draft: initialDraft, attachmentIds: attachmentIds, writes: [] }
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
  const ctx = { get: (name) => name === 'slots' ? slots : name === 'conversation' ? globalThis.__conversation : undefined }
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

/** Open the toolbar radio picker and wait for its startup config load. */
async function openPicker(renderer) {
  await renderer.settle()
  find(renderer.tree(), 'dsh-po-choice').props.onClick()
  return renderer.settle()
}

/** The radio inputs currently rendered inside the picker popover. */
function pickerRadios(tree) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'input' && node.props?.type === 'radio') found.push(node)
  })
  return found
}

test('composer: idle button renders the sparkle and announces the action', () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  const tree = renderer.render()
  const btn = composerButton(tree)
  assert.equal(btn.props.disabled, false)
  assert.equal(btn.props.title, '优化提示词')
  const spark = find(btn, 'dsh-po-spark')
  assert.ok(spark, 'the idle icon is rendered')
  assert.equal(spark.type, 'svg', 'the icon is a vector glyph, not an emoji text node')
  assert.equal(textOf(btn).trim(), '', 'no visible text is rendered inside the button')
})

test('composer: the busy state keeps the same sparkle and only animates it', () => {
  stubFetch()
  responses.push(() => new Promise(() => {}))
  const { renderer } = mountComposer('hello')
  renderer.render()
  const idleSpark = find(composerButton(renderer.tree()), 'dsh-po-spark')
  composerButton(renderer.tree()).props.onClick()
  renderer.render()
  const btn = composerButton(renderer.tree())
  assert.match(btn.props.className, /dsh-po-busy/)
  assert.equal(btn.props.title, '正在优化提示词…')
  const busySpark = find(btn, 'dsh-po-spark')
  assert.ok(busySpark, 'the same icon keeps rendering while loading')
  assert.deepEqual(busySpark.props, idleSpark.props, 'the icon markup is identical — only the button class changes')
  assert.equal(find(renderer.tree(), 'dsh-po-progress'), undefined, 'the underscore/progress bar animation is gone')
  assert.equal(find(renderer.tree(), 'dsh-po-glyph') !== undefined, true, 'the icon sits in the animated wrapper')
  // 加载态不产生任何额外可见文字：按钮里只有图标。
  assert.equal(textOf(btn).trim(), '', 'no "正在优化…" style label is added to the button')
})

test('composer: the stylesheet no longer defines the progress animation', () => {
  const css = dom.styleTags.map((tag) => tag.textContent).join(String.fromCharCode(10))
  assert.doesNotMatch(css, /dsh-po-progress/)
  assert.doesNotMatch(css, /dsh-po-slide/)
  assert.doesNotMatch(css, /dsh-po-spinner/, 'the separate spinner icon is gone')
  assert.doesNotMatch(css, /dsh-po-spin{/, 'the rotation keyframes are gone with it')
  assert.match(css, /dsh-po-breathe/, 'the busy state animates the sparkle itself')
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
  assert.equal(find(btn, 'dsh-po-spark'), undefined, 'the icon is no longer the sparkle')

  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.deepEqual(state.writes, ['polished prompt', 'rough prompt'], 'undo restores the pre-click text')
  assert.equal(state.draft, 'rough prompt')
  assert.doesNotMatch(composerButton(renderer.tree()).props.className, /dsh-po-undo/)
  assert.equal(composerButton(renderer.tree()).props.title, '优化提示词')
  assert.ok(find(composerButton(renderer.tree()), 'dsh-po-spark'), 'undo returns the sparkle icon')
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
  assert.equal(requests.filter((r) => r.url === '/api/prompt-optimizer').length, 0)
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
    assert.ok(find(btn, 'dsh-po-spark'), 'the sparkle icon is back')
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

/**
 * Mount the settings section against the stubbed config endpoint.
 * @param config - the saved prompt document.
 * @param builtin - optional built-in prompt row.
 * @param capabilities - optional model capabilities; omitted means a text-only model.
 */
function mountSettings(config, builtin, capabilities) {
  const Section = componentSlot('settings.section')
  const renderer = createRenderer((props) => Section(props))
  renderer.setProps({})
  responses.push({
    status: 200,
    body: {
      config,
      builtin: builtin ?? { id: '', name: '默认', instruction: 'BUILTIN-INSTRUCTION' },
      ...(capabilities === undefined ? {} : { capabilities }),
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
  assert.deepEqual(names, ['默认', '简洁版', '工程版'])
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
    body: { config: { defaultId: 'p1', prompts: [{ id: 'p1', name: '新名', instruction: 'NEW TEXT', useImages: false }] } },
  })
  click(renderer.tree(), '保存')
  await renderer.settle()

  const post = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.deepEqual(post.config.prompts, [{ id: 'p1', name: '新名', instruction: 'NEW TEXT', useImages: false }])
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

// ------------------------------------------------------------- 图片输入（可选）

/** A tiny base64 payload standing in for image bytes. */
const IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Install a FileReader stub that reports a data URL for the given media type. */
function stubFileReader(mediaType = 'image/png') {
  globalThis.FileReader = class {
    readAsDataURL() {
      this.result = 'data:' + mediaType + ';base64,' + IMAGE_BASE64
      setTimeout(() => { this.onload() }, 0)
    }
  }
}

/** Open the test tab and fill the input, ready to run. */
async function prepareTest(renderer, config = { defaultId: '', prompts: [] }) {
  click(renderer.tree(), '测试')
  await renderer.settle()
  control(renderer.tree(), 'dsh-po-test-input').props.onChange({ target: { value: 'draft' } })
  await renderer.settle()
}

/** Tick the "use images" checkbox, revealing the file picker. */
async function enableImageInput(renderer) {
  const box = findAll(renderer.tree(), 'dsh-po-check')
    .map((label) => label.props.children)
    .flat()
    .find((child) => child && child.type === 'input')
  assert.ok(box, 'the image checkbox is present')
  box.props.onChange({ target: { checked: true } })
  await renderer.settle()
}

test('settings: a text-only model never renders the image affordance', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: false })
  await renderer.settle()
  await prepareTest(renderer)
  assert.equal(find(renderer.tree(), 'dsh-po-file'), undefined, 'no image entry point is shown')
  assert.equal(textOf(renderer.tree()).includes('参考图片'), false)
})

test('settings: a missing capabilities field reads as unsupported', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  await prepareTest(renderer)
  assert.equal(find(renderer.tree(), 'dsh-po-file'), undefined)
})

test('settings: an image-capable model shows the optional image control', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()
  await prepareTest(renderer)
  assert.ok(find(renderer.tree(), 'dsh-po-check'), 'the image checkbox appears')
  assert.equal(find(renderer.tree(), 'dsh-po-file'), undefined, 'the picker waits for the opt-in')
  await enableImageInput(renderer)
  assert.ok(find(renderer.tree(), 'dsh-po-file'), 'the add-image control appears after opting in')
  const input = findAll(renderer.tree(), 'dsh-po-file-input')[0]
  assert.equal(input.props.type, 'file')
  assert.equal(input.props.accept, 'image/png,image/jpeg,image/webp,image/gif')
})

test('settings: without choosing an image the request body stays text-only', async () => {
  stubFetch()
  stubFileReader()
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()
  await prepareTest(renderer)

  responses.push({ status: 200, body: { optimized: 'ok' } })
  click(renderer.tree(), '开始测试')
  await renderer.settle()

  const sent = JSON.parse(requests.find((r) => r.url === '/api/prompt-optimizer/test').body)
  assert.equal('image' in sent, false, 'no image field when the user did not attach one')
  assert.equal(sent.input, 'draft')
})

test('settings: choosing an image previews it and includes it in the request', async () => {
  stubFetch()
  stubFileReader('image/png')
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()
  await prepareTest(renderer)
  await enableImageInput(renderer)

  const input = findAll(renderer.tree(), 'dsh-po-file-input')[0]
  input.props.onChange({ target: { files: [{ type: 'image/png', name: 'shot.png' }], value: 'x' } })
  await renderer.settle()

  const thumb = find(renderer.tree(), 'dsh-po-thumb')
  assert.ok(thumb, 'a thumbnail preview is rendered')
  assert.match(thumb.props.src, /^data:image\/png;base64,/)
  assert.ok(textOf(renderer.tree()).includes('shot.png'))

  responses.push({ status: 200, body: { optimized: 'described' } })
  click(renderer.tree(), '开始测试')
  await renderer.settle()

  const sent = JSON.parse(requests.find((r) => r.url === '/api/prompt-optimizer/test').body)
  assert.equal(sent.image.mediaType, 'image/png')
  assert.equal(sent.image.name, 'shot.png')
  assert.equal(sent.image.data, IMAGE_BASE64, 'only the base64 body is sent, not the data URL prefix')
})

test('settings: removing the image returns to the plain text flow', async () => {
  stubFetch()
  stubFileReader()
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()
  await prepareTest(renderer)
  await enableImageInput(renderer)

  findAll(renderer.tree(), 'dsh-po-file-input')[0].props.onChange({
    target: { files: [{ type: 'image/png', name: 'shot.png' }], value: 'x' },
  })
  await renderer.settle()
  click(renderer.tree(), '移除')
  await renderer.settle()
  assert.equal(find(renderer.tree(), 'dsh-po-thumb'), undefined, 'the preview is gone')

  responses.push({ status: 200, body: { optimized: 'ok' } })
  click(renderer.tree(), '开始测试')
  await renderer.settle()
  const sent = JSON.parse(requests.find((r) => r.url === '/api/prompt-optimizer/test').body)
  assert.equal('image' in sent, false)
})

test('settings: a non-image file is refused locally without any request', async () => {
  stubFetch()
  stubFileReader('application/pdf')
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()
  await prepareTest(renderer)
  await enableImageInput(renderer)

  findAll(renderer.tree(), 'dsh-po-file-input')[0].props.onChange({
    target: { files: [{ type: 'application/pdf', name: 'doc.pdf' }], value: 'x' },
  })
  await renderer.settle()

  assert.ok(textOf(renderer.tree()).includes('仅支持 PNG'))
  assert.equal(find(renderer.tree(), 'dsh-po-thumb'), undefined)
  assert.equal(requests.filter((r) => r.method === 'POST').length, 0, 'nothing is sent')
})

// ------------------------------------------- 每条提示词的「允许图片输入」参数

/** A stand-in for the host Conversation service that owns pasted draft images. */
function stubConversation(images) {
  const calls = []
  globalThis.__conversation = {
    resolveDraftAttachments(ids) {
      calls.push(ids)
      return images
    },
  }
  return calls
}

test('composer: pasted images are forwarded only when the default prompt opts in', async () => {
  stubFetch()
  stubFileReader()
  stubConversation([{ kind: 'image', id: 'a1', file: { type: 'image/png', name: 'pasted.png' } }])
  responses.push({ status: 200, body: { optimized: 'optimized!' } })

  const { renderer } = mountComposer('look at this')
  renderer.render()
  // The startup sync answers text-only by default, so no images are attached.
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()

  const body = JSON.parse(requests.find((r) => r.url === '/api/prompt-optimizer').body)
  assert.deepEqual(body, { text: 'look at this' }, 'a prompt without the opt-in sends text only')
})

test('composer: a failing conversation service degrades to text without throwing', async () => {
  stubFetch()
  stubFileReader()
  globalThis.__conversation = {
    resolveDraftAttachments() { throw new Error('no such attachment') },
  }
  responses.push({ status: 200, body: { optimized: 'ok' } })

  const { renderer } = mountComposer('draft')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()

  const body = JSON.parse(requests.find((r) => r.url === '/api/prompt-optimizer').body)
  assert.deepEqual(body, { text: 'draft' })
})

test('settings: each prompt carries its own "allow images" flag through save', async () => {
  stubFetch()
  stubFileReader()
  const renderer = mountSettings({ defaultId: '', prompts: [] }, undefined, { image: true })
  await renderer.settle()

  click(renderer.tree(), '新增提示词')
  await renderer.settle()
  control(renderer.tree(), 'dsh-po-name-input').props.onChange({ target: { value: '带图版' } })
  control(renderer.tree(), 'dsh-po-instruction-input').props.onChange({ target: { value: 'USE IMAGES' } })
  await renderer.settle()

  // Tick the per-prompt image switch inside the editor.
  const boxes = []
  walk(renderer.tree(), (node) => {
    if (node.type === 'label' && String(node.props?.className ?? '').includes('dsh-po-check')) boxes.push(node)
  })
  assert.ok(boxes.length > 0, 'the editor shows an image switch')
  const checkbox = boxes[0].props.children[1] ?? boxes[0].props.children[0]
  const input = [].concat(boxes[0].props.children).find((c) => c && c.type === 'input')
  assert.ok(input, 'the switch is a checkbox')
  input.props.onChange({ target: { checked: true } })
  await renderer.settle()

  responses.push({
    status: 200,
    body: { config: { defaultId: '', prompts: [{ id: 'x', name: '带图版', instruction: 'USE IMAGES', useImages: true }] } },
  })
  click(renderer.tree(), '保存')
  await renderer.settle()

  const post = JSON.parse(requests.find((r) => r.method === 'POST').body)
  assert.equal(post.config.prompts[0].useImages, true, 'the per-prompt flag is persisted')
})

test('settings: a prompt with the flag shows a marker on its card', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: '',
    prompts: [
      { id: 'p1', name: '带图', instruction: 'A', useImages: true },
      { id: 'p2', name: '纯文本', instruction: 'B', useImages: false },
    ],
  }, undefined, { image: true })
  await renderer.settle()

  const cards = findAll(renderer.tree(), 'dsh-po-card')
  assert.ok(textOf(cards[1]).includes('含图片'), 'the opted-in prompt is marked')
  assert.equal(textOf(cards[2]).includes('含图片'), false, 'the text-only prompt is not marked')
})

// ------------------------------------------------------- 优化提示词单选

test('picker: the menu stays compact like the host menus', async () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)
  const tree = renderer.tree()
  assert.equal(find(tree, 'dsh-po-popover-head'), undefined, 'no oversized title/description header')
  assert.equal(find(tree, 'dsh-po-popover-foot'), undefined, 'no long footer copy')
  assert.equal(findAll(tree, 'dsh-po-option-line').length, 0, 'rows are a single compact line')
  const option = find(tree, 'dsh-po-option')
  assert.ok(option, 'an option row exists')
  assert.equal(findAll(tree, 'dsh-po-switch').length, 1, 'each row keeps its image switch')
  const selected = find(tree, 'dsh-po-option-selected')
  assert.ok(selected, 'the active row is still marked')
  assert.equal(textOf(selected).includes('图片'), false, 'no image caption on the selected row')
})

test('picker: the toolbar trigger sits beside the sparkle and keeps the 28px row', async () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  await renderer.settle()
  const controls = find(renderer.tree(), 'dsh-po-composer-controls')
  assert.ok(controls, 'a compact control wrapper is rendered')
  assert.equal(controls.props.children.length, 2, 'sparkle + radio trigger only')
  const trigger = find(renderer.tree(), 'dsh-po-choice')
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.match(trigger.props.title, /优化提示词选项：默认（不支持图片输入）/)
})

test('picker: opening shows one radio per prompt, with the default checked', async () => {
  stubFetch()
  startupConfig = {
    defaultId: 'p2',
    prompts: [
      { id: 'p1', name: '简洁版', instruction: 'SHORT', useImages: false },
      { id: 'p2', name: '带图版', instruction: 'IMAGES', useImages: true },
    ],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  const radios = pickerRadios(renderer.tree())
  assert.equal(radios.length, 3, 'built-in + two custom prompts')
  assert.deepEqual(radios.map((radio) => radio.props.value), ['', 'p1', 'p2'])
  assert.deepEqual(radios.map((radio) => radio.props.checked), [false, false, true],
    'the saved default is the selected radio')
  assert.equal(find(renderer.tree(), 'dsh-po-option-selected') !== undefined, true)
})

/** Every per-option image switch in the popover. */
function pickerSwitches(tree) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'input' && node.props?.role === 'switch') found.push(node)
  })
  return found
}

test('picker: every option owns an interactive image switch', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [
      { id: 'p1', name: '纯文本', instruction: 'TEXT', useImages: false },
      { id: 'p2', name: '带图', instruction: 'IMAGES', useImages: true },
    ],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  const switches = pickerSwitches(renderer.tree())
  assert.equal(switches.length, 3, 'one switch per row, including built-in')
  assert.deepEqual(switches.map((node) => node.props.checked), [false, false, true])
  assert.deepEqual(switches.map((node) => node.props['aria-label']), [
    '默认：允许图片输入', '纯文本：允许图片输入', '带图：允许图片输入',
  ])
  assert.equal(find(renderer.tree(), 'dsh-po-option-media'), undefined,
    'the redundant "图片" caption is gone; the switch is the affordance')
  assert.equal(textOf(renderer.tree()).includes('图片'), false)
})

test('picker: an image opt-in on a text-only model keeps the switch but says it is inactive', async () => {
  stubFetch()
  startupConfig = {
    defaultId: 'p1',
    prompts: [{ id: 'p1', name: '带图', instruction: 'IMAGES', useImages: true }],
  }
  startupCapabilities = { image: false }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)
  const switches = pickerSwitches(renderer.tree())
  assert.equal(switches.length, 2)
  assert.deepEqual(switches.map((node) => node.props.checked), [false, true],
    'the saved preference survives even when the model cannot use it')
  assert.equal(find(renderer.tree(), 'dsh-po-option-media'), undefined,
    'no extra caption is rendered even when the model cannot use images')
  assert.equal(pickerSwitches(renderer.tree())[1].props.disabled, false,
    'the saved switch stays operable; only the actual request is gated')
  assert.match(find(renderer.tree(), 'dsh-po-choice').props.title, /暂不支持/)
})

test('picker: toggling one row saves that prompt image flag and keeps the selected radio', async () => {
  stubFetch()
  startupConfig = {
    defaultId: 'p1',
    prompts: [
      { id: 'p1', name: '纯文本', instruction: 'TEXT', useImages: false },
      { id: 'p2', name: '带图', instruction: 'IMAGES', useImages: false },
    ],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  const nextPrompts = [
    { id: 'p1', name: '纯文本', instruction: 'TEXT', useImages: false },
    { id: 'p2', name: '带图', instruction: 'IMAGES', useImages: true },
  ]
  responses.push({
    status: 200,
    body: { config: { defaultId: 'p1', prompts: nextPrompts }, capabilities: { image: true } },
  })
  pickerSwitches(renderer.tree())[2].props.onChange({ target: { checked: true } })
  await renderer.settle()

  const sent = JSON.parse(requests.find((request) => request.method === 'POST').body).config
  assert.equal(sent.prompts[1].useImages, true, 'the second row was switched on')
  assert.equal(sent.prompts[0].useImages, false, 'the other row is untouched')
  assert.equal(sent.defaultId, 'p1', 'toggling images does not change the selected prompt')
  assert.equal(find(renderer.tree(), 'dsh-po-popover') !== undefined, true, 'the menu stays open for more toggles')
})

test('picker: the built-in row switch persists builtinUseImages', async () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  responses.push({
    status: 200,
    body: {
      config: { defaultId: '', builtinUseImages: true, prompts: [] },
      capabilities: { image: true },
    },
  })
  pickerSwitches(renderer.tree())[0].props.onChange({ target: { checked: true } })
  await renderer.settle()

  const sent = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.equal(sent.config.builtinUseImages, true)
  assert.equal(pickerSwitches(renderer.tree())[0].props.checked, true)
})

test('picker: a failed switch save rolls back and reports the error', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [{ id: 'p1', name: '纯文本', instruction: 'TEXT', useImages: false }],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  responses.push({ status: 400, body: { error: '配置写入失败' } })
  pickerSwitches(renderer.tree())[1].props.onChange({ target: { checked: true } })
  await renderer.settle()

  assert.equal(pickerSwitches(renderer.tree())[1].props.checked, false, 'the switch rolls back')
  assert.ok(textOf(renderer.tree()).includes('保存失败：配置写入失败'))
})

test('picker: choosing another preset persists defaultId and checks that radio', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [
      { id: 'p1', name: '简洁版', instruction: 'SHORT', useImages: false },
      { id: 'p2', name: '带图版', instruction: 'IMAGES', useImages: true },
    ],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  responses.push({
    status: 200,
    body: {
      config: { defaultId: 'p2', prompts: startupConfig.prompts },
      capabilities: { image: true },
    },
  })
  pickerRadios(renderer.tree())[2].props.onChange()
  await renderer.settle()

  const post = requests.find((request) => request.method === 'POST')
  assert.equal(post.url, '/api/prompt-optimizer/config')
  assert.equal(JSON.parse(post.body).config.defaultId, 'p2')
  assert.equal(find(renderer.tree(), 'dsh-po-popover'), undefined, 'the menu closes after saving')
  assert.match(find(renderer.tree(), 'dsh-po-choice').props.title, /带图版（支持图片输入）/)

  await openPicker(renderer)
  assert.deepEqual(pickerRadios(renderer.tree()).map((radio) => radio.props.checked), [false, false, true])
})

test('picker: a failed save rolls the radio back and shows the reason', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [{ id: 'p1', name: '简洁版', instruction: 'SHORT', useImages: false }],
  }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  responses.push({ status: 400, body: { error: '配置格式无效' } })
  pickerRadios(renderer.tree())[1].props.onChange()
  await renderer.settle()

  assert.match(find(renderer.tree(), 'dsh-po-choice').props.title, /默认/)
  assert.ok(textOf(renderer.tree()).includes('保存失败：配置格式无效'))
  const radios = pickerRadios(renderer.tree())
  assert.deepEqual(radios.map((radio) => radio.props.checked), [true, false])
})

test('picker: escape closes the menu without changing the selection', async () => {
  stubFetch()
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)
  const popover = find(renderer.tree(), 'dsh-po-popover')
  popover.props.onKeyDown({ key: 'Escape', preventDefault() {} })
  await renderer.settle()
  assert.equal(find(renderer.tree(), 'dsh-po-popover'), undefined)
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0)
})

test('picker: the selected option controls whether the sparkle forwards images', async () => {
  stubFetch()
  stubFileReader()
  startupConfig = {
    defaultId: 'p1',
    prompts: [
      { id: 'p1', name: '纯文本', instruction: 'TEXT', useImages: false },
      { id: 'p2', name: '带图', instruction: 'IMAGES', useImages: true },
    ],
  }
  startupCapabilities = { image: true }
  const conversationCalls = stubConversation([
    { kind: 'image', id: 'a1', file: { type: 'image/png', name: 'pasted.png' } },
  ])
  const { renderer, state } = mountComposer('look at this', ['a1'])
  await renderer.settle()

  responses.push({ status: 200, body: { optimized: 'first' } })
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  let body = JSON.parse(requests.find((request) => request.url === '/api/prompt-optimizer').body)
  assert.deepEqual(body, { text: 'look at this' }, 'the text-only prompt forwards no image')

  // Leave the undo state by editing the draft, then optimize again after switching.
  state.draft = 'second draft'
  renderer.setProps({})
  await renderer.settle()

  await openPicker(renderer)
  responses.push({
    status: 200,
    body: {
      config: { defaultId: 'p2', prompts: startupConfig.prompts },
      capabilities: { image: true },
    },
  })
  pickerRadios(renderer.tree())[2].props.onChange()
  await renderer.settle()

  responses.push({ status: 200, body: { optimized: 'second' } })
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  body = JSON.parse(requests.filter((request) => request.url === '/api/prompt-optimizer').at(-1).body)
  assert.equal(body.text, 'second draft')
  assert.equal(body.image[0].data, IMAGE_BASE64)
  assert.equal(body.image[0].mediaType, 'image/png')
  assert.ok(conversationCalls.length > 0, 'the conversation service was consulted after opting in')
})

test('picker: the trigger title follows the selected prompt', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [{ id: 'p1', name: '工程严谨版', instruction: 'STRICT' }],
  }
  const { renderer } = mountComposer('hello')
  await renderer.settle()

  const idle = find(renderer.tree(), 'dsh-po-choice')
  const idleText = textOf(idle).trim()
  assert.ok(idleText.includes('默认'), 'the initial title is the selected built-in prompt')
  assert.equal(find(renderer.tree(), 'dsh-po-choice-title').props.title, '默认')

  await openPicker(renderer)
  responses.push({
    status: 200,
    body: { config: { ...startupConfig, defaultId: 'p1' }, capabilities: { image: false } },
  })
  pickerRadios(renderer.tree())[1].props.onChange()
  await renderer.settle()

  const chosen = find(renderer.tree(), 'dsh-po-choice')
  assert.ok(textOf(chosen).includes('工程严谨版'), 'the trigger shows the newly selected title')
  assert.equal(find(renderer.tree(), 'dsh-po-choice-title').props.title, '工程严谨版')
  assert.equal(textOf(chosen).includes('默认'), false)
})

test('picker: toggling images on the active prompt changes the next sparkle request', async () => {
  stubFetch()
  stubFileReader()
  startupConfig = {
    defaultId: 'p1',
    prompts: [{ id: 'p1', name: '工程版', instruction: 'IMAGES', useImages: false }],
  }
  startupCapabilities = { image: true }
  stubConversation([{ kind: 'image', id: 'a1', file: { type: 'image/png', name: 'pasted.png' } }])
  const { renderer, state } = mountComposer('look at this', ['a1'])
  await renderer.settle()

  responses.push({ status: 200, body: { optimized: 'first' } })
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  let body = JSON.parse(requests.find((request) => request.url === '/api/prompt-optimizer').body)
  assert.deepEqual(body, { text: 'look at this' }, 'switch off means text only')

  state.draft = 'second draft'
  renderer.setProps({})
  await renderer.settle()

  await openPicker(renderer)
  responses.push({
    status: 200,
    body: {
      config: { defaultId: 'p1', prompts: [{ ...startupConfig.prompts[0], useImages: true }] },
      capabilities: { image: true },
    },
  })
  pickerSwitches(renderer.tree())[1].props.onChange({ target: { checked: true } })
  await renderer.settle()
  assert.match(find(renderer.tree(), 'dsh-po-choice').props.title, /支持图片输入/)

  responses.push({ status: 200, body: { optimized: 'second' } })
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  body = JSON.parse(requests.filter((request) => request.url === '/api/prompt-optimizer').at(-1).body)
  assert.equal(body.image[0].data, IMAGE_BASE64, 'the new switch value is effective immediately')
})

test('picker: clicking anywhere on an option row selects that prompt', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [{ id: 'p1', name: '工程版', instruction: 'STRICT' }],
  }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  responses.push({
    status: 200,
    body: {
      config: { ...startupConfig, defaultId: 'p1' },
      capabilities: { image: false },
    },
  })
  const rows = findAll(renderer.tree(), 'dsh-po-option')
  rows[1].props.onClick()
  await renderer.settle()

  const sent = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.equal(sent.config.defaultId, 'p1', 'the row itself selects the prompt')
  assert.match(find(renderer.tree(), 'dsh-po-choice').props.title, /工程版/)
})

test('picker: saving a switch does not add or remove menu rows', async () => {
  stubFetch()
  startupConfig = {
    defaultId: '',
    prompts: [
      { id: 'p1', name: '一', instruction: 'ONE', useImages: false },
      { id: 'p2', name: '二', instruction: 'TWO', useImages: false },
    ],
  }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  const before = find(renderer.tree(), 'dsh-po-popover')
  const rowsBefore = findAll(renderer.tree(), 'dsh-po-option').length
  responses.push(() => new Promise(() => {}))
  pickerSwitches(renderer.tree())[1].props.onChange({ target: { checked: true } })
  await renderer.settle()

  const after = find(renderer.tree(), 'dsh-po-popover')
  assert.equal(findAll(renderer.tree(), 'dsh-po-option').length, rowsBefore,
    'no transient row appears while the switch is saving')
  assert.equal(find(renderer.tree(), 'dsh-po-popover-note'), undefined,
    'the saving note that changed the menu height is gone')
  assert.equal(after.props.children.length, before.props.children.length,
    'the popover keeps the same structural height')
  assert.equal(pickerSwitches(renderer.tree())[1].props.disabled, true,
    'the switch still shows its busy state without resizing the menu')
})

// ------------------------------------------------- 状态反馈与可访问性（UI 优化）

test('composer: a failed call explains itself next to the button, then gets out of the way', async () => {
  stubFetch()
  responses.push({ status: 502, body: { error: 'model produced no output' } })
  const original = console.error
  console.error = () => {}
  try {
    const { renderer } = mountComposer('rough')
    renderer.render()
    composerButton(renderer.tree()).props.onClick()
    await renderer.settle()

    const toast = find(renderer.tree(), 'dsh-po-toast')
    assert.ok(toast, 'a visible notice replaces the silent console-only failure')
    assert.equal(toast.props.role, 'alert', 'the failure is announced to assistive tech')
    assert.ok(textOf(toast).includes('优化失败：model produced no output'))
    const btn = composerButton(renderer.tree())
    assert.match(btn.props.className, /dsh-po-failed/, 'the icon briefly takes the error tint')
    assert.equal(btn.props['aria-describedby'], 'dsh-po-run-notice', 'the button points at its notice')
    assert.equal(textOf(btn).trim(), '', 'the button itself still carries no text')

    // The next attempt clears the stale notice before anything else happens.
    responses.push({ status: 200, body: { optimized: 'better' } })
    composerButton(renderer.tree()).props.onClick()
    await renderer.settle()
    assert.equal(find(renderer.tree(), 'dsh-po-toast'), undefined)
    assert.doesNotMatch(composerButton(renderer.tree()).props.className, /dsh-po-failed/)
  } finally {
    console.error = original
  }
})

test('composer: an unchanged result says so instead of looking like nothing happened', async () => {
  stubFetch()
  responses.push({ status: 200, body: { optimized: 'same text' } })
  const { renderer } = mountComposer('same text')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  const toast = find(renderer.tree(), 'dsh-po-toast')
  assert.ok(toast)
  assert.equal(toast.props.role, 'status', 'a neutral outcome is polite, not an alert')
  assert.match(toast.props.className, /dsh-po-toast-info/)
})

test('composer: busy, success and undo are announced through a polite live region', async () => {
  stubFetch()
  let release
  responses.push(() => new Promise((resolve) => { release = resolve }))
  const { renderer } = mountComposer('rough')
  renderer.render()
  composerButton(renderer.tree()).props.onClick()
  renderer.render()
  const live = () => find(renderer.tree(), 'dsh-po-sr')
  assert.equal(live().props['aria-live'], 'polite')
  assert.equal(textOf(live()), '正在优化提示词…')
  assert.equal(composerButton(renderer.tree()).props['aria-busy'], true)

  release({ status: 200, body: { optimized: 'polished' } })
  await renderer.settle()
  assert.equal(textOf(live()), '提示词已优化，再次点击可撤销')
  composerButton(renderer.tree()).props.onClick()
  await renderer.settle()
  assert.equal(textOf(live()), '已恢复原始提示词')
})

test('settings: the first load shows card-shaped skeletons, not a bare line of text', async () => {
  stubFetch()
  const Section = componentSlot('settings.section')
  const renderer = createRenderer((props) => Section(props))
  responses.push(() => new Promise(() => {}))
  await renderer.settle()
  const skeleton = find(renderer.tree(), 'dsh-po-skeleton-list')
  assert.ok(skeleton, 'a skeleton list is rendered while loading')
  assert.equal(skeleton.props.role, 'status')
  assert.equal(findAll(renderer.tree(), 'dsh-po-skeleton').length, 3)
  assert.ok(textOf(renderer.tree()).includes('正在加载配置…'), 'screen readers still hear the loading state')
})

test('settings: a failed load renders an alert block with a retry action', async () => {
  stubFetch()
  const Section = componentSlot('settings.section')
  const renderer = createRenderer((props) => Section(props))
  responses.push({ status: 500, body: { error: 'disk unavailable' } })
  await renderer.settle()
  const alert = find(renderer.tree(), 'dsh-po-alert')
  assert.ok(alert)
  assert.equal(alert.props.role, 'alert')
  assert.ok(textOf(alert).includes('disk unavailable'))

  responses.push({ status: 200, body: { config: { defaultId: '', prompts: [] } } })
  click(renderer.tree(), '重试')
  await renderer.settle()
  assert.equal(find(renderer.tree(), 'dsh-po-alert'), undefined, 'retry recovers')
  assert.ok(find(renderer.tree(), 'dsh-po-card'), 'the list renders after a successful retry')
})

test('settings: tabs follow the WAI-ARIA tabs pattern, including arrow keys', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  const tabs = () => findAll(renderer.tree(), 'dsh-po-tab')
  assert.deepEqual(tabs().map((tab) => tab.props.tabIndex), [0, -1], 'roving tabindex')
  assert.deepEqual(tabs().map((tab) => tab.props['aria-controls']), ['dsh-po-tabpanel', 'dsh-po-tabpanel'])
  const panel = find(renderer.tree(), 'dsh-po-panel')
  assert.equal(panel.props.role, 'tabpanel')
  assert.equal(panel.props['aria-labelledby'], 'dsh-po-tab-prompts')

  tabs()[0].props.onKeyDown({ key: 'ArrowRight', preventDefault() {} })
  await renderer.settle()
  assert.deepEqual(tabs().map((tab) => tab.props['aria-selected']), [false, true])
  assert.ok(control(renderer.tree(), 'dsh-po-test-input'), 'the test panel is shown')
  tabs()[1].props.onKeyDown({ key: 'Home', preventDefault() {} })
  await renderer.settle()
  assert.deepEqual(tabs().map((tab) => tab.props['aria-selected']), [true, false])
})

test('settings: save feedback appears in the tab bar status region', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [{ id: 'p1', name: '一', instruction: 'ONE' }] })
  await renderer.settle()
  let release
  responses.push(() => new Promise((resolve) => { release = resolve }))
  findAll(renderer.tree(), 'dsh-po-action').filter((node) => textOf(node).trim() === '设为默认')[0].props.onClick()
  await renderer.settle()
  const status = () => find(renderer.tree(), 'dsh-po-status')
  assert.equal(status().props.role, 'status')
  assert.ok(textOf(status()).includes('保存中…'))
  release({ status: 200, body: { config: { defaultId: 'p1', prompts: [{ id: 'p1', name: '一', instruction: 'ONE' }] } } })
  await renderer.settle()
  assert.ok(textOf(status()).includes('已保存'))
})

test('settings: only one primary button competes for attention on the prompts tab', async () => {
  stubFetch()
  const renderer = mountSettings({
    defaultId: '',
    prompts: [{ id: 'p1', name: '一', instruction: 'ONE' }, { id: 'p2', name: '二', instruction: 'TWO' }],
  })
  await renderer.settle()
  const primaries = findAll(renderer.tree(), 'dsh-po-primary').map((node) => textOf(node).trim())
  assert.deepEqual(primaries, ['新增提示词'], '"设为默认" is a secondary action on each card')
})

test('settings: the delete confirmation can be cancelled', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [{ id: 'p1', name: '一', instruction: 'ONE' }] })
  await renderer.settle()
  click(renderer.tree(), '删除')
  await renderer.settle()
  const confirm = button(renderer.tree(), '确认删除')
  assert.match(confirm.props.className, /dsh-po-confirm/)
  assert.equal(confirm.props['aria-label'], '确认删除「一」')
  click(renderer.tree(), '取消')
  await renderer.settle()
  assert.equal(button(renderer.tree(), '确认删除'), undefined)
  assert.ok(button(renderer.tree(), '删除'))
  assert.equal(requests.filter((request) => request.method === 'POST').length, 0)
})

test('settings: the editor supports Esc to cancel and Cmd/Ctrl+Enter to save', async () => {
  stubFetch()
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  click(renderer.tree(), '新增提示词')
  await renderer.settle()
  const editor = () => findAll(renderer.tree(), 'dsh-po-card-editing')[0]
  assert.equal(control(renderer.tree(), 'dsh-po-name-input').props.autoFocus, true)
  editor().props.onKeyDown({ key: 'Escape', preventDefault() {} })
  await renderer.settle()
  assert.equal(editor(), undefined, 'Esc closes the editor')

  click(renderer.tree(), '新增提示词')
  await renderer.settle()
  editor().props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault() {} })
  await renderer.settle()
  assert.equal(control(renderer.tree(), 'dsh-po-name-input').props['aria-invalid'], true, 'the empty name is flagged on the field')
  control(renderer.tree(), 'dsh-po-name-input').props.onChange({ target: { value: '快捷' } })
  control(renderer.tree(), 'dsh-po-instruction-input').props.onChange({ target: { value: 'FAST' } })
  await renderer.settle()
  responses.push({ status: 200, body: { config: { defaultId: '', prompts: [{ id: 'p9', name: '快捷', instruction: 'FAST' }] } } })
  editor().props.onKeyDown({ key: 'Enter', metaKey: true, preventDefault() {} })
  await renderer.settle()
  const post = JSON.parse(requests.find((request) => request.method === 'POST').body)
  assert.equal(post.config.prompts[0].name, '快捷')
})

test('settings: running a test shows a skeleton in place and copying confirms itself', async () => {
  stubFetch()
  const writes = []
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text) => { writes.push(text) } } },
  })
  const renderer = mountSettings({ defaultId: '', prompts: [] })
  await renderer.settle()
  await prepareTest(renderer)
  let release
  responses.push(() => new Promise((resolve) => { release = resolve }))
  click(renderer.tree(), '开始测试')
  await renderer.settle()
  assert.ok(find(renderer.tree(), 'dsh-po-preview-skeleton'), 'the result area shows a skeleton while running')
  assert.equal(button(renderer.tree(), '测试中…').props['aria-busy'], true)

  release({ status: 200, body: { optimized: 'RESULT' } })
  await renderer.settle()
  assert.equal(find(renderer.tree(), 'dsh-po-preview-skeleton'), undefined)
  click(renderer.tree(), '复制')
  await renderer.settle()
  assert.deepEqual(writes, ['RESULT'])
  assert.ok(button(renderer.tree(), '已复制'), 'the copy button confirms the copy')
  if (previous) Object.defineProperty(globalThis, 'navigator', previous)
})

test('picker: pointer-driven focus loss never closes the menu under the cursor', async () => {
  stubFetch()
  startupConfig = { defaultId: '', prompts: [] }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)
  const popover = () => find(renderer.tree(), 'dsh-po-popover')
  const textarea = { tagName: 'TEXTAREA' }
  // The host composer steals focus on mousedown: the popover must stay mounted
  // so the following click still reaches the switch.
  let prevented = false
  popover().props.onMouseDown({ stopPropagation() {}, preventDefault() { prevented = true } })
  assert.equal(prevented, true, 'mousedown inside the menu keeps focus in place')
  popover().props.onBlur({ relatedTarget: textarea })
  await renderer.settle()
  assert.ok(popover(), 'a non-keyboard blur leaves the menu open')

  responses.push({ status: 200, body: { config: { defaultId: '', builtinUseImages: true, prompts: [] }, capabilities: { image: true } } })
  walk(renderer.tree(), (node) => { if (node.props?.role === 'switch') node.props.onChange({ target: { checked: true } }) })
  await renderer.settle()
  assert.equal(JSON.parse(requests.find((r) => r.method === 'POST').body).config.builtinUseImages, true, 'the switch click lands')
})

test('picker: tabbing out of the menu or clicking the backdrop closes it', async () => {
  stubFetch()
  startupConfig = { defaultId: '', prompts: [] }
  startupCapabilities = { image: true }
  const { renderer } = mountComposer('hello')
  await openPicker(renderer)

  const popover = () => find(renderer.tree(), 'dsh-po-popover')
  // Tabbing off the last control of a portalled menu hands focus to the browser UI,
  // so the blur has no relatedTarget — that is still "left the menu".
  popover().props.onKeyDown({ key: 'Tab' })
  popover().props.onBlur({ relatedTarget: null })
  await renderer.settle()
  assert.equal(popover(), undefined, 'the menu closes when Tab takes focus off the page')
  assert.equal(find(renderer.tree(), 'dsh-po-choice').props['aria-expanded'], false)

  // A pointer-driven blur must never count as leaving: the host composer steals
  // focus on mousedown, and unmounting there would eat the following click.
  await openPicker(renderer)
  popover().props.onBlur({ relatedTarget: { tagName: 'TEXTAREA' } })
  await renderer.settle()
  assert.ok(popover(), 'a pointer blur keeps the menu open')

  find(renderer.tree(), 'dsh-po-popover-backdrop').props.onClick()
  await renderer.settle()
  assert.equal(popover(), undefined, 'clicking the backdrop closes the menu')
  assert.equal(find(renderer.tree(), 'dsh-po-choice').props['aria-expanded'], false)
})

test('picker: with react-dom available the menu is portalled to <body> and isolates its events', async () => {
  stubFetch()
  const portals = []
  let registration
  const previousLoader = globalThis.window.__ModuleLoader__
  globalThis.window.__ModuleLoader__ = { load: (next) => { registration = next } }
  globalThis.document.body = { tagName: 'BODY' }
  await import(new URL('../lib/client.js', import.meta.url).href + '?portal=' + Math.random())
  globalThis.window.__ModuleLoader__ = previousLoader
  const { React } = await import('./support.mjs')
  const portalClient = registration.factory((specifier) => {
    if (specifier === 'react') return React
    if (specifier === 'react-dom') {
      return { createPortal: (child, container) => { portals.push(container); return child } }
    }
    throw new Error('unexpected module request: ' + specifier)
  })
  const registry = new Map()
  const slots = { inject: (key, callback) => callback(), register: (options, component) => { registry.set(options.name, component); return () => {} } }
  portalClient.apply({ get: (name) => name === 'slots' ? slots : undefined })
  const Composer = registry.get('conversation.input.left')
  const state = { draft: 'hello', attachmentIds: [] }
  const renderer = createRenderer((props) => Composer(props))
  renderer.setProps({ useInput: (select) => select(state), inputActions: { setDraft() {} } })
  await renderer.settle()
  // The harness never attaches real DOM nodes, so hand the trigger a measurable box
  // and the window a viewport: the panel must be placed from those numbers.
  const previousViewport = { width: globalThis.window.innerWidth, height: globalThis.window.innerHeight }
  globalThis.window.innerWidth = 900
  globalThis.window.innerHeight = 700
  find(renderer.tree(), 'dsh-po-choice').props.ref.current = {
    getBoundingClientRect: () => ({ left: 120, top: 500, bottom: 528 }),
  }
  find(renderer.tree(), 'dsh-po-choice').props.onClick()
  await renderer.settle()

  assert.deepEqual(portals, [globalThis.document.body], 'the menu is rendered into document.body')
  const anchored = find(renderer.tree(), 'dsh-po-popover')
  assert.deepEqual(anchored.props.style, { left: 120, bottom: 208 },
    'the panel sits above the measured trigger, 8px clear of it')

  // Downward placement: trigger near the top with more room below. The flipped panel
  // must also drop the CSS `bottom`, otherwise top and bottom both apply and the
  // absolute box is stretched to a negative (zero) height.
  anchored.props.ref.current = { getBoundingClientRect: () => ({ height: 600 }) }
  find(renderer.tree(), 'dsh-po-popover-backdrop').props.onClick()
  await renderer.settle()
  find(renderer.tree(), 'dsh-po-choice').props.ref.current = {
    getBoundingClientRect: () => ({ left: 120, top: 100, bottom: 128 }),
  }
  find(renderer.tree(), 'dsh-po-choice').props.onClick()
  await renderer.settle()
  assert.deepEqual(find(renderer.tree(), 'dsh-po-popover').props.style,
    { left: 120, top: 136, bottom: 'auto' },
    'the flipped panel pins top and resets bottom instead of collapsing')

  const layer = find(renderer.tree(), 'dsh-po-layer')
  assert.ok(layer, 'popover and backdrop share one portal layer')
  for (const handler of ['onMouseDown', 'onPointerDown', 'onClick', 'onKeyDown']) {
    let stopped = false
    layer.props[handler]({ stopPropagation() { stopped = true } })
    assert.equal(stopped, true, handler + ' does not bubble to the host composer')
  }
  const wrap = find(renderer.tree(), 'dsh-po-picker-wrap')
  assert.ok(find(wrap, 'dsh-po-popover'), 'the stand-in portal renders in place, so the popover is still reachable')
  globalThis.window.innerWidth = previousViewport.width
  globalThis.window.innerHeight = previousViewport.height
  delete globalThis.document.body
})
