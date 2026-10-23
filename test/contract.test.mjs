import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const read = (file) => readFileSync(path.join(root, file), 'utf8')

test('package is named dsh-prompt-optimizer', () => {
  assert.equal(pkg.name, 'dsh-prompt-optimizer')
})

test('declares a dsh.bundle manifest (installable via `dsh plugin add`)', () => {
  assert.ok(pkg.dsh?.bundle, 'package.json must declare `dsh.bundle`')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
})

test('declares a web client half', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
})

test('ships every runtime module it imports', () => {
  assert.ok(pkg.files.includes('lib'), '`files` must cover lib/')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('bundle patch file exists and names this package', () => {
  const patchFile = path.join(root, pkg.dsh.bundle.patch)
  assert.ok(existsSync(patchFile), 'cordis.patch.yml must sit next to package.json')
  const text = readFileSync(patchFile, 'utf8')
  assert.match(text, /id:\s*dsh-prompt-optimizer/)
  assert.match(text, /name:\s*dsh-prompt-optimizer/)
})

test('host half exports name / inject / apply', async () => {
  const host = await import(pathToFileURL(path.join(root, 'lib/index.js')).href)
  assert.equal(host.name, 'dsh-prompt-optimizer')
  assert.ok(Array.isArray(host.inject), 'inject should list hard dependencies')
  assert.equal(typeof host.apply, 'function')
})

test('prompt store module loads and exposes the shared contract', async () => {
  const store = await import(pathToFileURL(path.join(root, 'lib/prompts.js')).href)
  assert.equal(typeof store.createPromptStore, 'function')
  assert.equal(typeof store.normalizeConfig, 'function')
  assert.equal(typeof store.resolveInstruction, 'function')
  assert.equal(typeof store.BUILTIN_INSTRUCTION, 'string')
  assert.ok(store.BUILTIN_INSTRUCTION.length > 0)
})

test('client half registers the button against the conversation input slot', () => {
  const text = read('lib/client.js')
  assert.match(text, /__ModuleLoader__\.load/)
  assert.match(text, /conversation\.input\.left/)
  assert.match(text, /\/api\/prompt-optimizer/)
})

test('client half reads the draft via the 0.1.2 session-kit hook with legacy fallback', () => {
  const text = read('lib/client.js')
  assert.match(text, /props\.useInput/, 'must consume the useInput selector hook (>=0.1.2 slot standard kit)')
  assert.match(text, /selectDraft\(props\.input\)/, 'must keep the pre-0.1.2 props.input fallback')
})

test('idle button renders the sparkle emoji glyph', () => {
  const text = read('lib/client.js')
  assert.match(text, /dsh-po-spark[^)]*"✨"/, 'SparkleIcon must render a literal ✨ emoji span')
})

test('disabled state is grayscale (distinct from enabled, equally legible)', () => {
  const text = read('lib/client.js')
  assert.match(text, /:disabled\{cursor:not-allowed;filter:grayscale\(1\)\}/, 'disabled must desaturate to gray without dimming')
  assert.match(text, /style\.textContent = CSS/, 'apply() must rewrite the injected <style> content idempotently')
})

test('the busy state has exactly one animation: the spinner', () => {
  const text = read('lib/client.js')
  assert.match(text, /dsh-po-spinner\{animation:dsh-po-spin/, 'the spinner animation remains')
  assert.doesNotMatch(text, /dsh-po-progress/, 'the underscore/progress bar animation is removed')
  assert.doesNotMatch(text, /dsh-po-slide/, 'its keyframes are removed with it')
})

test('success swaps the icon for an undo affordance inside a transitioned wrapper', () => {
  const text = read('lib/client.js')
  assert.match(text, /function UndoIcon\(\)/, 'an undo icon exists')
  assert.match(text, /dsh-po-undo/, 'the undo state has its own class')
  assert.match(text, /dsh-po-glyph/, 'icons render inside the animated glyph wrapper')
  assert.match(text, /key: busy \? "busy" : canUndo \? "undo" : "idle"/, 'the key change re-mounts so the transition replays')
  assert.match(text, /撤销优化，恢复原始提示词/, 'the undo action is labelled for hover and assistive tech')
})

test('the undo icon is not a refresh/ring arrow', () => {
  const text = read('lib/client.js')
  const undo = text.slice(text.indexOf('function UndoIcon()'), text.indexOf('function UndoIcon()') + 900)
  assert.match(undo, /M9 14 4 9l5-5/, 'open left-pointing arrow head')
  assert.match(undo, /M4 9h10\.5a5\.5 5\.5 0 0 1 0 11H11/, 'open hook, not a closed circle')
  assert.doesNotMatch(undo, /a9 9 0 1 0/, 'the near-full-circle rotate-ccw arc must not come back')
  assert.doesNotMatch(undo, /a9 9 0 1 1/, 'nor the clockwise refresh ring')
})

test('the settings section is registered with a "提示词" label', () => {
  const text = read('lib/client.js')
  assert.match(text, /slots\.inject\("settings\.section"/)
  assert.match(text, /name: "settings\.section",\s*\n\s*id: "dsh-prompt-optimizer"/)
  assert.match(text, /label: \(\) => "提示词"/)
})

test('the settings page covers create/edit/delete/default/test and persists through the host', () => {
  const text = read('lib/client.js')
  assert.match(text, /新增提示词/)
  assert.match(text, /确认删除/)
  assert.match(text, /设为默认/)
  assert.match(text, /开始测试/)
  assert.match(text, /\/api\/prompt-optimizer\/test/)
  assert.match(text, /fetch\(CONFIG_URL/, 'configuration goes through the host endpoint')
  assert.match(text, /method: "POST"/, 'saves are POSTed, not kept in component state only')
})
