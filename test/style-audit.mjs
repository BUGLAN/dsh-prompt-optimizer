/**
 * Contrast audit for the settings page CSS.
 *
 * Parses the `CSS` array out of lib/client.js, resolves `var()` / `color-mix()`
 * against the token values measured from the running dark theme, and reports the
 * WCAG contrast of every text/surface pair the page actually uses.
 */
import { readFileSync } from 'node:fs'

const src = readFileSync('lib/client.js', 'utf8')
const start = src.indexOf('const CSS = [')
const end = src.indexOf('].join(', start)
const block = src.slice(start, end)
const rules = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'))

/** Token values measured from the live dark theme (see screenshots). */
const TOKENS = {
  '--dsw-alias-label-primary': '#f9fafb',
  '--dsw-alias-label-secondary': '#bcbcbe',
  '--dsw-alias-bg-base': '#2c2c2e',
  '--dsw-alias-bg-layer-1': '#232324',
  '--dsw-alias-bg-layer-2': '#3a3a3c',
  '--dsw-alias-border-l2': '#464647',
  '--dsw-alias-state-error-primary': '#f87171',
  '--dsw-alias-state-success-primary': '#4ade80',
}
const PAGE = [0x2c, 0x2c, 0x2e]
const CARD = [0x23, 0x23, 0x24]

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const rgbToHex = (c) => '#' + c.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')

/** Resolve a CSS color expression to rgb against the token table. */
function resolve(value, depth = 0) {
  if (value === undefined || depth > 6) return null
  const v = value.trim()
  const mix = v.match(/^color-mix\(\s*in srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(.+?)\s*\)$/i)
  if (mix) {
    const a = resolve(mix[1], depth + 1)
    const b = resolve(mix[3], depth + 1)
    if (a === null || b === null) return null
    const p = parseFloat(mix[2]) / 100
    return [0, 1, 2].map((i) => p * a[i] + (1 - p) * b[i])
  }
  const vari = v.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/s)
  if (vari) {
    if (TOKENS[vari[1]] !== undefined) return hexToRgb(TOKENS[vari[1]])
    return vari[2] === undefined ? null : resolve(vari[2], depth + 1)
  }
  if (/^#[0-9a-f]{6}$/i.test(v)) return hexToRgb(v)
  const rgba = v.match(/^rgba?\(([^)]+)\)$/i)
  if (rgba) {
    const parts = rgba[1].split(',').map((x) => parseFloat(x))
    if (parts.length === 4 && parts[3] < 1) return null
    return parts.slice(0, 3)
  }
  return null
}

/**
 * Declarations of every rule listing `selector`, keeping the LAST value of a
 * repeated property (the cascade between a plain fallback and a `color-mix`
 * override inside one rule: the later declaration is what the browser paints).
 */
function declarations(selector) {
  const out = {}
  if (selector === null || selector === undefined) return out
  for (const rule of rules) {
    const brace = rule.indexOf('{')
    if (brace < 0) continue
    const selectors = rule.slice(0, brace).split(',').map((s) => s.trim())
    if (!selectors.includes(selector)) continue
    for (const part of rule.slice(brace + 1, rule.lastIndexOf('}')).split(';')) {
      const idx = part.indexOf(':')
      if (idx < 0) continue
      out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
    }
  }
  return out
}

/**
 * Declarations for a selector, accepting a comma-separated list (the rule is
 * matched when it lists every part, e.g. the shared input/textarea rule).
 */
function declarationsOf(selector) {
  const parts = selector.split(',').map((s) => s.trim())
  const merged = {}
  for (const part of parts) Object.assign(merged, declarations(part))
  return merged
}

function luminance(c) {
  const f = (v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = c.map(f)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const la = luminance(a), lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** The surface a control sits on: its own background, else the page or card. */
function surfaceOf(selector, fallback) {
  const decl = declarationsOf(selector)
  if (decl.background !== undefined) {
    const resolved = resolve(decl.background)
    if (resolved !== null) return resolved
  }
  return fallback
}

const rows = []
/**
 * Record one text-on-surface pair.
 * @param label - what the reader sees.
 * @param textSelector - rule carrying the `color` (null: inherits label-primary).
 * @param surfaceSelector - rule carrying the `background`, or 'page'/'card'/null.
 * @param min - WCAG AA threshold: 4.5 body text, 3 large text / UI boundaries.
 * @param note - extra context shown beside the ratio.
 * @param inheritFrom - selector whose `color` applies when the main one omits it
 *   (state rules such as `:hover` usually restate only the background).
 */
function check(label, textSelector, surfaceSelector, min, note = '', inheritFrom = null) {
  let fg
  const own = textSelector === null ? {} : declarationsOf(textSelector)
  const inherited = inheritFrom === null ? {} : declarationsOf(inheritFrom)
  const colorSource = own.color ?? inherited.color
  fg = colorSource === undefined ? resolve('var(--dsw-alias-label-primary)') : resolve(colorSource)
  let bg
  if (surfaceSelector === null) bg = PAGE
  else if (surfaceSelector === 'page') bg = PAGE
  else if (surfaceSelector === 'card') bg = CARD
  else bg = surfaceOf(surfaceSelector, PAGE)
  if (fg === null || bg === null) {
    rows.push({ label, ratio: null, min, note })
    return
  }
  rows.push({ label, ratio: contrast(fg, bg), min, note, fg: rgbToHex(fg), bg: rgbToHex(bg) })
}

// ---- button family (the reported bug + every state) ----
check('primary button  (normal)', '.dsh-po-primary', '.dsh-po-primary', 4.5)
check('primary button  (hover)', '.dsh-po-primary:hover:not(:disabled)', '.dsh-po-primary:hover:not(:disabled)', 4.5, '', '.dsh-po-primary')
check('primary button  (active)', '.dsh-po-primary:active:not(:disabled)', '.dsh-po-primary:active:not(:disabled)', 4.5, '', '.dsh-po-primary')
check('primary button  (disabled)', '.dsh-po-primary:disabled', '.dsh-po-primary:disabled', 4.5)

// ---- secondary button / tabs ----
check('secondary button (normal)', '.dsh-po-action', 'page', 4.5)
check('secondary button (disabled)', '.dsh-po-action:disabled', 'page', 4.5)
check('tab (inactive)', '.dsh-po-tab', 'page', 4.5)
check('tab (active)', '.dsh-po-tab-active', 'page', 4.5)

// ---- fields: text, placeholder and the boundary that makes them look like fields ----
check('input value', '.dsh-po-input,.dsh-po-textarea', '.dsh-po-input,.dsh-po-textarea', 4.5)
check('input placeholder', '.dsh-po-input::placeholder,.dsh-po-textarea::placeholder', '.dsh-po-input,.dsh-po-textarea', 4.5)
{
  const field = declarationsOf('.dsh-po-input,.dsh-po-textarea')
  const fill = resolve(field.background)
  const line = resolve(field['border-color'])
  rows.push({
    label: 'input border vs surface',
    ratio: line && fill ? contrast(line, fill) : null,
    min: 3,
    note: 'non-text boundary (WCAG 1.4.11)',
    fg: line ? rgbToHex(line) : '-',
    bg: fill ? rgbToHex(fill) : '-',
  })
}
{
  const field = declarationsOf('.dsh-po-input,.dsh-po-textarea')
  const fill = resolve(field.background)
  rows.push({
    label: 'input surface vs page',
    ratio: fill ? contrast(fill, PAGE) : null,
    min: 1.12,
    note: 'field must read as a surface',
    fg: fill ? rgbToHex(fill) : '-',
    bg: rgbToHex(PAGE),
  })
}

// ---- copy ----
check('section description', '.dsh-po-desc', 'page', 4.5)
check('field label', '.dsh-po-label', 'page', 4.5)
check('hint text', '.dsh-po-hint', 'page', 4.5)
check('error text', '.dsh-po-error', 'page', 4.5)
check('success text', '.dsh-po-ok', 'page', 4.5)
check('danger button', '.dsh-po-danger', 'page', 4.5)
check('card name', '.dsh-po-name', 'card', 4.5)
check('card body', '.dsh-po-text', 'card', 4.5)
check('badge', '.dsh-po-badge', 'card', 4.5)
check('result preview', '.dsh-po-preview', '.dsh-po-preview', 4.5)
check('danger button (hover)', '.dsh-po-danger', 'page', 4.5)

let failed = 0
console.log('')
for (const row of rows) {
  const ok = row.ratio !== null && row.ratio >= row.min
  if (!ok) failed += 1
  const ratio = row.ratio === null ? '  n/a ' : row.ratio.toFixed(2).padStart(5)
  console.log(
    (ok ? 'PASS ' : 'FAIL ') + ratio + ':1  ' + row.label.padEnd(32) +
    (row.fg ? row.fg + ' on ' + row.bg : '') + (row.note ? '  (' + row.note + ')' : ''),
  )
}
console.log('\n' + (failed === 0 ? 'ALL PAIRS PASS' : failed + ' PAIR(S) FAIL'))
process.exitCode = failed === 0 ? 0 : 1
