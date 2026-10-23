/**
 * Test support for the client half.
 *
 * A miniature React renderer: function components, `useState`, `useEffect`,
 * `useCallback`, `useRef`, and re-rendering when state changes. Hook identity is
 * per component instance keyed by render position, and unmounted instances run
 * their effect cleanups, so `lib/client.js` is mounted and driven for real — the
 * suite never keeps a copy of the component logic.
 *
 * The `React` object is module-level because the bundle captures it once at load
 * time and keeps using it for every mount. Rendering is synchronous and
 * single-threaded, so one shared hook cursor is enough.
 */

/** Compare two dependency arrays the way React does. */
function depsChanged(previous, next) {
  if (previous === undefined || next === undefined) return true
  if (previous.length !== next.length) return true
  return previous.some((value, index) => !Object.is(value, next[index]))
}

let hookCursor = null
let pendingEffects = []
let pendingCleanups = []

/** The React stand-in handed to the bundle. */
export const React = {
  createElement(type, config, ...children) {
    const elementProps = { ...(config ?? {}) }
    if (children.length === 1) elementProps.children = children[0]
    else if (children.length > 1) elementProps.children = children
    return { type, props: elementProps, key: elementProps.key }
  },
  useState(initial) {
    const instance = cursor('useState')
    const index = instance.cursor++
    if (!(index in instance.hooks)) {
      instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
    }
    const slot = instance.hooks[index]
    const setState = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next
      if (Object.is(value, slot.value)) return
      slot.value = value
      instance.dirty = true
      instance.renderer.dirty = true
    }
    return [slot.value, setState]
  },
  useCallback(callback, deps) {
    const instance = cursor('useCallback')
    const index = instance.cursor++
    const previous = instance.hooks[index]
    if (previous === undefined || depsChanged(previous.deps, deps)) {
      instance.hooks[index] = { callback, deps }
    }
    return instance.hooks[index].callback
  },
  useEffect(effect, deps) {
    const instance = cursor('useEffect')
    const index = instance.cursor++
    const previous = instance.hooks[index]
    if (previous === undefined) {
      instance.hooks[index] = { effect, deps, cleanup: undefined }
      pendingEffects.push({ instance, index })
      return
    }
    if (deps === undefined || depsChanged(previous.deps, deps)) {
      previous.effect = effect
      previous.deps = deps
      pendingCleanups.push({ instance, index })
      pendingEffects.push({ instance, index })
    }
  },
  useRef(initial) {
    const instance = cursor('useRef')
    const index = instance.cursor++
    if (!(index in instance.hooks)) instance.hooks[index] = { current: initial }
    return instance.hooks[index]
  },
}

function cursor(name) {
  if (hookCursor === null) throw new Error(name + ' called outside a component render')
  return hookCursor
}

/**
 * Effect queues are shared by the module-level React object, so each renderer
 * drains only the entries its own instances queued. Draining everything would
 * let one mount consume another mount's effects.
 * @param owner - the renderer whose pending effects to drain.
 */
function drainEffects(owner) {
  const mine = []
  const others = []
  for (const entry of pendingEffects) {
    if (entry.instance.renderer === owner) mine.push(entry)
    else others.push(entry)
  }
  pendingEffects = others
  return mine
}

/** Run the cleanups one renderer queued, leaving other renderers' alone. */
function drainCleanups(owner) {
  const mine = []
  const others = []
  for (const entry of pendingCleanups) {
    if (entry.instance.renderer === owner) mine.push(entry)
    else others.push(entry)
  }
  pendingCleanups = others
  for (const { instance, index } of mine) {
    const hook = instance.hooks[index]
    if (hook && typeof hook.cleanup === 'function') hook.cleanup()
    if (hook) hook.cleanup = undefined
  }
}

/**
 * Create a renderer bound to one root component.
 * @param component - root function component.
 */
export function createRenderer(component) {
  const instances = new Map()
  const renderer = { dirty: true }
  let props = {}
  let tree = null

  /** Resolve (and create) the hook store of one component instance. */
  function instanceAt(path, type) {
    let instance = instances.get(path)
    if (instance === undefined || instance.type !== type) {
      instance = { type, hooks: [], cursor: 0, dirty: false, renderer }
      instances.set(path, instance)
    }
    instance.cursor = 0
    instance.seen = true
    return instance
  }

  /** Render one element/node, expanding function components. */
  function renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return node
    if (typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, path + '.' + String(index)))
    if (typeof node.type === 'function') {
      const instance = instanceAt(path, node.type)
      const outer = hookCursor
      hookCursor = instance
      let output
      try {
        output = node.type(node.props ?? {})
      } finally {
        hookCursor = outer
      }
      // Children render with a fresh cursor; each function child installs its own.
      const beforeChildren = hookCursor
      hookCursor = null
      try {
        return renderNode(output, path + '/' + String(node.type.name || 'anon'))
      } finally {
        hookCursor = beforeChildren
      }
    }
    const elementProps = { ...(node.props ?? {}) }
    const out = { type: node.type, props: elementProps, key: node.key }
    if (elementProps.children !== undefined) out.props.children = renderNode(elementProps.children, path + '/children')
    return out
  }

  /** Render the root component, then reconcile effects and removed instances. */
  function render() {
    renderer.dirty = false
    drainCleanups(renderer)
    for (const instance of instances.values()) instance.seen = false
    const outer = hookCursor
    hookCursor = null
    try {
      tree = renderNode(React.createElement(component, props), 'root')
    } finally {
      hookCursor = outer
    }
    // Instances absent from this pass were unmounted: run their cleanups.
    for (const [path, instance] of [...instances]) {
      if (instance.seen) continue
      for (const hook of instance.hooks) {
        if (hook && typeof hook.cleanup === 'function') hook.cleanup()
      }
      instances.delete(path)
    }
    for (const { instance, index } of drainEffects(renderer)) {
      if (!instance.seen) continue
      const hook = instance.hooks[index]
      if (hook === undefined) continue
      const cleanup = hook.effect()
      hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    return tree
  }

  return {
    /** Replace props; the next `settle()` re-renders. */
    setProps(next) {
      props = { ...props, ...next }
      renderer.dirty = true
    },
    /** Render synchronously. */
    render() {
      return render()
    },
    /**
     * Render and let pending promises resolve until the tree settles.
     * @param ticks - macrotask turns to allow.
     */
    async settle(ticks = 12) {
      for (let tick = 0; tick < ticks; tick += 1) {
        if (renderer.dirty || tree === null) render()
        await new Promise((resolve) => { setTimeout(resolve, 0) })
      }
      if (renderer.dirty || tree === null) render()
      return tree
    },
    /** The last rendered tree. */
    tree() {
      return tree
    },
    /** Unmount everything, running effect cleanups. */
    unmount() {
      for (const instance of instances.values()) {
        for (const hook of instance.hooks) {
          if (hook && typeof hook.cleanup === 'function') hook.cleanup()
          hook.cleanup = undefined
        }
      }
      instances.clear()
    },
  }
}

/** Depth-first walk over a rendered element tree. */
export function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node === 'string' || typeof node === 'number') return
  visit(node)
  walk(node.props?.children, visit)
}

/** All elements whose `className` contains `token` as a class. */
export function findAll(tree, token) {
  const found = []
  walk(tree, (node) => {
    const className = node.props?.className
    if (typeof className === 'string' && className.split(/\s+/).includes(token)) found.push(node)
  })
  return found
}

/** The first element whose `className` contains `token`, or undefined. */
export function find(tree, token) {
  return findAll(tree, token)[0]
}

/** Concatenated direct text of a subtree. */
export function textOf(node) {
  let text = ''
  walk(node, (element) => {
    const children = element.props?.children
    for (const child of Array.isArray(children) ? children : [children]) {
      if (typeof child === 'string' || typeof child === 'number') text += String(child)
    }
  })
  return text
}

/** All elements whose visible text equals `label`. */
export function findByText(tree, label) {
  const found = []
  walk(tree, (node) => {
    if (textOf(node).trim() === label) found.push(node)
  })
  return found
}

/** The first button whose visible text equals `label`. */
export function button(tree, label) {
  return findByText(tree, label).find((node) => node.type === 'button')
}

/** Whether any element carries `token` in its class list. */
export function has(tree, token) {
  return find(tree, token) !== undefined
}

/**
 * Install browser globals the client bundle touches.
 * @returns the document stub and the style tags it recorded.
 */
export function installDom() {
  const styleTags = []
  const document = {
    getElementById: (id) => styleTags.find((tag) => tag.id === id) ?? null,
    createElement: () => ({
      id: '',
      dataset: {},
      textContent: '',
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value },
    }),
    head: { appendChild: (tag) => { styleTags.push(tag) } },
  }
  globalThis.document = document
  return { document, styleTags }
}

/** Load the client bundle and return its module id and Cordis exports. */
export async function loadClient() {
  let registration
  globalThis.window = globalThis.window ?? {}
  globalThis.window.__ModuleLoader__ = { load: (next) => { registration = next } }
  const url = new URL('../lib/client.js', import.meta.url)
  // A cache-busting query keeps repeated loads in one process independent.
  await import(url.href + '?t=' + Math.random().toString(36).slice(2))
  if (registration === undefined) throw new Error('client bundle did not register')
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error('unexpected module request: ' + specifier)
  })
  return { id: registration.id, exports }
}
