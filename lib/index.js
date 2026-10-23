/**
 * dsh-prompt-optimizer — prompt optimizer (host half)
 *
 * Serves the JSON endpoints behind the composer button and the Settings page:
 *
 *   POST /api/prompt-optimizer          { text }             -> { optimized }
 *   POST /api/prompt-optimizer/test     { instruction, input, image? } -> { optimized }
 *   GET  /api/prompt-optimizer/config                        -> { config, builtin, capabilities }
 *   POST /api/prompt-optimizer/config   { config }           -> { config, builtin, capabilities }
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
  resolveInstruction,
  resolveUseImages
} from './prompts.js'

export const name = 'dsh-prompt-optimizer'

// Hard dependencies: the plugin waits until these services are mounted.
export const inject = ['webServer', 'llm', 'agentDefaultModel']

/** Route prefix shared by every endpoint this plugin serves. */
const BASE = '/api/prompt-optimizer'

/** Image media types an optimization request may carry. */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Fallback transport cap when the deployment publishes no `imageLimits`. */
const DEFAULT_MAX_IMAGE_BYTES = 4 * 1024 * 1024

/** 注册数据路由；关键依赖缺失时静默跳过（优化按钮是锦上添花，不阻塞宿主）。 */
export function apply(ctx) {
  const webServer = ctx.webServer
  const llm = ctx.llm
  const defaultModel = ctx.agentDefaultModel
  if (webServer === undefined || llm === undefined) return

  const store = createPromptStore()

  /**
   * Whether the active model accepts image input, read from the model's own
   * capability metadata (`inputModalities`, the `Model['input']` mirror).
   *
   * Anything that prevents an affirmative answer — no selection, no resolver,
   * an adapter that throws, a model that lists only `text` — reads as "no image
   * support", because the caller's contract is to fall back to plain text
   * silently rather than to surface a capability error.
   *
   * @returns true only when the resolved model explicitly declares `image`.
   */
  async function modelSupportsImage() {
    const sel = defaultModel !== undefined ? defaultModel.currentSelection() : undefined
    const provider = sel && typeof sel.provider === 'string' ? sel.provider : undefined
    const model = sel && typeof sel.model === 'string' ? sel.model : undefined
    if (provider === undefined || model === undefined) return false
    if (typeof llm.resolveModelInfo !== 'function') return false
    try {
      const info = await llm.resolveModelInfo(provider, model)
      const modalities = info !== null && typeof info === 'object' && Array.isArray(info.inputModalities)
        ? info.inputModalities
        : []
      return modalities.includes('image')
    } catch {
      return false
    }
  }

  /**
   * Admit one optional image for a model request.
   *
   * Returns `undefined` when there is nothing usable to attach, which is the
   * path every unsupported case takes: no image in the payload, a model without
   * image support, or a deployment without an attachment service. None of those
   * touch the upload API or produce an error, so the caller simply continues
   * with the text-only request.
   *
   * A malformed payload on an image-capable model is a real user mistake and
   * comes back as `{ error }` instead.
   *
   * @param raw - the `image` field of a test request, or an array of them. The
   *   composer path may forward several pasted images at once.
   * @returns `{ blocks }`, `{ error }`, or `undefined` when nothing is attached.
   */
  async function admitImage(raw) {
    const items = Array.isArray(raw) ? raw : [raw]
    const usable = items.filter((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
    if (usable.length === 0) return undefined

    const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (attachments === undefined || typeof attachments.saveImages !== 'function') return undefined

    const limits = attachments.imageLimits
    const maxBytes = limits !== undefined && typeof limits.maxImageBytes === 'number'
      ? limits.maxImageBytes
      : DEFAULT_MAX_IMAGE_BYTES
    const maxCount = limits !== undefined && typeof limits.maxImagesPerMessage === 'number'
      ? limits.maxImagesPerMessage
      : usable.length

    const pending = []
    for (const item of usable) {
      const mediaType = typeof item.mediaType === 'string' ? item.mediaType : ''
      const data = typeof item.data === 'string' ? item.data : ''
      if (data === '') continue
      if (!IMAGE_MEDIA_TYPES.includes(mediaType)) return { error: 'unsupported image type' }
      const bytes = Buffer.from(data, 'base64')
      if (bytes.length === 0) continue
      if (bytes.length > maxBytes) return { error: 'image too large' }
      pending.push({
        data: new Uint8Array(bytes),
        mediaType: mediaType,
        name: typeof item.name === 'string' && item.name !== '' ? item.name : undefined
      })
    }
    if (pending.length === 0) return undefined
    if (pending.length > maxCount) return { error: 'too many images' }

    try {
      const refs = await attachments.saveImages(pending)
      const list = Array.isArray(refs) ? refs : []
      const blocks = list.filter((ref) => ref !== undefined).map((ref) => ({ type: 'image', attachment: ref }))
      return blocks.length === 0 ? undefined : { blocks: blocks }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * The capability facts the Settings page needs before it renders the image
   * affordance. `image` is false whenever the active model does not declare it,
   * which is what makes the whole feature disappear silently.
   * @returns the wire representation of this plugin's model capabilities.
   */
  async function capabilitiesView() {
    const image = await modelSupportsImage()
    return { image: image }
  }

  /**
   * Stream one completion under the given system prompt.
   * @param system - the optimization instruction to apply.
   * @param text - the prompt being rewritten.
   * @param imageBlock - optional admitted image block prepended to the user turn.
   * @returns `{ optimized }` or `{ error, status }`.
   */
  async function optimize(system, text, imageBlocks) {
    const sel = defaultModel !== undefined ? defaultModel.currentSelection() : undefined
    const provider = sel && typeof sel.provider === 'string' ? sel.provider : undefined
    const model = sel && typeof sel.model === 'string' ? sel.model : undefined
    if (provider === undefined || model === undefined) {
      return { status: 503, error: 'no model selection available' }
    }

    const images = Array.isArray(imageBlocks) ? imageBlocks : []
    const content = images.length === 0
      ? [{ type: 'text', text: text }]
      : [...images, { type: 'text', text: text }]

    const messages = [{
      id: 'prompt-optimizer-user',
      role: 'user',
      content: content,
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
        // 图片是「每条提示词」的可选参数：只有默认提示词开启了 useImages，才把
        // 输入框里粘贴的图片一并送去优化；否则请求与纯文本完全一致。
        let imageBlocks
        if (resolveUseImages(config) && payload.image !== undefined && payload.image !== null && await modelSupportsImage()) {
          const admitted = await admitImage(payload.image)
          if (admitted !== undefined && admitted.error !== undefined) {
            writeJson(res, 400, { error: admitted.error })
            return
          }
          imageBlocks = admitted !== undefined ? admitted.blocks : undefined
        }

        const result = await optimize(resolveInstruction(config), text, imageBlocks)
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

        // Images are opt-in and capability-gated: a model without image input
        // (or a deployment without an attachment service) drops the image and
        // runs the ordinary text-only optimization, with no upload and no error.
        let imageBlocks
        if (payload.image !== undefined && payload.image !== null && await modelSupportsImage()) {
          const admitted = await admitImage(payload.image)
          if (admitted !== undefined && admitted.error !== undefined) {
            writeJson(res, 400, { error: admitted.error })
            return
          }
          imageBlocks = admitted !== undefined ? admitted.blocks : undefined
        }

        const result = await optimize(instruction, input, imageBlocks)
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
          writeJson(res, 200, { config: await store.read(), builtin: builtinView(), capabilities: await capabilitiesView() })
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
        writeJson(res, 200, { config: saved, builtin: builtinView(), capabilities: await capabilitiesView() })
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
