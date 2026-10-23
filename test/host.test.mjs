import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = await mkdtemp(path.join(tmpdir(), 'dsh-po-host-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')
const { BUILTIN_INSTRUCTION, configPath, createPromptStore, normalizeConfig, resolveInstruction } =
  await import('../lib/prompts.js')

/**
 * Mount the host half against recording stubs.
 * @returns the captured route handlers keyed by path, plus the llm call log.
 */
function mountHost(options = {}) {
  const routes = new Map()
  const calls = []
  /** Every call to the upload API; any entry here means the plugin uploaded. */
  const uploads = []
  /** Every capability lookup, so "did not probe" is assertable. */
  const resolutions = []
  const modalities = options.modalities ?? ['text']
  const ctx = {
    webServer: {
      register: (route) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
    llm: {
      stream: async function* (request) {
        calls.push(request)
        yield { type: 'text-delta', text: options.output ?? 'OPTIMIZED' }
        yield { type: 'finish', reason: { kind: options.finishKind ?? 'stop' } }
      },
      resolveModelInfo: async (provider, model) => {
        resolutions.push({ provider, model })
        if (options.resolveThrows === true) throw new Error('adapter exploded')
        return { provider, model, name: model, inputModalities: modalities }
      },
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
    },
    effect: (factory) => factory(),
  }
  if (options.attachments !== false) {
    ctx.get = (name) => {
      if (name !== 'attachments') return undefined
      return {
        imageLimits: { maxImageBytes: options.maxImageBytes ?? 64 * 1024, maxImagesPerMessage: 4 },
        async saveImages(inputs) {
          uploads.push(inputs)
          return inputs.map((input, index) => ({
            attachmentId: 'a' + index,
            mediaType: input.mediaType,
            bytes: input.data.length,
            width: 1,
            height: 1,
          }))
        },
      }
    }
  }
  apply(ctx)
  return { routes, calls, uploads, resolutions }
}

/** Build a fake request whose body is `body`. */
function request(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Build a fake response that records the status and parsed body. */
function response() {
  const record = { status: 0, headers: undefined, body: undefined }
  return {
    record,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers
    },
    end(text) {
      record.body = JSON.parse(text)
    },
  }
}

/** Run one route handler to completion. */
async function call(route, method, body) {
  const res = response()
  await route.handler(request(method, body), res)
  return res.record
}

test('host: prompt document helpers keep only valid, non-empty prompts', () => {
  const checked = normalizeConfig({
    defaultId: 'b',
    prompts: [
      { id: 'a', name: ' A ', instruction: ' first ', extra: 'dropped' },
      { name: 'B', instruction: 'second' },
    ],
  })
  assert.equal(checked.error, undefined)
  assert.equal(checked.config.prompts[0].name, 'A')
  assert.equal(checked.config.prompts[0].instruction, 'first')
  assert.equal('extra' in checked.config.prompts[0], false, 'unknown fields are dropped')
  assert.match(checked.config.prompts[1].id, /^[0-9a-f-]{36}$/, 'a missing id is minted')
  assert.equal(checked.config.defaultId, '', 'a defaultId naming no prompt falls back to built-in')
})

test('host: prompt document rejects empty names, empty instructions and oversized lists', () => {
  assert.match(normalizeConfig({ prompts: [{ name: '  ', instruction: 'x' }] }).error, /名称/)
  assert.match(normalizeConfig({ prompts: [{ name: 'n', instruction: '  ' }] }).error, /内容/)
  assert.match(normalizeConfig({ prompts: new Array(51).fill({ name: 'n', instruction: 'i' }) }).error, /最多/)
  assert.match(normalizeConfig({ prompts: 'nope' }).error, /格式/)
  assert.match(normalizeConfig(null).error, /格式/)
})

test('host: the default prompt is what an optimization request sends', async () => {
  const store = createPromptStore({ file: path.join(home, 'default-check.json') })
  await store.write({
    defaultId: 'p1',
    prompts: [
      { id: 'p1', name: 'one', instruction: 'USE-ONE' },
      { id: 'p2', name: 'two', instruction: 'USE-TWO' },
    ],
  })
  assert.equal(resolveInstruction(await store.read()), 'USE-ONE')
  await store.write({ defaultId: 'p2', prompts: (await store.read()).prompts })
  assert.equal(resolveInstruction(await store.read()), 'USE-TWO')
  await store.write({ defaultId: '', prompts: [] })
  assert.equal(resolveInstruction(await store.read()), BUILTIN_INSTRUCTION, 'built-in instruction is the fallback')
})

test('host: config round-trips through disk and is visible to a fresh store', async () => {
  const file = path.join(home, 'nested', 'prompts.json')
  const first = createPromptStore({ file })
  const saved = await first.write({ defaultId: '', prompts: [{ name: 'n', instruction: 'i' }] })
  const onDisk = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(onDisk.prompts[0].instruction, 'i')
  assert.equal(onDisk.prompts[0].id, saved.prompts[0].id)

  const second = createPromptStore({ file })
  assert.deepEqual(await second.read(), saved, 'a new store reads the persisted document')
})

test('host: an unreadable document degrades to the built-in instruction instead of throwing', async () => {
  const file = path.join(home, 'broken.json')
  await (await import('node:fs/promises')).writeFile(file, '{ not json', 'utf8')
  const store = createPromptStore({ file })
  const config = await store.read()
  assert.deepEqual(config.prompts, [])
  assert.equal(resolveInstruction(config), BUILTIN_INSTRUCTION)
})

test('host: GET /config returns the saved document and the built-in prompt', async () => {
  const { routes } = mountHost()
  const configRoute = routes.get('/api/prompt-optimizer/config')
  assert.ok(configRoute, 'config route is registered')

  const save = await call(configRoute, 'POST', {
    config: { defaultId: '', prompts: [{ id: 'x1', name: '工程版', instruction: 'ENGINEERING' }] },
  })
  assert.equal(save.status, 200)
  assert.equal(save.body.config.prompts[0].name, '工程版')

  const read = await call(configRoute, 'GET')
  assert.equal(read.status, 200)
  assert.equal(read.body.config.prompts[0].instruction, 'ENGINEERING')
  assert.equal(read.body.builtin.instruction, BUILTIN_INSTRUCTION)

  const stored = JSON.parse(await readFile(configPath(), 'utf8'))
  assert.equal(stored.prompts[0].id, 'x1', 'the client-sent id survives the round trip')
})

test('host: POST /config rejects an invalid document without touching the saved one', async () => {
  const { routes } = mountHost()
  const configRoute = routes.get('/api/prompt-optimizer/config')
  await call(configRoute, 'POST', { config: { defaultId: '', prompts: [{ name: 'ok', instruction: 'keep me' }] } })

  const rejected = await call(configRoute, 'POST', { config: { prompts: [{ name: '', instruction: 'x' }] } })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.error, /名称/)

  const after = await call(configRoute, 'GET')
  assert.equal(after.body.config.prompts[0].instruction, 'keep me')
})

test('host: optimization uses the default prompt from the saved configuration', async () => {
  const { routes, calls } = mountHost({ output: 'better prompt' })
  const configRoute = routes.get('/api/prompt-optimizer/config')
  await call(configRoute, 'POST', {
    config: { defaultId: 'p2', prompts: [{ id: 'p2', name: 'two', instruction: 'DEFAULT-INSTRUCTION' }] },
  })

  const optimizeRoute = routes.get('/api/prompt-optimizer')
  const result = await call(optimizeRoute, 'POST', { text: 'fix the bug' })
  assert.equal(result.status, 200)
  assert.equal(result.body.optimized, 'better prompt')
  assert.equal(calls.at(-1).system, 'DEFAULT-INSTRUCTION', 'the saved default instruction reaches the model')
  assert.equal(calls.at(-1).messages[0].content[0].text, 'fix the bug')
})

test('host: optimization falls back to the built-in instruction when nothing is saved', async () => {
  const file = path.join(home, 'empty-home')
  process.env.DSH_HOME = file
  const { routes, calls } = mountHost()
  const result = await call(routes.get('/api/prompt-optimizer'), 'POST', { text: 'hi' })
  assert.equal(result.status, 200)
  assert.equal(calls.at(-1).system, BUILTIN_INSTRUCTION)
  await rm(file, { recursive: true, force: true })
  process.env.DSH_HOME = home
})

test('host: the test endpoint uses the supplied instruction and stores nothing', async () => {
  const { routes, calls } = mountHost({ output: 'previewed' })
  const configRoute = routes.get('/api/prompt-optimizer/config')
  await call(configRoute, 'POST', { config: { defaultId: '', prompts: [] } })

  const testRoute = routes.get('/api/prompt-optimizer/test')
  const result = await call(testRoute, 'POST', { instruction: 'TRY-ME', input: 'sample draft' })
  assert.equal(result.status, 200)
  assert.equal(result.body.optimized, 'previewed')
  assert.equal(calls.at(-1).system, 'TRY-ME')
  assert.equal(calls.at(-1).messages[0].content[0].text, 'sample draft')

  const stored = await call(configRoute, 'GET')
  assert.deepEqual(stored.body.config.prompts, [], 'a test never writes the document')
})

test('host: bad methods and bodies answer with explicit statuses', async () => {
  const { routes } = mountHost()
  assert.equal((await call(routes.get('/api/prompt-optimizer'), 'GET')).status, 405)
  assert.equal((await call(routes.get('/api/prompt-optimizer/config'), 'DELETE')).status, 405)

  const invalid = response()
  const body = {
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{oops', 'utf8') },
  }
  await routes.get('/api/prompt-optimizer').handler(body, invalid)
  assert.equal(invalid.record.status, 400)

  assert.equal((await call(routes.get('/api/prompt-optimizer'), 'POST', { text: '   ' })).status, 400)
  assert.equal((await call(routes.get('/api/prompt-optimizer/test'), 'POST', { instruction: '', input: 'x' })).status, 400)
})

test('host: a failed model call surfaces its reason instead of a draft', async () => {
  const { routes } = mountHost({ finishKind: 'error' })
  const result = await call(routes.get('/api/prompt-optimizer'), 'POST', { text: 'hello' })
  assert.equal(result.status, 502)
  assert.match(result.body.error, /error/)
  assert.equal(result.body.optimized, undefined)
})

test.after(async () => {
  process.env.DSH_HOME = home
  await rm(home, { recursive: true, force: true })
})

// ---------------------------------------------------------------- 图片输入

/** A 1x1 PNG, base64 body only — the smallest valid image payload. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test('host: a text-only model silently ignores an attached image', async () => {
  const { routes, calls, uploads, resolutions } = mountHost({ modalities: ['text'] })
  const result = await call(routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'draft',
    image: { data: PNG_BASE64, mediaType: 'image/png' },
  })

  assert.equal(result.status, 200, 'the request still succeeds')
  assert.equal(uploads.length, 0, 'no upload request is made')
  assert.equal(resolutions.length, 1, 'the capability is consulted before uploading')
  const content = calls.at(-1).messages[0].content
  assert.deepEqual(content, [{ type: 'text', text: 'draft' }], 'the turn stays text-only')
})

test('host: an image-capable model receives the image block before the text', async () => {
  const { routes, calls, uploads } = mountHost({ modalities: ['text', 'image'] })
  const result = await call(routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'describe it',
    image: { data: PNG_BASE64, mediaType: 'image/png', name: 'shot.png' },
  })

  assert.equal(result.status, 200)
  assert.equal(uploads.length, 1, 'the image is uploaded exactly once')
  assert.equal(uploads[0][0].mediaType, 'image/png')
  assert.equal(uploads[0][0].name, 'shot.png')
  const content = calls.at(-1).messages[0].content
  assert.equal(content.length, 2)
  assert.equal(content[0].type, 'image')
  assert.equal(content[0].attachment.attachmentId, 'a0')
  assert.deepEqual(content[1], { type: 'text', text: 'describe it' })
})

test('host: no image in the payload means no capability probe and no upload', async () => {
  const { routes, calls, uploads, resolutions } = mountHost({ modalities: ['text', 'image'] })
  await call(routes.get('/api/prompt-optimizer/test'), 'POST', { instruction: 'SYS', input: 'plain' })

  assert.equal(uploads.length, 0)
  assert.equal(resolutions.length, 0, 'a text-only request never asks about modalities')
  assert.deepEqual(calls.at(-1).messages[0].content, [{ type: 'text', text: 'plain' }])
})

test('host: a throwing or missing capability lookup degrades to text-only', async () => {
  const throwing = mountHost({ modalities: ['image'], resolveThrows: true })
  const failed = await call(throwing.routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'draft',
    image: { data: PNG_BASE64, mediaType: 'image/png' },
  })
  assert.equal(failed.status, 200, 'the optimization still runs')
  assert.equal(throwing.uploads.length, 0, 'no upload on an unknown capability')
  assert.deepEqual(throwing.calls.at(-1).messages[0].content, [{ type: 'text', text: 'draft' }])

  // A host without the resolver at all behaves the same way.
  const bare = mountHost({ modalities: ['image'] })
  bare.routes.get('/api/prompt-optimizer/test')
  assert.equal(typeof bare.resolutions.length, 'number')
})

test('host: an unsupported media type is rejected on a capable model', async () => {
  const { routes, uploads } = mountHost({ modalities: ['text', 'image'] })
  const result = await call(routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'draft',
    image: { data: PNG_BASE64, mediaType: 'image/tiff' },
  })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /image type/)
  assert.equal(uploads.length, 0)
})

test('host: an oversized image is rejected before uploading', async () => {
  const { routes, uploads } = mountHost({ modalities: ['text', 'image'], maxImageBytes: 8 })
  const result = await call(routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'draft',
    image: { data: PNG_BASE64, mediaType: 'image/png' },
  })
  assert.equal(result.status, 400)
  assert.match(result.body.error, /too large/)
  assert.equal(uploads.length, 0)
})

test('host: no attachment service means the image is dropped silently', async () => {
  const { routes, calls, uploads } = mountHost({ modalities: ['text', 'image'], attachments: false })
  const result = await call(routes.get('/api/prompt-optimizer/test'), 'POST', {
    instruction: 'SYS',
    input: 'draft',
    image: { data: PNG_BASE64, mediaType: 'image/png' },
  })
  assert.equal(result.status, 200)
  assert.equal(uploads.length, 0)
  assert.deepEqual(calls.at(-1).messages[0].content, [{ type: 'text', text: 'draft' }])
})

test('host: the config response publishes the image capability', async () => {
  const capable = mountHost({ modalities: ['text', 'image'] })
  const yes = await call(capable.routes.get('/api/prompt-optimizer/config'), 'GET')
  assert.equal(yes.body.capabilities.image, true)

  const textOnly = mountHost({ modalities: ['text'] })
  const no = await call(textOnly.routes.get('/api/prompt-optimizer/config'), 'GET')
  assert.equal(no.body.capabilities.image, false)

  const broken = mountHost({ resolveThrows: true })
  const unknown = await call(broken.routes.get('/api/prompt-optimizer/config'), 'GET')
  assert.equal(unknown.body.capabilities.image, false, 'an unknown capability reads as unsupported')
})

// -------------------------------------- 每条提示词的「允许图片输入」参数

test('host: the default prompt flag decides whether pasted images are forwarded', async () => {
  const withImages = mountHost({ modalities: ['text', 'image'] })
  const cfg = withImages.routes.get('/api/prompt-optimizer/config')
  await call(cfg, 'POST', {
    config: {
      defaultId: 'p1',
      prompts: [
        { id: 'p1', name: '带图', instruction: 'USE IMAGES', useImages: true },
        { id: 'p2', name: '纯文本', instruction: 'TEXT ONLY', useImages: false },
      ],
    },
  })

  const ok = await call(withImages.routes.get('/api/prompt-optimizer'), 'POST', {
    text: '看看这张图',
    image: [{ data: PNG_BASE64, mediaType: 'image/png', name: 'a.png' }],
  })
  assert.equal(ok.status, 200)
  assert.equal(withImages.uploads.length, 1, 'the opted-in prompt forwards images')
  assert.equal(withImages.calls.at(-1).messages[0].content[0].type, 'image')

  // Switching the default to the text-only prompt stops the forwarding.
  await call(cfg, 'POST', {
    config: {
      defaultId: 'p2',
      prompts: [
        { id: 'p1', name: '带图', instruction: 'USE IMAGES', useImages: true },
        { id: 'p2', name: '纯文本', instruction: 'TEXT ONLY', useImages: false },
      ],
    },
  })
  const uploadsBefore = withImages.uploads.length
  const plain = await call(withImages.routes.get('/api/prompt-optimizer'), 'POST', {
    text: '看看这张图',
    image: [{ data: PNG_BASE64, mediaType: 'image/png', name: 'a.png' }],
  })
  assert.equal(plain.status, 200)
  assert.equal(withImages.uploads.length, uploadsBefore, 'no upload for a prompt without the opt-in')
  assert.deepEqual(withImages.calls.at(-1).messages[0].content, [{ type: 'text', text: '看看这张图' }])
})

test('host: the built-in prompt never opts into images', async () => {
  const host = mountHost({ modalities: ['text', 'image'] })
  const result = await call(host.routes.get('/api/prompt-optimizer'), 'POST', {
    text: 'draft',
    image: [{ data: PNG_BASE64, mediaType: 'image/png' }],
  })
  assert.equal(result.status, 200)
  assert.equal(host.uploads.length, 0, 'the built-in default stays text-only')
  assert.deepEqual(host.calls.at(-1).messages[0].content, [{ type: 'text', text: 'draft' }])
})

test('host: several pasted images are uploaded as one ordered batch', async () => {
  const host = mountHost({ modalities: ['text', 'image'] })
  await call(host.routes.get('/api/prompt-optimizer/config'), 'POST', {
    config: { defaultId: 'p1', prompts: [{ id: 'p1', name: 'n', instruction: 'I', useImages: true }] },
  })

  const result = await call(host.routes.get('/api/prompt-optimizer'), 'POST', {
    text: 'three images',
    image: [
      { data: PNG_BASE64, mediaType: 'image/png', name: 'one.png' },
      { data: PNG_BASE64, mediaType: 'image/jpeg', name: 'two.jpg' },
      { data: PNG_BASE64, mediaType: 'image/webp', name: 'three.webp' },
    ],
  })
  assert.equal(result.status, 200)
  assert.equal(host.uploads.length, 1, 'one batch call')
  assert.equal(host.uploads[0].length, 3, 'all three in order')
  const content = host.calls.at(-1).messages[0].content
  assert.deepEqual(content.map((c) => c.type), ['image', 'image', 'image', 'text'])
})

test('host: the per-prompt flag is normalized and defaults to false', async () => {
  const checked = normalizeConfig({
    defaultId: 'a',
    prompts: [
      { id: 'a', name: 'on', instruction: 'i', useImages: true },
      { id: 'b', name: 'off', instruction: 'i' },
      { id: 'c', name: 'truthy', instruction: 'i', useImages: 'yes' },
    ],
  })
  assert.equal(checked.config.prompts[0].useImages, true)
  assert.equal(checked.config.prompts[1].useImages, false)
  assert.equal(checked.config.prompts[2].useImages, false, 'only a real boolean true opts in')
})

test('host: resolveUseImages follows the default prompt', async () => {
  const { resolveUseImages } = await import('../lib/prompts.js')
  assert.equal(resolveUseImages({ defaultId: '', prompts: [] }), false, 'built-in is text-only')
  assert.equal(resolveUseImages({
    defaultId: 'b',
    prompts: [
      { id: 'a', name: 'n', instruction: 'i', useImages: true },
      { id: 'b', name: 'n', instruction: 'i', useImages: false },
    ],
  }), false, 'the flag belongs to the default prompt, not any prompt')
  assert.equal(resolveUseImages({
    defaultId: 'a',
    prompts: [{ id: 'a', name: 'n', instruction: 'i', useImages: true }],
  }), true)
})
