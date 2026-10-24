/**
 * dsh-prompt-optimizer — prompt preset store (host half)
 *
 * Owns the durable document behind the Settings → 提示词 page: the user's
 * reusable optimization instructions and which one is the default. The
 * optimization route resolves its system prompt through `resolveInstruction`,
 * so whatever is marked default here is what the ✨ button actually sends.
 *
 * Storage is one JSON file under the DSH home directory, written atomically
 * (temp file + rename) and read through an in-memory cache that the write path
 * refreshes, so a save is visible to the very next optimization request.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Document version written by this build; older files are normalized on read. */
export const CONFIG_VERSION = 1

/** `defaultId` sentinel for "use the built-in instruction". */
export const BUILTIN_ID = ''

/** Upper bounds enforced before anything reaches disk. */
export const MAX_PROMPTS = 50
export const MAX_NAME_LENGTH = 60
export const MAX_INSTRUCTION_LENGTH = 8000
export const MAX_TEST_INPUT_LENGTH = 20000

/** The instruction this plugin has always used; the fallback and the built-in card. */
export const BUILTIN_INSTRUCTION = [
  'You are a prompt optimization assistant.',
  'Rewrite the user prompt to be clearer, more specific, and more effective for an AI coding agent.',
  'Preserve the original intent, task, and language.',
  'Output ONLY the optimized prompt: no preamble, no quotes, no explanation.'
].join(' ')

/** Name shown for the built-in instruction in Settings. */
export const BUILTIN_NAME = '默认'

/** An empty document: no custom prompts, built-in instruction in effect. */
export function emptyConfig() {
  return { version: CONFIG_VERSION, defaultId: BUILTIN_ID, builtinUseImages: false, prompts: [] }
}

/**
 * Validate and normalize one untrusted document.
 *
 * Every accepted prompt is reduced to `{ id, name, instruction }`: unknown
 * fields are dropped (the client may send its own view state), ids are
 * replaced when missing/malformed/duplicated, and a `defaultId` that names no
 * accepted prompt falls back to the built-in instruction.
 *
 * @param raw - parsed JSON from the client or from disk.
 * @returns `{ config }` on success or `{ error }` with a user-facing reason.
 */
export function normalizeConfig(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '配置格式无效' }
  }
  const input = raw.prompts === undefined ? [] : raw.prompts
  if (!Array.isArray(input)) return { error: '提示词列表格式无效' }
  if (input.length > MAX_PROMPTS) return { error: '提示词最多 ' + MAX_PROMPTS + ' 条' }

  const prompts = []
  const ids = new Set()
  for (const item of input) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      return { error: '提示词条目格式无效' }
    }
    const name = typeof item.name === 'string' ? item.name.trim() : ''
    const instruction = typeof item.instruction === 'string' ? item.instruction.trim() : ''
    if (name === '') return { error: '提示词名称不能为空' }
    if (name.length > MAX_NAME_LENGTH) return { error: '提示词名称不能超过 ' + MAX_NAME_LENGTH + ' 个字符' }
    if (instruction === '') return { error: '「' + name + '」的提示词内容不能为空' }
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      return { error: '「' + name + '」的提示词内容不能超过 ' + MAX_INSTRUCTION_LENGTH + ' 个字符' }
    }
    let id = typeof item.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(item.id) ? item.id : randomUUID()
    if (ids.has(id)) id = randomUUID()
    ids.add(id)
    // 每条提示词自带「是否接受图片输入」的可选参数，缺省为 false。
    prompts.push({ id: id, name: name, instruction: instruction, useImages: item.useImages === true })
  }

  const requested = typeof raw.defaultId === 'string' ? raw.defaultId : ''
  const defaultId = prompts.some((prompt) => prompt.id === requested) ? requested : BUILTIN_ID
  // The built-in row has no stored prompt object, so its image preference is
  // a document-level flag. It participates in the same switch and resolution
  // path as a custom prompt's `useImages`.
  const builtinUseImages = raw.builtinUseImages === true
  return {
    config: {
      version: CONFIG_VERSION,
      defaultId: defaultId,
      builtinUseImages: builtinUseImages,
      prompts: prompts
    }
  }
}

/**
 * The system prompt one optimization request must use.
 * @param config - a normalized document, or anything shaped like one.
 * @returns the default prompt's instruction, or the built-in instruction.
 */
export function resolveInstruction(config) {
  const prompts = config !== null && typeof config === 'object' && Array.isArray(config.prompts) ? config.prompts : []
  const defaultId = config !== null && typeof config === 'object' && typeof config.defaultId === 'string' ? config.defaultId : BUILTIN_ID
  const found = prompts.find((prompt) => prompt !== null && typeof prompt === 'object' && prompt.id === defaultId)
  const instruction = found !== undefined && typeof found.instruction === 'string' ? found.instruction.trim() : ''
  return instruction === '' ? BUILTIN_INSTRUCTION : instruction
}

/**
 * Whether the prompt in effect accepts image input.
 *
 * This is the per-prompt optional parameter: the active prompt's `useImages`
 * decides whether the ✨ button forwards the composer's pasted images. The
 * built-in row has no prompt object, so its own `builtinUseImages` flag is
 * used when `defaultId` is the built-in sentinel.
 *
 * @param config - a normalized document, or anything shaped like one.
 * @returns true only when the active prompt explicitly opted in.
 */
export function resolveUseImages(config) {
  const prompts = config !== null && typeof config === 'object' && Array.isArray(config.prompts) ? config.prompts : []
  const defaultId = config !== null && typeof config === 'object' && typeof config.defaultId === 'string' ? config.defaultId : BUILTIN_ID
  if (defaultId === BUILTIN_ID) {
    return config !== null && typeof config === 'object' && config.builtinUseImages === true
  }
  const found = prompts.find((prompt) => prompt !== null && typeof prompt === 'object' && prompt.id === defaultId)
  return found !== undefined && found.useImages === true
}

/**
 * The DSH home directory, resolved the same way the rest of the profile stack
 * resolves it: `DSH_HOME` when set (with `~` expansion), otherwise `~/.dsh`.
 * @param env - environment to read; defaults to `process.env`.
 */
export function resolveDshHome(env = process.env) {
  const raw = env !== null && typeof env === 'object' ? env.DSH_HOME : undefined
  if (typeof raw === 'string' && raw.trim() !== '') {
    const expanded = expandHome(raw.trim())
    return path.isAbsolute(expanded) ? expanded : path.join(process.cwd(), expanded)
  }
  return path.join(homedir(), '.dsh')
}

/** @returns the absolute path of this plugin's settings document. */
export function configPath(env = process.env) {
  return path.join(resolveDshHome(env), 'dsh-prompt-optimizer', 'prompts.json')
}

/**
 * Open the settings document.
 *
 * `read()` never throws: a missing or unreadable file resolves to the empty
 * document so the optimization route keeps working with the built-in prompt.
 * `write()` validates first, then serializes behind a queue and replaces the
 * file atomically.
 *
 * @param options.file - absolute document path; defaults to {@link configPath}.
 */
export function createPromptStore(options = {}) {
  const file = typeof options.file === 'string' && options.file !== '' ? options.file : configPath()
  let cached
  let queue = Promise.resolve()

  async function read() {
    if (cached !== undefined) return cached
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        console.warn('[dsh-prompt-optimizer] cannot read ' + file + ':', error instanceof Error ? error.message : error)
      }
      cached = emptyConfig()
      return cached
    }
    const result = normalizeConfig(parsed)
    if (result.error !== undefined) {
      console.warn('[dsh-prompt-optimizer] ignoring invalid ' + file + ': ' + result.error)
      cached = emptyConfig()
      return cached
    }
    cached = result.config
    return cached
  }

  function write(raw) {
    const result = normalizeConfig(raw)
    if (result.error !== undefined) return Promise.reject(new Error(result.error))
    const config = result.config
    const run = queue.then(async () => {
      const dir = path.dirname(file)
      await mkdir(dir, { recursive: true })
      const temp = file + '.' + randomUUID() + '.tmp'
      try {
        await writeFile(temp, JSON.stringify(config, null, 2) + '\n', 'utf8')
        await rename(temp, file)
      } catch (error) {
        await rm(temp, { force: true }).catch(() => {})
        throw error
      }
      cached = config
      return config
    })
    // Keep the chain alive after a failed write; the caller still sees the rejection.
    queue = run.then(() => {}, () => {})
    return run
  }

  return { file: file, read: read, write: write }
}

/** Expand a leading `~` or `~/` against the user's home directory. */
function expandHome(value) {
  const home = homedir()
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2))
  return value
}
