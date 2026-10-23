/**
 * dsh-prompt-optimizer — prompt optimizer (host half)
 *
 * Serves the JSON endpoints behind the composer button and the Settings page:
 *
 *   POST /api/prompt-optimizer          { text }             -> { optimized }
 *   POST /api/prompt-optimizer/test     { instruction, input } -> { optimized }
 *   GET  /api/prompt-optimizer/config                        -> { config, builtin }
 *   POST /api/prompt-optimizer/config   { config }           -> { config, builtin }
 *
 * Optimization always runs through `resolveInstruction(config)`, so the prompt
 * the user marked default in Settings is the one the ✨ button sends; the test
 * endpoint uses the instruction it is given and writes nothing. Uses the active
 * default model (`agentDefaultModel`) and streams the reply via `ctx.llm`.
 * Only scalars cross the wire — no live objects.
 */
import {
  BUILTIN_INSTRUCTION,
  BUILTIN_NAME,
  MAX_TEST_INPUT_LENGTH,
  createPromptStore,
  normalizeConfig,
  resolveInstruction
} from './prompts.js'

export const name = 'dsh-prompt-optimizer'

// Hard dependencies: the plugin waits until these services are mounted.
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Route prefix shared by every endpoint this plugin serves. */
const BASE = '/api/prompt-optimizer'

/** 注册数据路由；关键依赖缺失时静默跳过（优化按钮是锦上添花，不阻塞宿主）。 */
export function apply(ctx) {
  const webServer = ctx.webServer
  const llm = ctx.llm
  const defaultModel = ctx.agentDefaultModel
  if (webServer === undefined || llm === undefined) return

  const store = createPromptStore()

  /**
   * Stream one completion under the given system prompt.
   * @param system - the optimization instruction to apply.
   * @param text - the prompt being rewritten.
   * @returns `{ optimized }` or `{ error, status }`.
   */
  async function optimize(system, text) {
    const sel = defaultModel !== undefined ? defaultModel.currentSelection() : undefined
    const provider = sel && typeof sel.provider === 'string' ? sel.provider : undefined
    const model = sel && typeof sel.model === 'string' ? sel.model : undefined
    if (provider === undefined || model === undefined) {
      return { status: 503, error: 'no model selection available' }
    }

    const messages = [{
      id: 'prompt-optimizer-user',
      role: 'user',
      content: [{ type: 'text', text: text }],
      source: { kind: 'user' }
    }]

    const options = {
      provider: provider,
      model: model,
      messages: messages,
      system: system,
      maxTokens: 2000
    }
    if (typeof sel.reasoningEffort === 'string') options.reasoningEffort = sel.reasoningEffort

    let out = ''
    let finishKind = 'stop'
    let finishMessage = ''
    for await (const chunk of llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        out += chunk.text
      } else if (chunk.type === 'finish' && chunk.reason) {
        finishKind = chunk.reason.kind
        if (chunk.reason.failure && typeof chunk.reason.failure.message === 'string') {
          finishMessage = chunk.reason.failure.message
        }
      }
    }

    if (finishKind !== 'stop') {
      return { status: 502, error: finishMessage !== '' ? finishMessage : ('model call finished: ' + finishKind) }
    }

    const optimized = out.trim()
    if (optimized === '') return { status: 502, error: 'model produced no output' }
    return { status: 200, optimized: optimized }
  }

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: BASE,
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }

        const payload = await readJson(req)
        if (payload === undefined) {
          writeJson(res, 400, { error: 'invalid JSON' })
          return
        }

        const text = typeof payload.text === 'string' ? payload.text : ''
        if (text.trim() === '') {
          writeJson(res, 400, { error: 'empty prompt' })
          return
        }

        const config = await store.read()
        const result = await optimize(resolveInstruction(config), text)
        if (result.optimized !== undefined) writeJson(res, 200, { optimized: result.optimized })
        else writeJson(res, result.status, { error: result.error })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'dsh-prompt-optimizer: /api/prompt-optimizer route')

  // Test one instruction against sample input without touching the saved document.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: BASE + '/test',
    handler: async (req, res) => {
      try {
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }

        const payload = await readJson(req)
        if (payload === undefined) {
          writeJson(res, 400, { error: 'invalid JSON' })
          return
        }

        const instruction = typeof payload.instruction === 'string' ? payload.instruction.trim() : ''
        if (instruction === '') {
          writeJson(res, 400, { error: 'empty instruction' })
          return
        }
        const input = typeof payload.input === 'string' ? payload.input.trim() : ''
        if (input === '') {
          writeJson(res, 400, { error: 'empty test input' })
          return
        }
        if (input.length > MAX_TEST_INPUT_LENGTH) {
          writeJson(res, 400, { error: 'test input too long' })
          return
        }

        const result = await optimize(instruction, input)
        if (result.optimized !== undefined) writeJson(res, 200, { optimized: result.optimized })
        else writeJson(res, result.status, { error: result.error })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'dsh-prompt-optimizer: /api/prompt-optimizer/test route')

  // Read (GET) or replace (POST) the prompt preset document.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: BASE + '/config',
    handler: async (req, res) => {
      try {
        if (req.method === 'GET') {
          writeJson(res, 200, { config: await store.read(), builtin: builtinView() })
          return
        }
        if (req.method !== 'POST') {
          writeJson(res, 405, { error: 'method not allowed' })
          return
        }

        const payload = await readJson(req)
        if (payload === undefined) {
          writeJson(res, 400, { error: 'invalid JSON' })
          return
        }

        // Accept either `{ config }` or a bare document, but never treat an
        // unrelated body as an empty document that wipes what the user saved.
        const wrapped = payload !== null && typeof payload === 'object' && payload.config !== undefined
        const candidate = wrapped ? payload.config : payload
        if (!wrapped && (payload === null || typeof payload !== 'object' || !Array.isArray(payload.prompts))) {
          writeJson(res, 400, { error: 'missing config' })
          return
        }
        const checked = normalizeConfig(candidate)
        if (checked.error !== undefined) {
          writeJson(res, 400, { error: checked.error })
          return
        }

        const saved = await store.write(checked.config)
        writeJson(res, 200, { config: saved, builtin: builtinView() })
      } catch (error) {
        writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }
  }), 'dsh-prompt-optimizer: /api/prompt-optimizer/config route')
}

/** The built-in instruction as the client renders it (read-only row). */
function builtinView() {
  return { id: '', name: BUILTIN_NAME, instruction: BUILTIN_INSTRUCTION }
}

/** Read and parse a request body; undefined when it is not valid JSON. */
async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

/** 统一 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(body))
}
