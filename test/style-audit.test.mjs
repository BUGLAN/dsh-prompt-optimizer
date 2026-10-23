/**
 * Style regression tests.
 *
 * The settings page had two real defects that a DOM-free test would miss:
 *
 * 1. `.dsh-po-primary` painted white text on `--dsw-alias-brand-primary`, which
 *    in this theme resolves near-white — a 1.4:1 button label.
 * 2. The text fields drew their border with a token that resolves to nothing in
 *    this theme, so inputs and textareas rendered as bare text on the page.
 *
 * `style-audit.mjs` resolves the bundle's CSS against the measured token values
 * and computes WCAG ratios; this test keeps it in the suite so a future style
 * edit cannot silently regress either fix.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { promisify } from 'node:util'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const run = promisify(execFile)
const client = readFileSync(path.join(root, 'lib/client.js'), 'utf8')

test('every audited text/surface pair meets WCAG AA', async () => {
  const { stdout } = await run(process.execPath, [path.join(root, 'test/style-audit.mjs')], { cwd: root })
  assert.match(stdout, /ALL PAIRS PASS/, stdout)
  assert.doesNotMatch(stdout, /^FAIL/m, stdout)
})

test('the primary button never paints white on the near-white brand color', () => {
  assert.doesNotMatch(
    client,
    /\.dsh-po-primary\{[^}]*color:#fff/,
    'the button fill must not be the brand color with white text',
  )
  assert.match(
    client,
    /\.dsh-po-primary\{color:var\(--dsw-alias-bg-base[^}]*background:var\(--dsw-alias-label-primary/,
    'the primary button pairs label-primary fill with bg-base text (13.3:1 in the measured theme)',
  )
})

test('every primary-button state is styled, including the ones the bug showed', () => {
  for (const state of [':hover:not(:disabled)', ':active:not(:disabled)', ':disabled']) {
    assert.ok(
      client.includes('.dsh-po-primary' + state + '{'),
      'missing state rule for .dsh-po-primary' + state,
    )
  }
  assert.match(
    client,
    /\.dsh-po-primary:disabled\{[^}]*color:var\(--dsw-alias-label-secondary/,
    'the disabled label must use the secondary ink, not a faded white',
  )
})

test('text fields keep a visible surface and a visible boundary', () => {
  const rule = client.match(/\.dsh-po-input,\.dsh-po-textarea\{([^}]*)\}/)
  assert.ok(rule, 'the shared input/textarea rule exists')
  assert.match(rule[1], /background:color-mix/, 'the field needs its own surface')
  assert.match(rule[1], /border-color:color-mix/, 'the field needs a resolvable border color')
  assert.match(
    client,
    /\.dsh-po-input::placeholder,\.dsh-po-textarea::placeholder\{[^}]*opacity:1/,
    'the placeholder must not rely on the browser default opacity',
  )
})

test('no settings copy is dimmed with opacity (it defeats the token contrast)', () => {
  const settingsSection = client.slice(client.indexOf('设置页面'))
  const offenders = [...settingsSection.matchAll(/\.(dsh-po-[\w-]+)\{[^}]*opacity:\.\d+/g)].map((m) => m[1])
  assert.deepEqual(offenders, [], 'use label-secondary instead of opacity on text')
})
