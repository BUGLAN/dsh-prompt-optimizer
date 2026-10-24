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

test('the image input is optional and gated on the model capability', () => {
  const host = read('lib/index.js')
  const client = read('lib/client.js')

  assert.match(host, /async function modelSupportsImage\(\)/, 'capability is resolved on the host')
  assert.match(host, /inputModalities/, 'the capability comes from the model metadata, not a heuristic')
  assert.match(host, /modalities\.includes\('image'\)/, 'only an explicit `image` declaration counts')
  assert.match(host, /capabilities: await capabilitiesView\(\)/, 'the client learns the capability from the config response')

  // The upload API is reached only behind the capability gate.
  assert.match(host, /attachments\.saveImages/, 'images use the attachment service')
  assert.match(
    host,
    /await modelSupportsImage\(\)\)\s*\{\s*const admitted = await admitImage/,
    'the upload path is guarded by the capability check',
  )

  // Client: the control is rendered only when the host says the model supports it.
  assert.match(client, /capabilities\.image \? imageField\(\) : null/, 'the image field is conditional')
  assert.match(client, /setCapabilities\(\{ image: Boolean\(/, 'a missing capability reads as unsupported')
})

test('each prompt carries its own optional "allow images" flag', () => {
  const prompts = read('lib/prompts.js')
  const host = read('lib/index.js')
  const client = read('lib/client.js')

  assert.match(prompts, /useImages: item\.useImages === true/, 'the field is normalized into the stored document')
  assert.match(prompts, /export function resolveUseImages/, 'the active prompt exposes its flag')
  assert.match(host, /resolveUseImages\(config\)/, 'the optimize route honors the default prompt flag')
  assert.match(
    host,
    /resolveUseImages\(config\) && payload\.image !== undefined/,
    'images are attached only when the prompt opted in',
  )
  assert.match(client, /activeImageSupport\(\)\.allowed/, 'the composer button reads the selected prompt + model gate')
  assert.match(client, /selectedTest\.useImages === true|startEdit|useImages: prompt\.useImages === true/,
    'the settings editor edits the flag per prompt')
})

test('the composer forwards pasted images through the conversation service', () => {
  const client = read('lib/client.js')
  assert.match(client, /resolveDraftAttachments/, 'draft attachments are resolved from the host service')
  assert.match(client, /attachment\.kind !== "image"/, 'only image attachments are forwarded')
  assert.match(client, /selectAttachmentIds/, 'attachment ids come from the input state')
  assert.match(client, /catch \{\s*\/\/ 单张失败/, 'a failed read degrades quietly')
})

test('the text-only request shape is unchanged when no image is involved', () => {
  const host = read('lib/index.js')
  assert.match(host, /const images = Array\.isArray\(imageBlocks\) \? imageBlocks : \[\]/,
    'the image list defaults to empty')
  assert.match(host, /images\.length === 0[\s\S]{0,40}\{ type: 'text', text: text \}/,
    'without images the message keeps the original single text block')
})

test('the composer has an inline radio picker before the sparkle', () => {
  const client = read('lib/client.js')
  assert.match(client, /function PromptPicker\(props\)/, 'a dedicated picker component exists')
  const pickerAt = client.indexOf("h(PromptPicker, { disabled: busy })")
  const sparkleAt = client.indexOf('className: "dsh-po-btn"', pickerAt)
  assert.ok(pickerAt > 0 && sparkleAt > pickerAt, 'the picker is rendered before the sparkle')
  assert.match(client, /type: "radio"/, 'the options are real radio inputs')
  assert.match(client, /role: "radiogroup"/, 'the options form a radiogroup')
  assert.match(client, /name: "dsh-po-prompt"/, 'all options share one radio group name')
  assert.ok(client.includes("dsh-po-composer-controls") && client.includes("height:28px"), 'the control fits the 28px toolbar row')
  assert.ok(client.includes("dsh-po-popover") && client.includes("bottom:calc(100% + 8px)"), 'the menu opens upward')
  assert.match(client, /"aria-haspopup": "dialog"/, 'the trigger announces its popup')
  assert.match(client, /"aria-expanded": open/, 'the trigger exposes the expanded state')
})

test('the trigger displays the active prompt title', () => {
  const client = read('lib/client.js')
  assert.match(client, /className: "dsh-po-choice-title", title: active\.name \}, active\.name/, 'the title is rendered in the trigger')
  assert.match(client, /dsh-po-choice-title\{[^}]*text-overflow:ellipsis/, 'a long title truncates instead of stretching the row')
  assert.doesNotMatch(client, /conversation\.input\.dock/, 'no separate strip above the composer is injected')
})

test('every picker row has an interactive image switch', () => {
  const client = read('lib/client.js')
  assert.match(client, /"支持图片输入"/, 'the positive capability label exists')
  assert.match(client, /"不支持图片输入"/, 'the negative capability label exists')
  assert.match(client, /function imageSupportFor\(option, capabilities\)/, 'the label is derived from prompt opt-in + model capability')
  assert.match(client, /option\.useImages !== true/, 'a prompt without the opt-in reports unsupported')
  assert.match(client, /capabilities\.image !== true/, 'a text-only model reports unsupported')
  assert.match(client, /role: "switch"/, 'each row renders a real switch input')
  assert.match(client, /dsh-po-switch-track/, 'the switch has a visible track')
  assert.match(client, /function configWithUseImages\(config, id, useImages\)/, 'the switch has a persistence helper')
  assert.match(client, /builtinUseImages: useImages === true/, 'the built-in row has a saved preference too')
})

test('picking a prompt and toggling images share one persisted save path', () => {
  const client = read('lib/client.js')
  const prompts = read('lib/prompts.js')
  assert.match(client, /async function persistConfig\(mutate\)/, 'selection and switches share one save path')
  assert.match(client, /body: JSON\.stringify\(\{ config: nextConfig \}\)/, 'the document goes through the config endpoint')
  assert.match(client, /setCatalogState\(\{ config: previousConfig \}\)/, 'a rejected save rolls back')
  assert.match(prompts, /builtinUseImages: builtinUseImages/, 'the built-in switch is normalized')
  assert.match(prompts, /if \(defaultId === BUILTIN_ID\) \{\s*return config[\s\S]{0,120}builtinUseImages === true/, 'the built-in switch affects image resolution')
})
