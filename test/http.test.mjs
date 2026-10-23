/**
 * HTTP integration test for the host half.
 *
 * Mounts `lib/index.js` on a real `node:http` server on an ephemeral port and
 * drives it with `fetch`, so routing, body parsing, status codes and the JSON
 * envelope are proven over an actual socket instead of a stubbed request.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const home = await mkdtemp(path.join(tmpdir(), 'dsh-po-http-'))
process.env.DSH_HOME = home

const { apply } = await import('../lib/index.js')
const { BUILTIN_INSTRUCTION, configPath } = await import('../lib/prompts.js')

/** A 1x1 PNG, base64 body only. */
const IMAGE_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** Start a server whose routes come from the plugin's own `webServer.register`. */
async function startHost(options = {}) {
  const routes = []
  const calls = []
  /** Image uploads performed through the attachment service. */
  const uploads = []
  const server = http.createServer(async (req, res) => {
    const route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === new URL(req.url, 'http://127.0.0.1').pathname)
    if (route === undefined) {
      res.writeHead(404).end('not found')
      return
    }
    await route.handler(req, res)
  })
  const ctx = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
    llm: {
      stream: async function* (request) {
        calls.push(request)
        yield { type: 'text-delta', text: options.output ?? 'OPTIMIZED PROMPT' }
        yield { type: 'finish', reason: { kind: options.finishKind ?? 'stop' } }
      },
      resolveModelInfo: async (provider, model) => ({
        provider,
        model,
        name: model,
        inputModalities: options.modalities ?? ['text'],
      }),
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    effect: (factory) => factory(),
    get: (name) => {
      if (name !== 'attachments') return undefined
      return {
        imageLimits: { maxImageBytes: 64 * 1024, maxImagesPerMessage: 4 },
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
    },
  }
  apply(ctx)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  return {
    origin,
    calls,
    uploads,
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

test('http: the settings document round-trips over a real socket', async () => {
  const host = await startHost()
  try {
    const save = await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { defaultId: 'p1', prompts: [{ id: 'p1', name: '工程版', instruction: 'WRITE PRECISELY' }] } }),
    })
    assert.equal(save.status, 200)
    assert.equal(save.headers.get('cache-control'), 'no-store')
    assert.match(save.headers.get('content-type'), /application\/json/)
    const saved = await save.json()
    assert.equal(saved.config.prompts[0].name, '工程版')
    assert.equal(saved.builtin.instruction, BUILTIN_INSTRUCTION)

    const read = await (await fetch(host.origin + '/api/prompt-optimizer/config')).json()
    assert.deepEqual(read.config, saved.config, 'the GET returns exactly what was saved')

    const onDisk = JSON.parse(await readFile(configPath(), 'utf8'))
    assert.deepEqual(onDisk, saved.config, 'the document is on disk in DSH_HOME')
  } finally {
    await host.close()
  }
})

test('http: optimization uses the default saved prompt', async () => {
  const host = await startHost({ output: 'a sharper prompt' })
  try {
    await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { defaultId: 'p1', prompts: [{ id: 'p1', name: 'n', instruction: 'SENTINEL-INSTRUCTION' }] } }),
    })

    const res = await fetch(host.origin + '/api/prompt-optimizer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'make it better' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { optimized: 'a sharper prompt' })
    assert.equal(host.calls.at(-1).system, 'SENTINEL-INSTRUCTION')
  } finally {
    await host.close()
  }
})

test('http: the test endpoint previews without persisting', async () => {
  const host = await startHost({ output: 'preview' })
  try {
    const before = await (await fetch(host.origin + '/api/prompt-optimizer/config')).json()
    const res = await fetch(host.origin + '/api/prompt-optimizer/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instruction: 'TRY THIS', input: 'draft' }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { optimized: 'preview' })
    assert.equal(host.calls.at(-1).system, 'TRY THIS')
    const after = await (await fetch(host.origin + '/api/prompt-optimizer/config')).json()
    assert.deepEqual(after.config, before.config)
  } finally {
    await host.close()
  }
})

test('http: invalid payloads get 400 and unknown routes 404', async () => {
  const host = await startHost()
  try {
    const bad = await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400)
    assert.match((await bad.json()).error, /invalid JSON/)

    const invalidConfig = await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { prompts: [{ name: '', instruction: 'x' }] } }),
    })
    assert.equal(invalidConfig.status, 400)
    assert.match((await invalidConfig.json()).error, /名称/)

    assert.equal((await fetch(host.origin + '/api/prompt-optimizer/nope')).status, 404)
    assert.equal((await fetch(host.origin + '/api/prompt-optimizer')).status, 405)
  } finally {
    await host.close()
  }
})

test.after(async () => {
  await rm(home, { recursive: true, force: true })
})

test('http: an unrelated POST body cannot wipe the saved document', async () => {
  const host = await startHost()
  try {
    await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: { defaultId: '', prompts: [{ id: 'k', name: 'keep', instruction: 'KEEP' }] } }),
    })

    const empty = await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(empty.status, 400)
    assert.match((await empty.json()).error, /missing config/)

    const after = await (await fetch(host.origin + '/api/prompt-optimizer/config')).json()
    assert.equal(after.config.prompts[0].instruction, 'KEEP', 'the saved document survives')

    // A complete bare document (no wrapper) is still accepted.
    const bare = await fetch(host.origin + '/api/prompt-optimizer/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaultId: '', prompts: [] }),
    })
    assert.equal(bare.status, 200)
    assert.deepEqual((await bare.json()).config.prompts, [])
  } finally {
    await host.close()
  }
})

test('http: an image request over a real socket is gated by capability', async () => {
  const capable = await startHost({ modalities: ['text', 'image'], output: 'described' })
  try {
    const res = await fetch(capable.origin + '/api/prompt-optimizer/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: 'SYS',
        input: 'what is this',
        image: { data: IMAGE_BASE64, mediaType: 'image/png', name: 'shot.png' },
      }),
    })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { optimized: 'described' })
    assert.equal(capable.uploads.length, 1, 'the image is uploaded once')
    const content = capable.calls.at(-1).messages[0].content
    assert.equal(content[0].type, 'image')

    const caps = await (await fetch(capable.origin + '/api/prompt-optimizer/config')).json()
    assert.equal(caps.capabilities.image, true)
  } finally {
    await capable.close()
  }
})

test('http: a text-only model gets a text-only body and no upload endpoint call', async () => {
  const textOnly = await startHost({ modalities: ['text'], output: 'plain result' })
  try {
    const res = await fetch(textOnly.origin + '/api/prompt-optimizer/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instruction: 'SYS',
        input: 'what is this',
        image: { data: IMAGE_BASE64, mediaType: 'image/png' },
      }),
    })
    assert.equal(res.status, 200, 'still succeeds')
    assert.deepEqual(await res.json(), { optimized: 'plain result' })
    assert.equal(textOnly.uploads.length, 0, 'no image upload is attempted')
    assert.deepEqual(textOnly.calls.at(-1).messages[0].content, [{ type: 'text', text: 'what is this' }])

    const caps = await (await fetch(textOnly.origin + '/api/prompt-optimizer/config')).json()
    assert.equal(caps.capabilities.image, false)
  } finally {
    await textOnly.close()
  }
})
