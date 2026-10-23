/**
 * dsh-prompt-optimizer — prompt optimizer (client half)
 *
 * 在输入框工具行左侧注册一个图标按钮：点击后 POST /api/prompt-optimizer
 * 优化当前草稿并回填。界面不显示说明文字，仅在悬停时通过 title 展示；
 * 优化中按钮切换为旋转图标（不再叠加第二条横线动画）；成功后图标平滑
 * 切换为「撤销」图标，点击即把草稿还原为点击前的原文。
 *
 * 同时在 `settings.section` 注册「提示词」设置页：管理多条可复用的优化
 * 指令（新增 / 编辑 / 删除 / 设为默认），以及一个带测试输入与结果预览
 * 的测试 Tab。配置由 Host 半持久化，默认提示词直接参与实际优化。
 */
window.__ModuleLoader__.load({
  id: "dsh-prompt-optimizer",
  factory(require) {
    const react = require("react")
    const inject = ["slots"]

    const STYLE_ID = "dsh-prompt-optimizer-style"
    /** 配置读写与测试接口（Host 半注册的精确路由）。 */
    const CONFIG_URL = "/api/prompt-optimizer/config"
    const TEST_URL = "/api/prompt-optimizer/test"
    /** Host 未返回内置提示词时的兜底文案，与 lib/prompts.js 保持一致。 */
    const FALLBACK_BUILTIN = {
      id: "",
      name: "内置默认",
      instruction: [
        "You are a prompt optimization assistant.",
        "Rewrite the user prompt to be clearer, more specific, and more effective for an AI coding agent.",
        "Preserve the original intent, task, and language.",
        "Output ONLY the optimized prompt: no preamble, no quotes, no explanation."
      ].join(" ")
    }

    const CSS = [
      // ---------------------------------------------------------------- 按钮
      ".dsh-po-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;padding:0;overflow:hidden}",
      ".dsh-po-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-btn:disabled{cursor:not-allowed;filter:grayscale(1)}",
      ".dsh-po-btn.dsh-po-busy:disabled{cursor:progress;filter:none}",
      ".dsh-po-glyph{display:inline-flex;align-items:center;justify-content:center;animation:dsh-po-glyph-in .18s cubic-bezier(.2,.8,.3,1)}",
      "@keyframes dsh-po-glyph-in{from{opacity:0;transform:scale(.68) rotate(-14deg)}to{opacity:1;transform:none}}",
      ".dsh-po-spark{font-size:15px;line-height:1}",
      ".dsh-po-spinner{animation:dsh-po-spin .8s linear infinite}",
      "@keyframes dsh-po-spin{to{transform:rotate(360deg)}}",
      ".dsh-po-btn.dsh-po-undo{color:var(--dsw-alias-label-primary,#222)}",
      "@media (prefers-reduced-motion:reduce){.dsh-po-glyph{animation:none}.dsh-po-spinner{animation:none}}",

      // ------------------------------------------------------------ 设置页面
      ".dsh-po-section{display:flex;flex-direction:column;gap:14px;padding:4px 0 24px;font-size:14px;line-height:22px}",
      ".dsh-po-head{display:flex;flex-direction:column;gap:4px}",
      ".dsh-po-title{font-size:16px;font-weight:500}",
      ".dsh-po-desc{font-size:13px;color:var(--dsw-alias-label-secondary,#666)}",
      ".dsh-po-tabs{display:flex;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l2,#6a6a6c)}",
      ".dsh-po-tab{font:inherit;color:var(--dsw-alias-label-secondary,#666);background:transparent;border:none;border-radius:8px 8px 0 0;padding:6px 12px;cursor:pointer}",
      ".dsh-po-tab:hover{color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
      ".dsh-po-tab-active{color:var(--dsw-alias-label-primary,#222);font-weight:500;box-shadow:inset 0 -2px 0 var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-list{display:flex;flex-direction:column;gap:10px}",
      ".dsh-po-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);border-radius:10px;background:var(--dsw-alias-bg-layer-1,transparent)}",
      ".dsh-po-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsh-po-name{font-weight:500;color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-badge{font-size:11px;line-height:18px;padding:0 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:13px;color:var(--dsw-alias-label-secondary,#666);white-space:pre-wrap;word-break:break-word}",
      ".dsh-po-actions{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}",
      ".dsh-po-action{font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#222);background:transparent;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);border-radius:6px;padding:3px 8px;cursor:pointer}",
      ".dsh-po-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
      ".dsh-po-action:disabled{cursor:not-allowed;color:var(--dsw-alias-label-secondary,#666);border-color:var(--dsw-alias-border-l2,#6a6a6c);background:transparent}",
      // 主操作按钮：填充用 label-primary、文字用 bg-base。品牌色在本主题下接近白色，
      // 白字叠白底只有 1.4:1；这一对是主题自己保证的对比组合（13.3:1）。
      // hover/active/disabled 用 color-mix 做同一色相的明度变化，前面保留一条纯色回退。
      ".dsh-po-primary{color:var(--dsw-alias-bg-base,#2c2c2e);background:var(--dsw-alias-label-primary,#f9fafb);border-color:transparent;font-weight:500}",
      ".dsh-po-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#f9fafb);background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 88%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-primary:active:not(:disabled){background:var(--dsw-alias-label-primary,#f9fafb);background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 78%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-primary:disabled{cursor:not-allowed;color:var(--dsw-alias-label-secondary,#666);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 10%,var(--dsw-alias-bg-base,#2c2c2e));border-color:transparent;font-weight:400}",
      ".dsh-po-primary:disabled:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 10%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-danger{color:var(--dsw-alias-state-error-primary,#f87171);border-color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 12%,transparent)}",
      ".dsh-po-field{display:flex;flex-direction:column;gap:6px}",
      ".dsh-po-label{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      // 输入控件：可见的 surface + 边框，避免“看起来就是一行文字”而认不出是输入框。
      ".dsh-po-input,.dsh-po-textarea{box-sizing:border-box;width:100%;font:inherit;color:var(--dsw-alias-label-primary,#222);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 8%,var(--dsw-alias-bg-base,#2c2c2e));border:1px solid var(--dsw-alias-border-l2,#6a6a6c);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 44%,var(--dsw-alias-bg-base,#2c2c2e));border-radius:8px;padding:6px 8px}",
      ".dsh-po-input::placeholder,.dsh-po-textarea::placeholder{color:var(--dsw-alias-label-secondary,#666);opacity:1}",
      ".dsh-po-textarea{min-height:96px;line-height:20px;resize:vertical}",
      ".dsh-po-input:hover,.dsh-po-textarea:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 44%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-input:focus-visible,.dsh-po-textarea:focus-visible,.dsh-po-tab:focus-visible,.dsh-po-action:focus-visible,.dsh-po-primary:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#222);outline-offset:1px}",
      ".dsh-po-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      ".dsh-po-error{font-size:12px;color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-ok{font-size:12px;color:var(--dsw-alias-state-success-primary,#4ade80)}",
      ".dsh-po-preview{margin:0;padding:10px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 8%,var(--dsw-alias-bg-base,#2c2c2e));color:var(--dsw-alias-label-primary,#222);font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}",
      ".dsh-po-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsh-po-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary,#666);border:.5px dashed var(--dsw-alias-border-l2,#6a6a6c);border-radius:10px}"
    ].join("\n")

    const h = react.createElement

    /** 空闲图标：真正的 ✨ emoji 字形（用户指定），跨平台 NotoColorEmoji / Apple Color Emoji 均有该字形。 */
    function SparkleIcon() {
      return h("span", { className: "dsh-po-spark", "aria-hidden": true }, "✨")
    }

    function SpinnerIcon() {
      return h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round",
        className: "dsh-po-spinner",
        "aria-hidden": true
      },
        h("circle", { cx: 12, cy: 12, r: 9, opacity: 0.25 }),
        h("path", { d: "M21 12a9 9 0 0 0-9-9" })
      )
    }

    /**
     * 回退图标：开口的左向回转箭头（Lucide `undo-2` 形状）。
     *
     * 不用 `rotate-ccw` 那种近乎整圈的环形箭头 —— 它和「刷新」几乎同形，用户会
     * 误以为点击是重新生成。这里改成箭头在左上、弧线向右下敞开的勾形，
     * 与刷新（闭环 + 右上箭头）明显区分。
     */
    function UndoIcon() {
      return h("svg", {
        width: 16, height: 16, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true
      },
        h("path", { d: "M9 14 4 9l5-5" }),
        h("path", { d: "M4 9h10.5a5.5 5.5 0 0 1 0 11H11" })
      )
    }

    /** 稳定 selector：返回字符串原始值，配合 useSyncExternalStoreWithSelector 无订阅抖动。 */
    const selectDraft = (s) => s && typeof s.draft === "string" ? s.draft : ""

    // ------------------------------------------------------------ 工具函数

    /** 读取 JSON 响应；非 2xx 或缺少期望字段时抛出带原因的 Error。 */
    async function readJsonResponse(res, field) {
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        const message = data && typeof data.error === "string" ? data.error : ("HTTP " + res.status)
        throw new Error(message)
      }
      if (data === null || typeof data !== "object" || typeof data[field] !== "string") {
        throw new Error("响应格式无效")
      }
      return data
    }

    /** 生成一个客户端 id；Host 半会校验格式并在冲突时替换。 */
    function newPromptId() {
      return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
    }

    // ------------------------------------------------------------ 优化按钮

    function OptimizeButton(props) {
      const [busy, setBusy] = react.useState(false)
      // 撤销态：记录本次优化前后的草稿。仅当草稿仍是优化结果时图标才显示为撤销，
      // 用户手动改写后自然回到 ✨，避免“撤销”覆盖用户自己的编辑。
      const [undo, setUndo] = react.useState(null)
      // 0.1.2+ 宿主：草稿经会话标准 kit 的 useInput 选择器 hook 下发（renderSlot 的
      // owner props 已改为空对象）；旧宿主：直接传 props.input 快照。宿主版本在页面
      // 生命周期内恒定，两条分支不会在重渲染之间切换，不违反 hook 规则。
      const draft = typeof props.useInput === "function"
        ? props.useInput(selectDraft)
        : selectDraft(props.input)
      const canUndo = undo !== null && draft === undo.after
      const disabled = busy || (!canUndo && draft.trim() === "")

      const onClick = async () => {
        if (busy) return

        // 撤销：把优化后的草稿还原成点击前的原文。
        if (canUndo) {
          const before = undo.before
          setUndo(null)
          if (props.inputActions && typeof props.inputActions.setDraft === "function") {
            props.inputActions.setDraft(before)
          }
          return
        }

        const text = draft
        if (text.trim() === "") return
        setUndo(null)
        setBusy(true)
        try {
          const res = await fetch("/api/prompt-optimizer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: text }),
            cache: "no-store"
          })
          const data = await res.json().catch(() => null)
          if (res.ok && data && typeof data.optimized === "string" && data.optimized.trim() !== "") {
            if (props.inputActions && typeof props.inputActions.setDraft === "function") {
              props.inputActions.setDraft(data.optimized)
              // 模型原样返回时没有可撤销的差异，保持 ✨ 而不是显示无效的撤销按钮。
              setUndo(data.optimized === text ? null : { before: text, after: data.optimized })
            }
          } else {
            const message = data && typeof data.error === "string" ? data.error : ("HTTP " + res.status)
            console.error("[dsh-prompt-optimizer]", message)
          }
        } catch (error) {
          console.error("[dsh-prompt-optimizer]", error)
        } finally {
          setBusy(false)
        }
      }

      const icon = busy
        ? h(SpinnerIcon)
        : canUndo ? h(UndoIcon) : h(SparkleIcon)
      const label = busy ? "正在优化提示词…" : canUndo ? "撤销优化，恢复原始提示词" : "优化提示词"

      return h("button", {
        type: "button",
        className: "dsh-po-btn" + (busy ? " dsh-po-busy" : "") + (canUndo ? " dsh-po-undo" : ""),
        title: label,
        "aria-label": label,
        disabled: disabled,
        onClick: onClick
      },
        // key 变化即重新挂载，触发一次 .dsh-po-glyph 过渡，避免图标生硬替换。
        h("span", { className: "dsh-po-glyph", key: busy ? "busy" : canUndo ? "undo" : "idle" }, icon)
      )
    }

    // ------------------------------------------------------------ 设置页面

    /**
     * 「提示词」设置页。
     *
     * 两枚 Tab：`prompts` 管理提示词（新增 / 编辑 / 删除 / 设为默认），
     * `test` 用真实模型接口试跑某条提示词并预览结果。每次改动都整体
     * POST 回 /api/prompt-optimizer/config，成功后才认为已保存。
     */
    function PromptSettingsSection() {
      const [status, setStatus] = react.useState("loading") // loading | ready | error
      const [config, setConfig] = react.useState({ defaultId: "", prompts: [] })
      const [builtin, setBuiltin] = react.useState(FALLBACK_BUILTIN)
      const [error, setError] = react.useState("")
      const [saving, setSaving] = react.useState(false)
      const [saved, setSaved] = react.useState(false)
      const [tab, setTab] = react.useState("prompts")
      const [editor, setEditor] = react.useState(null) // { mode: 'create'|'edit', id, name, instruction }
      const [editorError, setEditorError] = react.useState("")
      const [confirmId, setConfirmId] = react.useState(null)
      const [showBuiltin, setShowBuiltin] = react.useState(false)
      const [test, setTest] = react.useState({ id: "", input: "", running: false, output: "", error: "" })
      /** Abort handle of the in-flight config load, so a retry supersedes the previous one. */
      const loadController = react.useRef(null)
      /** Monotonic save sequence; only the newest response may rewrite the document. */
      const saveSequence = react.useRef(0)

      /** 首次挂载读取配置；卸载时中止请求，避免关闭设置面板后 setState。 */
      const load = react.useCallback(() => {
        if (loadController.current !== null) loadController.current.abort()
        const controller = new AbortController()
        loadController.current = controller
        let alive = true
        setStatus("loading")
        setError("")
        fetch(CONFIG_URL, { cache: "no-store", signal: controller.signal })
          .then(async (res) => {
            const data = await res.json().catch(() => null)
            if (!res.ok) {
              throw new Error(data && typeof data.error === "string" ? data.error : ("HTTP " + res.status))
            }
            if (data === null || typeof data !== "object" || data.config === null || typeof data.config !== "object") {
              throw new Error("配置响应格式无效")
            }
            if (!alive) return
            setConfig(data.config)
            if (data.builtin && typeof data.builtin.instruction === "string") setBuiltin(data.builtin)
            setStatus("ready")
            setTest((current) => current.id === "" && typeof data.config.defaultId === "string"
              ? { ...current, id: data.config.defaultId }
              : current)
          })
          .catch((cause) => {
            if (!alive || (cause && cause.name === "AbortError")) return
            setError(cause instanceof Error ? cause.message : String(cause))
            setStatus("error")
          })
        return () => {
          alive = false
          controller.abort()
          if (loadController.current === controller) loadController.current = null
        }
      }, [])

      react.useEffect(load, [load])

      /** 静默保存成功提示。 */
      react.useEffect(() => {
        if (!saved) return undefined
        const timer = setTimeout(() => setSaved(false), 2000)
        return () => clearTimeout(timer)
      }, [saved])

      /**
       * 保存一份完整配置：先乐观应用，失败则回滚并报错。
       *
       * 只有最后发出的一次保存有权改写界面：`previous` 在请求发出时捕获，
       * 若期间用户又改了一次，较早的失败回滚会被丢弃，避免把新状态覆盖成旧文档。
       * @param next - 完整的 `{ defaultId, prompts }` 文档。
       */
      const commit = async (next) => {
        const previous = config
        const sequence = saveSequence.current + 1
        saveSequence.current = sequence
        setConfig(next)
        setSaving(true)
        setError("")
        try {
          const res = await fetch(CONFIG_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ config: next }),
            cache: "no-store"
          })
          const data = await res.json().catch(() => null)
          if (!res.ok) {
            throw new Error(data && typeof data.error === "string" ? data.error : ("HTTP " + res.status))
          }
          if (saveSequence.current !== sequence) return
          if (data !== null && typeof data === "object" && data.config !== null && typeof data.config === "object") {
            setConfig(data.config)
          }
          if (data && data.builtin && typeof data.builtin.instruction === "string") setBuiltin(data.builtin)
          setSaved(true)
        } catch (cause) {
          if (saveSequence.current !== sequence) return
          setConfig(previous)
          setError(cause instanceof Error ? cause.message : String(cause))
        } finally {
          if (saveSequence.current === sequence) setSaving(false)
        }
      }

      const setDefault = (id) => { void commit({ ...config, defaultId: id }) }

      const startCreate = () => {
        setEditor({ mode: "create", id: "", name: "", instruction: "" })
        setEditorError("")
        setConfirmId(null)
      }

      const startEdit = (prompt) => {
        setEditor({ mode: "edit", id: prompt.id, name: prompt.name, instruction: prompt.instruction })
        setEditorError("")
        setConfirmId(null)
      }

      const cancelEditor = () => { setEditor(null); setEditorError("") }

      const saveEditor = (form) => {
        const name = form.name.trim()
        const instruction = form.instruction.trim()
        if (name === "") { setEditorError("请填写名称"); return }
        if (instruction === "") { setEditorError("请填写提示词内容"); return }
        const prompts = editor.mode === "edit"
          ? config.prompts.map((prompt) => prompt.id === editor.id ? { ...prompt, name: name, instruction: instruction } : prompt)
          : [...config.prompts, { id: editor.id === "" ? newPromptId() : editor.id, name: name, instruction: instruction }]
        setEditor(null)
        setEditorError("")
        void commit({ ...config, prompts: prompts })
      }

      const removePrompt = (id) => {
        setConfirmId(null)
        void commit({
          defaultId: config.defaultId === id ? "" : config.defaultId,
          prompts: config.prompts.filter((prompt) => prompt.id !== id)
        })
        // 被删除的提示词若正被测试选中，测试选择回落到内置默认。
        setTest((current) => current.id === id ? { ...current, id: "", output: "", error: "" } : current)
      }

      const selectedTest = test.id === "" ? builtin : config.prompts.find((prompt) => prompt.id === test.id)

      const runTest = async () => {
        if (selectedTest === undefined || test.input.trim() === "" || test.running) return
        setTest((current) => ({ ...current, running: true, error: "", output: "" }))
        try {
          const res = await fetch(TEST_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ instruction: selectedTest.instruction, input: test.input }),
            cache: "no-store"
          })
          const data = await readJsonResponse(res, "optimized")
          setTest((current) => ({ ...current, running: false, output: data.optimized }))
        } catch (cause) {
          setTest((current) => ({
            ...current,
            running: false,
            error: cause instanceof Error ? cause.message : String(cause)
          }))
        }
      }

      const copyOutput = () => {
        if (test.output === "" || typeof navigator === "undefined" || navigator.clipboard === undefined) return
        void navigator.clipboard.writeText(test.output).catch(() => {})
      }

      // ------------------------------------------------------------ 渲染片段

      const actionButton = (text, onClick, options = {}) => h("button", {
        type: "button",
        className: "dsh-po-action" + (options.primary ? " dsh-po-primary" : "") + (options.danger ? " dsh-po-danger" : ""),
        onClick: onClick,
        disabled: options.disabled === true,
        title: options.title
      }, text)

      const editorCard = () => {
        const form = editor
        return h("div", { className: "dsh-po-card", key: "editor" },
          h("div", { className: "dsh-po-card-head" },
            h("span", { className: "dsh-po-name" }, form.mode === "edit" ? "编辑提示词" : "新增提示词")),
          h("div", { className: "dsh-po-field" },
            h("label", { className: "dsh-po-label", htmlFor: "dsh-po-name-input" }, "名称"),
            h("input", {
              id: "dsh-po-name-input",
              className: "dsh-po-input",
              type: "text",
              maxLength: 60,
              value: form.name,
              placeholder: "例如：严谨工程版",
              onChange: (event) => setEditor((current) => ({ ...current, name: event.target.value }))
            })),
          h("div", { className: "dsh-po-field" },
            h("label", { className: "dsh-po-label", htmlFor: "dsh-po-instruction-input" }, "优化指令（系统提示词）"),
            h("textarea", {
              id: "dsh-po-instruction-input",
              className: "dsh-po-textarea",
              rows: 6,
              maxLength: 8000,
              value: form.instruction,
              placeholder: "描述希望模型如何改写用户的提示词…",
              onChange: (event) => setEditor((current) => ({ ...current, instruction: event.target.value }))
            }),
            h("span", { className: "dsh-po-hint" }, form.instruction.length + " / 8000")),
          editorError === "" ? null : h("span", { className: "dsh-po-error" }, editorError),
          h("div", { className: "dsh-po-row" },
            actionButton("保存", () => saveEditor(form), { primary: true, disabled: saving }),
            actionButton("取消", cancelEditor))
        )
      }

      const promptCard = (prompt) => {
        const isDefault = config.defaultId === prompt.id
        if (editor !== null && editor.mode === "edit" && editor.id === prompt.id) return editorCard()
        return h("div", { className: "dsh-po-card", key: prompt.id },
          h("div", { className: "dsh-po-card-head" },
            h("span", { className: "dsh-po-name" }, prompt.name),
            isDefault ? h("span", { className: "dsh-po-badge" }, "默认") : null,
            h("div", { className: "dsh-po-actions" },
              isDefault ? null : actionButton("设为默认", () => setDefault(prompt.id), {
                primary: true,
                disabled: saving,
                title: "优化提示词时使用这一条"
              }),
              actionButton("编辑", () => startEdit(prompt), { disabled: saving }),
              actionButton("测试", () => {
                setTest((current) => ({ ...current, id: prompt.id, output: "", error: "" }))
                setTab("test")
              }),
              confirmId === prompt.id
                ? actionButton("确认删除", () => removePrompt(prompt.id), { danger: true, disabled: saving })
                : actionButton("删除", () => setConfirmId(prompt.id), { danger: true, disabled: saving }))),
          h("div", { className: "dsh-po-text" }, prompt.instruction)
        )
      }

      const builtinCard = () => h("div", { className: "dsh-po-card", key: "builtin" },
        h("div", { className: "dsh-po-card-head" },
          h("span", { className: "dsh-po-name" }, builtin.name || FALLBACK_BUILTIN.name),
          config.defaultId === "" ? h("span", { className: "dsh-po-badge" }, "默认") : null,
          h("div", { className: "dsh-po-actions" },
            config.defaultId === "" ? null : actionButton("设为默认", () => setDefault(""), {
              primary: true,
              disabled: saving,
              title: "优化提示词时使用内置指令"
            }),
            actionButton(showBuiltin ? "收起" : "查看", () => setShowBuiltin(!showBuiltin)))),
        showBuiltin
          ? h("pre", { className: "dsh-po-preview" }, builtin.instruction)
          : h("div", { className: "dsh-po-hint" }, "插件自带的默认指令；未选择自定义提示词时生效。")
      )

      const manageTab = () => h("div", { className: "dsh-po-list" },
        editor !== null && editor.mode === "create" ? editorCard() : null,
        builtinCard(),
        config.prompts.length === 0 && (editor === null || editor.mode !== "create")
          ? h("div", { className: "dsh-po-empty" }, "还没有自定义提示词，新增一条后即可设为默认。")
          : config.prompts.map(promptCard),
        h("div", { className: "dsh-po-row" },
          actionButton("新增提示词", startCreate, { primary: true, disabled: saving || editor !== null }),
          saving ? h("span", { className: "dsh-po-hint" }, "保存中…") : null,
          !saving && saved ? h("span", { className: "dsh-po-ok" }, "已保存") : null,
          !saving && !saved && config.defaultId !== "" ? h("span", { className: "dsh-po-hint" }, "当前默认：" + (config.prompts.find((prompt) => prompt.id === config.defaultId) || {}).name) : null)
      )

      const testTab = () => h("div", { className: "dsh-po-list" },
        h("div", { className: "dsh-po-field" },
          h("label", { className: "dsh-po-label", htmlFor: "dsh-po-test-select" }, "要测试的提示词"),
          h("select", {
            id: "dsh-po-test-select",
            className: "dsh-po-input",
            value: test.id,
            onChange: (event) => setTest({ ...test, id: event.target.value, output: "", error: "" })
          },
            h("option", { value: "" }, (builtin.name || FALLBACK_BUILTIN.name) + "（内置）"),
            config.prompts.map((prompt) => h("option", { key: prompt.id, value: prompt.id },
              prompt.name + (config.defaultId === prompt.id ? "（默认）" : ""))))),
        h("div", { className: "dsh-po-field" },
          h("label", { className: "dsh-po-label", htmlFor: "dsh-po-test-input" }, "测试输入"),
          h("textarea", {
            id: "dsh-po-test-input",
            className: "dsh-po-textarea",
            rows: 4,
            value: test.input,
            placeholder: "输入一段提示词，看看它会被优化成什么样…",
            onChange: (event) => setTest({ ...test, input: event.target.value })
          })),
        h("div", { className: "dsh-po-row" },
          actionButton(test.running ? "测试中…" : "开始测试", () => { void runTest() }, {
            primary: true,
            disabled: test.running || test.input.trim() === "" || selectedTest === undefined
          }),
          h("span", { className: "dsh-po-hint" }, "调用当前激活模型，测试不会保存任何改动。")),
        test.error === "" ? null : h("span", { className: "dsh-po-error" }, test.error),
        test.output === ""
          ? null
          : h("div", { className: "dsh-po-field" },
            h("div", { className: "dsh-po-row" },
              h("span", { className: "dsh-po-label" }, "优化结果"),
              actionButton("复制", copyOutput)),
            h("pre", { className: "dsh-po-preview" }, test.output))
      )

      return h("div", { className: "dsh-po-section" },
        h("div", { className: "dsh-po-head" },
          h("span", { className: "dsh-po-title" }, "提示词优化"),
          h("span", { className: "dsh-po-desc" }, "管理优化时使用的提示词；标记为默认的一条会在点击 ✨ 时生效。")),

        h("div", { className: "dsh-po-tabs", role: "tablist" },
          h("button", {
            type: "button", role: "tab", "aria-selected": tab === "prompts",
            className: "dsh-po-tab" + (tab === "prompts" ? " dsh-po-tab-active" : ""),
            onClick: () => setTab("prompts")
          }, "提示词"),
          h("button", {
            type: "button", role: "tab", "aria-selected": tab === "test",
            className: "dsh-po-tab" + (tab === "test" ? " dsh-po-tab-active" : ""),
            onClick: () => setTab("test")
          }, "测试")),

        status === "loading" ? h("span", { className: "dsh-po-hint" }, "正在加载配置…") : null,
        status === "error"
          ? h("div", { className: "dsh-po-row" },
            h("span", { className: "dsh-po-error" }, "配置加载失败：" + error),
            actionButton("重试", load))
          : null,
        status === "ready" ? (tab === "prompts" ? manageTab() : testTab()) : null,
        status === "ready" && error !== "" ? h("span", { className: "dsh-po-error" }, error) : null
      )
    }

    // ------------------------------------------------------------------ apply

    function apply(ctx) {
      // 幂等样式注入：存在则刷新内容（HMR 只重放模块不重载页面时，旧写法会让新 CSS 失效）。
      let style = document.getElementById(STYLE_ID)
      if (style === null) {
        style = document.createElement("style")
        style.id = STYLE_ID
        style.setAttribute("data-plugin", "dsh-prompt-optimizer")
        document.head.appendChild(style)
      }
      style.textContent = CSS

      const slots = ctx.get("slots")
      if (slots === undefined) return

      slots.inject("conversation.input.left", () => slots.register(
        { name: "conversation.input.left", id: "dsh-prompt-optimizer" },
        (props) => react.createElement(OptimizeButton, props)
      ))

      // 设置页「提示词」：与输入框按钮同属一个插件，配置由 Host 半持久化。
      slots.inject("settings.section", () => slots.register({
        name: "settings.section",
        id: "dsh-prompt-optimizer",
        order: 58,
        label: () => "提示词"
      }, () => react.createElement(PromptSettingsSection)))
    }

    return { inject, apply }
  }
})
