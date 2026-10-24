/**
 * dsh-prompt-optimizer — prompt optimizer (client half)
 *
 * 在输入框工具行左侧注册一个图标按钮：点击后 POST /api/prompt-optimizer
 * 优化当前草稿并回填。界面不显示说明文字，仅在悬停时通过 title 展示；
 * 优化中按钮切换为旋转图标（不再叠加第二条横线动画）；成功后图标平滑
 * 切换为「撤销」图标，点击即把草稿还原为点击前的原文。
 *
 * ✨ 旁的紧凑单选触发器列出「默认」与所有自定义提示词，每项标明
 * 是否支持图片输入；选中项即设为默认，并直接决定 ✨ 是否携带草稿图片。
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
    /** 可作为图片输入提交的媒体类型，与 Host 半的白名单保持一致。 */
    const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    /** Host 未返回内置提示词时的兜底文案，与 lib/prompts.js 保持一致。 */
    const FALLBACK_BUILTIN = {
      id: "",
      name: "默认",
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

      // ------------------------------------------------------ 优化提示词单选
      // 触发器与 ✨ 同高（28px），只占一个按钮宽度；选项放在向上浮层里，
      // 不改变输入框、工具行高度或右侧发送区布局。
      ".dsh-po-composer-controls{display:inline-flex;align-items:center;gap:2px;height:28px;flex:none}",
      ".dsh-po-picker-wrap{position:relative;display:inline-flex;align-items:center;height:28px;flex:none}",
      ".dsh-po-choice{display:inline-flex;align-items:center;justify-content:flex-start;gap:5px;max-width:132px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer;padding:0 4px 0 3px;font:inherit;font-size:12px;line-height:18px}",
      ".dsh-po-choice-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#666)}",
      ".dsh-po-choice:hover:not(:disabled) .dsh-po-choice-title,.dsh-po-choice-open .dsh-po-choice-title{color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-choice:hover:not(:disabled),.dsh-po-choice-open{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,0.06));color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-choice:disabled{cursor:not-allowed;opacity:.45}",
      ".dsh-po-choice-chevron{display:inline-flex;align-items:center;justify-content:center;margin-left:-1px}",
      ".dsh-po-choice:focus-visible,.dsh-po-popover-retry:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#222);outline-offset:1px}",
      ".dsh-po-popover-backdrop{position:fixed;inset:0;z-index:40}",
      ".dsh-po-popover{position:absolute;left:0;bottom:calc(100% + 8px);z-index:41;box-sizing:border-box;width:max-content;min-width:168px;max-width:min(248px,calc(100vw - 24px));display:flex;flex-direction:column;gap:2px;padding:4px;border:none;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#3a3a3c);color:var(--dsw-alias-label-primary,#f9fafb);box-shadow:0 14px 36px rgba(0,0,0,.34);font-size:13px;line-height:18px}",
      ".dsh-po-options{display:flex;flex-direction:column;gap:2px;max-height:280px;overflow:auto}",
      ".dsh-po-option{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:36px;padding:0 6px 0 8px;border-radius:8px;cursor:pointer}",
      ".dsh-po-option:hover,.dsh-po-option-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsh-po-option-selected{background:rgba(127,127,127,.18)}",
      ".dsh-po-option:focus-within{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsh-po-option-main{display:flex;align-items:center;min-width:0;flex:0 1 auto;cursor:pointer;overflow:hidden}",
      ".dsh-po-option-main>input{position:absolute;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;overflow:hidden}",
      ".dsh-po-option-main>input:disabled{cursor:progress}",
      ".dsh-po-option-body{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto}",
      ".dsh-po-option-name{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:176px}",
      ".dsh-po-option-kind{font-size:10px;line-height:16px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent);color:var(--dsw-alias-label-secondary,#bcbcbe);white-space:nowrap}",
      // 每行末尾的原生 checkbox，视觉做成 28x16 的 toggle。
      ".dsh-po-switch{position:relative;display:inline-flex;align-items:center;flex:none;cursor:pointer}",
      ".dsh-po-switch-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
      ".dsh-po-switch-track{box-sizing:border-box;display:inline-flex;align-items:center;width:28px;height:16px;padding:2px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 24%,transparent);transition:background-color .16s ease}",
      ".dsh-po-switch-thumb{width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-label-secondary,#bcbcbe);transition:transform .16s ease,background-color .16s ease}",
      ".dsh-po-switch-input:checked+.dsh-po-switch-track{background:var(--dsw-alias-state-success-primary,#4ade80)}",
      ".dsh-po-switch-input:checked+.dsh-po-switch-track .dsh-po-switch-thumb{transform:translateX(12px);background:var(--dsw-alias-bg-base,#2c2c2e)}",
      ".dsh-po-switch-input:focus-visible+.dsh-po-switch-track{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:2px}",
      ".dsh-po-switch-input:disabled+.dsh-po-switch-track{cursor:progress;opacity:.6}",
      "@media (prefers-reduced-motion:reduce){.dsh-po-switch-track,.dsh-po-switch-thumb{transition:none}}",
      ".dsh-po-popover-error{font-size:11px;line-height:16px;padding:2px 8px 4px;color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-popover-retry{font:inherit;font-size:11px;line-height:16px;text-align:left;color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;border:none;padding:0 2px;cursor:pointer;text-decoration:underline}",


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
      ".dsh-po-check{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#222)}",
      ".dsh-po-check input{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-file{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer}",
      ".dsh-po-file-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
      ".dsh-po-file-button{font-size:12px;color:var(--dsw-alias-label-primary,#222);background:transparent;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);border-radius:6px;padding:3px 10px}",
      ".dsh-po-file-input:focus-visible+.dsh-po-file-button{outline:2px solid var(--dsw-alias-label-primary,#222);outline-offset:1px}",
      ".dsh-po-file-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}",
      ".dsh-po-file-picked{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      ".dsh-po-thumb{width:44px;height:44px;object-fit:cover;border-radius:6px;border:.5px solid var(--dsw-alias-border-l2,#6a6a6c);flex:none}",
      ".dsh-po-file-name{font-size:12px;color:var(--dsw-alias-label-secondary,#666);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
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

    /** 单选触发器图标：外圈 + 实心圆心，和工具栏 28px 图标保持同一视觉重量。 */
    function RadioDotIcon() {
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 16 16", fill: "none",
        "aria-hidden": true
      },
        h("circle", { cx: 8, cy: 8, r: 5.7, stroke: "currentColor", strokeWidth: 1.5 }),
        h("circle", { cx: 8, cy: 8, r: 2.1, fill: "currentColor" })
      )
    }

    /** 紧凑下拉箭头，提示该图标会展开单选列表。 */
    function ChevronDownIcon() {
      return h("svg", {
        width: 8, height: 8, viewBox: "0 0 8 8", fill: "none",
        "aria-hidden": true
      },
        h("path", {
          d: "M1.5 2.75 4 5.25l2.5-2.5",
          stroke: "currentColor", strokeWidth: 1.4, strokeLinecap: "round", strokeLinejoin: "round"
        })
      )
    }

    /** 稳定 selector：返回字符串原始值，配合 useSyncExternalStoreWithSelector 无订阅抖动。 */
    const selectDraft = (s) => s && typeof s.draft === "string" ? s.draft : ""

    /**
     * 稳定 selector：草稿附件的 id 列表。
     *
     * `InputState.attachmentIds` 是宿主下发的运行时 id（图片字节不在状态里），
     * 这里按引用比较挑选，避免每次渲染都产生新数组导致无谓重渲染。
     */
    const EMPTY_IDS = []
    const selectAttachmentIds = (s) => {
      if (s === null || typeof s !== "object") return EMPTY_IDS
      const ids = s.attachmentIds
      return Array.isArray(ids) ? ids : EMPTY_IDS
    }

    /** 由 apply 写入：给组件用的 Cordis context（读 conversation 服务）。 */
    let runtimeCtx = null

    /** 空配置：未保存任何自定义提示词时，默认项处于选中状态。 */
    const EMPTY_CONFIG = { defaultId: "", prompts: [] }

    /**
     * 输入框工具栏与设置页共享的提示词目录。
     *
     * 设置页保存后也会写回这里，因此工具栏的单选状态和 ✨ 的图片门槛
     * 始终以同一份数据为准。组件通过 subscribe 获得更新。
     */
    const promptCatalog = {
      state: {
        status: "idle", // idle | loading | ready | error
        config: EMPTY_CONFIG,
        builtin: FALLBACK_BUILTIN,
        capabilities: { image: false },
        error: ""
      },
      listeners: new Set(),
      pending: null
    }

    /** @returns the current catalog snapshot. */
    function catalogState() {
      return promptCatalog.state
    }

    /** Replace part of the catalog and synchronously notify every mounted reader. */
    function setCatalogState(patch) {
      promptCatalog.state = { ...promptCatalog.state, ...patch }
      for (const listener of promptCatalog.listeners) {
        try { listener(promptCatalog.state) } catch { /* a dead reader must not break others */ }
      }
    }

    /** Subscribe to catalog updates; returns the unsubscribe function. */
    function subscribeCatalog(listener) {
      promptCatalog.listeners.add(listener)
      return () => { promptCatalog.listeners.delete(listener) }
    }

    /** Accept a host response without discarding capabilities when a save omits them. */
    function syncCatalog(data) {
      if (data === null || typeof data !== "object" || data.config === null || typeof data.config !== "object") return
      const builtin = data.builtin !== null && typeof data.builtin === "object" && typeof data.builtin.instruction === "string"
        ? data.builtin
        : promptCatalog.state.builtin
      const capabilities = data.capabilities !== null && typeof data.capabilities === "object"
        ? { image: data.capabilities.image === true }
        : promptCatalog.state.capabilities
      setCatalogState({ status: "ready", config: data.config, builtin: builtin, capabilities: capabilities, error: "" })
    }

    /** Load the catalog once; concurrent readers share the same request. */
    function loadCatalog() {
      if (promptCatalog.pending !== null) return promptCatalog.pending
      setCatalogState({ status: "loading", error: "" })
      const request = (async () => {
        try {
          const res = await fetch(CONFIG_URL, { cache: "no-store" })
          const data = await res.json().catch(() => null)
          if (!res.ok) {
            const message = data && typeof data.error === "string" ? data.error : ("HTTP " + res.status)
            throw new Error(message)
          }
          if (data === null || typeof data !== "object" || data.config === null || typeof data.config !== "object") {
            throw new Error("配置响应格式无效")
          }
          syncCatalog(data)
        } catch (cause) {
          setCatalogState({
            status: "error",
            error: cause instanceof Error ? cause.message : String(cause)
          })
        } finally {
          promptCatalog.pending = null
        }
      })()
      promptCatalog.pending = request
      return request
    }

    /** Built-in + saved prompts, in the same order as the Settings page. */
    function catalogOptions(state = promptCatalog.state) {
      const prompts = state !== null && state.config !== null && Array.isArray(state.config.prompts) ? state.config.prompts : []
      return [
        {
          id: "",
          name: state.builtin && typeof state.builtin.name === "string" && state.builtin.name !== ""
            ? state.builtin.name
            : FALLBACK_BUILTIN.name,
          instruction: state.builtin && typeof state.builtin.instruction === "string" && state.builtin.instruction !== ""
            ? state.builtin.instruction
            : FALLBACK_BUILTIN.instruction,
          useImages: state !== null && typeof state === "object" && state.config !== null && state.config.builtinUseImages === true,
          builtin: true
        },
        ...prompts.map((prompt) => ({
          id: prompt.id,
          name: prompt.name,
          instruction: typeof prompt.instruction === "string" ? prompt.instruction : "",
          useImages: prompt.useImages === true,
          builtin: false
        }))
      ]
    }

    /** The option the ✨ button will actually use (a stale default falls back to built-in). */
    function activeCatalogOption(state = promptCatalog.state) {
      const options = catalogOptions(state)
      const defaultId = state.config && typeof state.config.defaultId === "string" ? state.config.defaultId : ""
      return options.find((option) => option.id === defaultId) || options[0]
    }

    /**
     * Per-option image capability: both the prompt's own `useImages` opt-in
     * and the active model's declared image modality must be true.
     */
    function imageSupportFor(option, capabilities) {
      if (option.useImages !== true) {
        return { allowed: false, saved: false, label: "不支持图片输入", detail: "开关已关闭，只发送文本" }
      }
      if (capabilities === null || typeof capabilities !== "object" || capabilities.image !== true) {
        return { allowed: false, saved: true, label: "暂不支持（模型无图片能力）", detail: "开关已保存；当前模型未声明图片输入能力，暂不发送图片" }
      }
      return { allowed: true, saved: true, label: "支持图片输入", detail: "草稿中的图片会随提示词一起发送" }
    }

    /** The image policy of the currently selected prompt, read at click time. */
    function activeImageSupport() {
      const state = promptCatalog.state
      return imageSupportFor(activeCatalogOption(state), state.capabilities)
    }

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

    /** 把一个浏览器 File 读成纯 base64（去掉 data URL 前缀）。 */
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const url = typeof reader.result === "string" ? reader.result : ""
          const comma = url.indexOf(",")
          if (comma < 0) { reject(new Error("无法读取该图片")); return }
          resolve({ data: url.slice(comma + 1), mediaType: file.type })
        }
        reader.onerror = () => reject(new Error("无法读取该图片"))
        reader.readAsDataURL(file)
      })
    }

    /**
     * 读取输入框里用户粘贴/拖入的图片。
     *
     * 图片由宿主 Conversation 服务持有（`InputState.attachmentIds` 只是 id），
     * 因此这里通过 `ctx.get("conversation")` 取回附件对象，再只挑出 image 类。
     * 任何一步不可用（旧宿主、服务未挂载、读取失败）都返回空数组，调用方据此
     * 静默退回纯文本，绝不抛出。
     *
     * @param ctx - client Cordis context.
     * @param ids - ordered draft attachment ids from the input state.
     * @returns ordered `{ data, mediaType, name }` list, possibly empty.
     */
    async function readDraftImages(ctx, ids) {
      if (!Array.isArray(ids) || ids.length === 0) return []
      const conversation = typeof ctx.get === "function" ? ctx.get("conversation") : undefined
      if (conversation === undefined || typeof conversation.resolveDraftAttachments !== "function") return []
      let attachments
      try {
        attachments = conversation.resolveDraftAttachments(ids)
      } catch {
        return []
      }
      if (!Array.isArray(attachments)) return []
      const images = []
      for (const attachment of attachments) {
        if (attachment === null || typeof attachment !== "object" || attachment.kind !== "image") continue
        const file = attachment.file
        if (file === undefined || file === null) continue
        try {
          const encoded = await fileToBase64(file)
          images.push({
            data: encoded.data,
            mediaType: encoded.mediaType,
            name: typeof file.name === "string" ? file.name : ""
          })
        } catch {
          // 单张失败不影响其余，最终仍按可用图片处理。
        }
      }
      return images
    }

    // ------------------------------------------------------------ 优化按钮

    /**
     * Subscribe a component to the shared prompt catalog.
     *
     * The store lives outside React because the toolbar, the Settings page and
     * the optimization click path all need the same selected prompt.
     * @returns the current catalog snapshot.
     */
    function usePromptCatalog() {
      const [snapshot, setSnapshot] = react.useState(catalogState)
      react.useEffect(() => subscribeCatalog(setSnapshot), [])
      react.useEffect(() => {
        if (catalogState().status === "idle") void loadCatalog()
      }, [])
      return snapshot
    }

    /**
     * Build the document that saves one option's image preference.
     *
     * Custom prompts live in `prompts[].useImages`; the built-in row has no prompt
     * object and uses the document-level `builtinUseImages` flag.
     * @param config - the current normalized document.
     * @param id - the option id, '' for built-in.
     * @param useImages - the requested switch value.
     */
    function configWithUseImages(config, id, useImages) {
      if (id === "") return { ...config, builtinUseImages: useImages === true }
      return {
        ...config,
        prompts: config.prompts.map((prompt) => prompt.id === id ? { ...prompt, useImages: useImages === true } : prompt)
      }
    }

    /**
     * Save the catalog after one user action, with optimistic update + rollback.
     *
     * `mutate` derives the next document at click time so two quick switches
     * cannot overwrite each other with a stale copy.
     *
     * @returns `{ ok, data?, error? }`; the caller owns any local feedback.
     */
    async function persistConfig(mutate) {
      const previousConfig = promptCatalog.state.config
      const nextConfig = mutate(previousConfig)
      setCatalogState({ config: nextConfig })
      try {
        const res = await fetch(CONFIG_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ config: nextConfig }),
          cache: "no-store"
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          const message = data && typeof data.error === "string" ? data.error : ("HTTP " + res.status)
          throw new Error(message)
        }
        if (data && typeof data === "object") syncCatalog(data)
        return { ok: true, data: data }
      } catch (cause) {
        setCatalogState({ config: previousConfig })
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
      }
    }

    /**
     * Compact single-choice control before the sparkle.
     *
     * One 28px trigger keeps the composer row unchanged until opened; the
     * popover exposes real radio options. Each option owns a switch that saves
     * that prompt's image preference, independently of which one is selected.
     */
    function PromptPicker(props) {
      const catalog = usePromptCatalog()
      const [open, setOpen] = react.useState(false)
      const [saving, setSaving] = react.useState(false)
      const [error, setError] = react.useState("")
      const options = catalogOptions(catalog)
      const active = activeCatalogOption(catalog)
      const activeSupport = imageSupportFor(active, catalog.capabilities)
      const currentDefaultId = catalog.config && typeof catalog.config.defaultId === "string"
        ? catalog.config.defaultId
        : ""

      /** Select one prompt as the default and close the menu on success. */
      const choose = async (id) => {
        if (saving) return
        if (id === currentDefaultId) { setOpen(false); setError(""); return }
        setSaving(true)
        setError("")
        const result = await persistConfig((config) => ({ ...config, defaultId: id }))
        setSaving(false)
        if (result.ok) setOpen(false)
        else setError(result.error)
      }

      /** Toggle one prompt's image preference without changing the selection. */
      const toggleImages = async (option, enabled) => {
        if (saving) return
        setSaving(true)
        setError("")
        const result = await persistConfig((config) => configWithUseImages(config, option.id, enabled))
        setSaving(false)
        if (!result.ok) setError(result.error)
      }

      const moveSelection = (delta) => {
        const index = options.findIndex((option) => option.id === active.id)
        const next = options[(index + delta + options.length) % options.length]
        if (next !== undefined) void choose(next.id)
      }

      const onMenuKeyDown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault()
          setOpen(false)
          setError("")
        } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          event.preventDefault()
          moveSelection(1)
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          event.preventDefault()
          moveSelection(-1)
        }
      }

      const label = "优化提示词选项：" + active.name + "（" + activeSupport.label + "）"
      return h("div", { className: "dsh-po-picker-wrap" },
        h("button", {
          type: "button",
          className: "dsh-po-choice" + (open ? " dsh-po-choice-open" : ""),
          title: label + "。点击切换",
          "aria-label": label,
          "aria-haspopup": "dialog",
          "aria-expanded": open,
          disabled: props.disabled === true,
          onClick: () => { setOpen((value) => !value); setError("") },
          onKeyDown: (event) => {
            if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              setOpen(true)
            } else if (event.key === "Escape") {
              setOpen(false)
            }
          }
        },
          h(RadioDotIcon),
          h("span", { className: "dsh-po-choice-title", title: active.name }, active.name),
          h("span", { className: "dsh-po-choice-chevron", "aria-hidden": true }, h(ChevronDownIcon))),
        open ? pickerPopover({
          catalog, options, active, saving, error, choose, toggleImages, onMenuKeyDown
        }) : null,
        open
          ? h("div", {
            className: "dsh-po-popover-backdrop",
            "aria-hidden": true,
            onClick: () => { setOpen(false); setError("") }
          })
          : null)
    }

    /**
     * The radio + per-row image switch menu inside the composer picker.
     */
    function pickerPopover({ catalog, options, active, saving, error, choose, toggleImages, onMenuKeyDown }) {
      return h("div", {
        className: "dsh-po-popover",
        role: "dialog",
        "aria-label": "优化提示词",
        onKeyDown: onMenuKeyDown
      },
        h("div", { className: "dsh-po-options", role: "radiogroup", "aria-label": "优化提示词选项" },
          options.map((option) => {
            const support = imageSupportFor(option, catalog.capabilities)
            const selected = option.id === active.id
            return h("div", {
              className: "dsh-po-option" + (selected ? " dsh-po-option-selected" : ""),
              key: option.id === "" ? "builtin" : option.id,
              // The whole row selects the prompt. The label below stops propagation
              // so a click on the visible text still goes through the native radio
              // exactly once, while clicks in the gap between text and switch work.
              onClick: () => { void choose(option.id) }
            },
              h("label", {
                className: "dsh-po-option-main",
                onClick: (event) => event.stopPropagation()
              },
                h("input", {
                  type: "radio",
                  name: "dsh-po-prompt",
                  value: option.id,
                  checked: selected,
                  disabled: saving,
                  onChange: () => { void choose(option.id) }
                }),
                h("span", { className: "dsh-po-option-body" },
                  h("span", { className: "dsh-po-option-name" }, option.name),
                  option.builtin ? h("span", { className: "dsh-po-option-kind" }, "内置") : null)),
              h("label", {
                className: "dsh-po-switch",
                title: support.detail,
                onClick: (event) => event.stopPropagation()
              },
                h("input", {
                  type: "checkbox",
                  role: "switch",
                  className: "dsh-po-switch-input",
                  checked: option.useImages === true,
                  disabled: saving,
                  "aria-label": option.name + "：允许图片输入",
                  "aria-checked": option.useImages === true,
                  onChange: (event) => { void toggleImages(option, event.target.checked === true) }
                }),
                h("span", { className: "dsh-po-switch-track", "aria-hidden": true },
                  h("span", { className: "dsh-po-switch-thumb" }))))
          })),
        error === "" ? null : h("span", { className: "dsh-po-popover-error" }, "保存失败：" + error),
        catalog.status === "error"
          ? h("button", {
            type: "button", className: "dsh-po-popover-retry",
            onClick: () => { void loadCatalog() }
          }, "配置加载失败，重试")
          : null)
    }

    function OptimizeButton(props) {
      const [busy, setBusy] = react.useState(false)
      // 撤销态：记录本次优化前后的草稿。仅当草稿仍是优化结果时图标才显示为撤销，
      // 用户手动改写后自然回到 ✨，避免“撤销”覆盖用户自己的编辑。
      const [undo, setUndo] = react.useState(null)
      // 当前 session 的草稿附件 id（含用户粘贴的图片）。旧宿主没有该字段时为空数组。
      const attachmentIds = typeof props.useInput === "function"
        ? props.useInput(selectAttachmentIds)
        : selectAttachmentIds(props.input)
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
          // 是否附带图片由当前选中的提示词与模型能力共同决定；任一不满足
          // 都只发文本，与旧行为完全一致。
          const body = { text: text }
          if (activeImageSupport().allowed) {
            const images = await readDraftImages(runtimeCtx, attachmentIds)
            if (images.length > 0) body.image = images
          }
          const res = await fetch("/api/prompt-optimizer", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
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

      return h("div", { className: "dsh-po-composer-controls" },
        h(PromptPicker, { disabled: busy }),
        h("button", {
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
      // 图片输入是可选项：默认不启用，仅在模型能力声明 image 时才提供勾选框。
      const [image, setImage] = react.useState({
        enabled: false, data: "", mediaType: "", name: "", previewUrl: ""
      })
      // 能力来自 Host 的 capabilities.image；未知或读取失败一律按「不支持」处理。
      const [capabilities, setCapabilities] = react.useState({ image: false })
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
            // 能力标识由 Host 依据模型 inputModalities 解析；缺失即视为不支持。
            setCapabilities({ image: Boolean(data.capabilities && data.capabilities.image === true) })
            syncCatalog(data)
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

      // The composer picker writes to the same catalog. Keep an open Settings
      // page in sync so its "默认" badge and test selector never go stale.
      react.useEffect(() => subscribeCatalog((snapshot) => {
        if (snapshot.status !== "ready") return
        if (snapshot.config === null || typeof snapshot.config !== "object") return
        setConfig(snapshot.config)
      }), [])

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
            syncCatalog(data)
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
        setEditor({ mode: "create", id: "", name: "", instruction: "", useImages: false })
        setEditorError("")
        setConfirmId(null)
      }

      const startEdit = (prompt) => {
        setEditor({
          mode: "edit",
          id: prompt.id,
          name: prompt.name,
          instruction: prompt.instruction,
          useImages: prompt.useImages === true
        })
        setEditorError("")
        setConfirmId(null)
      }

      const cancelEditor = () => { setEditor(null); setEditorError("") }

      const saveEditor = (form) => {
        const name = form.name.trim()
        const instruction = form.instruction.trim()
        if (name === "") { setEditorError("请填写名称"); return }
        if (instruction === "") { setEditorError("请填写提示词内容"); return }
        const useImages = form.useImages === true
        const prompts = editor.mode === "edit"
          ? config.prompts.map((prompt) => prompt.id === editor.id ? { ...prompt, name: name, instruction: instruction, useImages: useImages } : prompt)
          : [...config.prompts, { id: editor.id === "" ? newPromptId() : editor.id, name: name, instruction: instruction, useImages: useImages }]
        setEditor(null)
        setEditorError("")
        void commit({ ...config, prompts: prompts })
      }

      const removePrompt = (id) => {
        setConfirmId(null)
        void commit({
          ...config,
          defaultId: config.defaultId === id ? "" : config.defaultId,
          prompts: config.prompts.filter((prompt) => prompt.id !== id)
        })
        // 被删除的提示词若正被测试选中，测试选择回落到「默认」。
        setTest((current) => current.id === id ? { ...current, id: "", output: "", error: "" } : current)
      }

      const selectedTest = test.id === "" ? builtin : config.prompts.find((prompt) => prompt.id === test.id)

      /**
       * 读取用户选中的图片为 data URL，供预览与提交使用。
       * 仅在能力支持且用户主动选择时才会被调用。
       * @param file - 用户通过文件选择器或拖拽提供的文件。
       */
      const chooseImage = (file) => {
        if (file === null || file === undefined || !capabilities.image || !image.enabled) return
        const mediaType = typeof file.type === "string" ? file.type : ""
        if (!IMAGE_MEDIA_TYPES.includes(mediaType)) {
          setTest((current) => ({ ...current, error: "仅支持 PNG / JPEG / WebP / GIF 图片" }))
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const url = typeof reader.result === "string" ? reader.result : ""
          const comma = url.indexOf(",")
          if (comma < 0) {
            setTest((current) => ({ ...current, error: "无法读取该图片" }))
            return
          }
          // data URL 自带完整字节，预览直接复用它，无需额外创建对象 URL。
          setImage((current) => ({
            ...current,
            data: url.slice(comma + 1),
            mediaType: mediaType,
            name: typeof file.name === "string" ? file.name : "",
            previewUrl: url
          }))
          setTest((current) => ({ ...current, error: "" }))
        }
        reader.onerror = () => setTest((current) => ({ ...current, error: "无法读取该图片" }))
        reader.readAsDataURL(file)
      }

      /** 清除已选图片，但保留勾选状态，方便重新挑一张。 */
      const clearImage = () => {
        setImage((current) => ({ ...current, data: "", mediaType: "", name: "", previewUrl: "" }))
      }

      const runTest = async () => {
        if (selectedTest === undefined || test.input.trim() === "" || test.running) return
        setTest((current) => ({ ...current, running: true, error: "", output: "" }))
        // 图片只在「支持 + 已勾选 + 确实选了文件」时才进入请求体；
        // 任一条件不满足，请求与原先的纯文本流程完全一致。
        const payload = { instruction: selectedTest.instruction, input: test.input }
        if (capabilities.image && image.enabled && image.data !== "") {
          payload.image = { data: image.data, mediaType: image.mediaType, name: image.name }
        }
        try {
          const res = await fetch(TEST_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
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
          // 「图片输入」是该条提示词自己的可选参数：勾选后，用这条提示词优化时
          // 会把输入框里粘贴的图片一并送去；不勾选则始终按纯文本处理。
          capabilities.image
            ? h("label", { className: "dsh-po-check" },
              h("input", {
                type: "checkbox",
                checked: form.useImages === true,
                onChange: (event) => setEditor((current) => ({ ...current, useImages: event.target.checked === true }))
              }),
              h("span", null, "允许图片输入（与输入框旁的开关共享同一设置）"))
            : h("span", { className: "dsh-po-hint" }, "当前模型不支持图片输入，此提示词只会以文本方式使用。"),
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
            prompt.useImages === true ? h("span", { className: "dsh-po-badge" }, "含图片") : null,
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
          capabilities.image
            ? h("label", { className: "dsh-po-check" },
              h("input", {
                type: "checkbox",
                checked: config.builtinUseImages === true,
                disabled: saving,
                onChange: (event) => {
                  void commit({ ...config, builtinUseImages: event.target.checked === true })
                }
              }),
              h("span", null, "允许图片输入"))
            : null,
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

      /**
       * 可选的图片输入区。
       *
       * 先给一个显式的「使用图片作为输入」勾选框，勾选后才出现「添加图片」；
       * 这样“可选”是看得见的选择，而不是一个容易被忽略的隐藏入口。
       */
      const imageField = () => h("div", { className: "dsh-po-field" },
        h("label", { className: "dsh-po-check" },
          h("input", {
            type: "checkbox",
            checked: image.enabled,
            onChange: (event) => {
              const enabled = event.target.checked === true
              setImage((current) => enabled ? { ...current, enabled: true } : {
                enabled: false, data: "", mediaType: "", name: "", previewUrl: ""
              })
              if (!enabled) setTest((current) => ({ ...current, output: current.output }))
            }
          }),
          h("span", null, "使用图片作为输入（可选）")),
        image.enabled
          ? (image.previewUrl === ""
            ? h("label", { className: "dsh-po-file" },
              h("input", {
                className: "dsh-po-file-input",
                type: "file",
                accept: IMAGE_MEDIA_TYPES.join(","),
                onChange: (event) => {
                  const files = event.target.files
                  const file = files && files.length > 0 ? files[0] : undefined
                  chooseImage(file)
                  // 允许重复选择同一个文件时仍然触发 change。
                  event.target.value = ""
                }
              }),
              h("span", { className: "dsh-po-file-button" }, "添加图片"),
              h("span", { className: "dsh-po-file-hint" }, "PNG / JPEG / WebP / GIF"))
            : h("div", { className: "dsh-po-file-picked" },
              h("img", { className: "dsh-po-thumb", src: image.previewUrl, alt: "已选择的参考图片" }),
              h("span", { className: "dsh-po-file-name", title: image.name }, image.name === "" ? "已选择图片" : image.name),
              actionButton("移除", clearImage)))
          : h("span", { className: "dsh-po-hint" }, "不勾选时按纯文本处理，与之前完全一致。"))

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
        // 图片输入整体只在模型声明支持 image 时出现；不支持时这里什么都不渲染，
        // 页面与纯文本版本完全一致，也不会提前触发任何图片相关请求。
        capabilities.image ? imageField() : null,
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
          h("span", { className: "dsh-po-desc" }, "管理优化时使用的提示词；标记为默认的一条会在点击 ✨ 时生效。"),
          // 图片入口在「测试」页签，这里给一句指引，避免在提示词页签找不到。
          capabilities.image
            ? h("span", { className: "dsh-po-hint" }, "想附带图片测试？切到「测试」页签，勾选「使用图片作为输入」。")
            : null),

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

      // 组件内通过它读取宿主 Conversation 服务上持有的草稿附件（粘贴的图片）。
      runtimeCtx = ctx

      /** 首次挂载加载一次提示词目录，工具行与设置页共用同一份快照。 */
      const syncCatalogOnMount = () => {
        void loadCatalog()
        return () => {}
      }
      if (typeof ctx.effect === "function") {
        ctx.effect(syncCatalogOnMount, "dsh-prompt-optimizer: prompt catalog sync")
      } else {
        // 极简宿主没有 effect 时也要工作：直接加载一次，不做卸载清理。
        void loadCatalog()
      }
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
