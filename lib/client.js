/**
 * dsh-prompt-optimizer — prompt optimizer (client half)
 *
 * 在输入框工具行左侧注册一个图标按钮：点击后 POST /api/prompt-optimizer
 * 优化当前草稿并回填。界面不显示说明文字，仅在悬停时通过 title 展示。
 * 图标是 fill:currentColor 的单色星芒（不是彩色 emoji），因此悬停、禁用与
 * 深浅主题都自动跟随；优化中原样保留这枚图标，只叠加呼吸动画（不换图标、
 * 不加文字），成功后平滑切换为「撤销」，点击即还原为点击前的原文。
 *
 * 星芒旁的紧凑触发器只显示「当前提示词标题 + 箭头」，点开是同一份提示词列表，
 * 每项标明是否支持图片输入；选中项即设为默认，并决定优化请求是否携带草稿图片。
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
    /**
     * react-dom 是可选的：宿主把它一并提供给客户端模块时，提示词浮层会挂到
     * `document.body` 上（输入框工具行所在的容器可能被裁剪或带滚动）；拿不到就
     * 退回在触发器里原地渲染 —— 两条路径渲染的是同一份浮层内容。
     */
    let createPortal = null
    try {
      const reactDom = require("react-dom")
      if (reactDom !== null && reactDom !== undefined && typeof reactDom.createPortal === "function") {
        createPortal = reactDom.createPortal
      }
    } catch {
      createPortal = null
    }

    const STYLE_ID = "dsh-prompt-optimizer-style"
    /** 配置读写与测试接口（Host 半注册的精确路由）。 */
    const CONFIG_URL = "/api/prompt-optimizer/config"
    const TEST_URL = "/api/prompt-optimizer/test"
    /** 可作为图片输入提交的媒体类型，与 Host 半的白名单保持一致。 */
    const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"]
    /** 浮层最宽 260px（与 .dsh-po-popover 的 max-width 一致），用来把锚点夹在视口内。 */
    const POPOVER_MAX_WIDTH = 260
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
      // ------------------------------------------------------------ 动效 token
      // 插件的全部动效共用这一套时长与曲线（技能: motion-consistency）：
      // 调一个值就能整体提速/放慢，工具栏与设置页的手感也不会各走各的。
      // 时长按「距离 × 复杂度」分档，而不是把同一个 200ms 套到所有过渡上
      // （技能: duration-timing）：tap 90ms 是按下这种零距离反馈，fast 120ms
      // 是配色与描边的状态切换，base 180ms 是控件形态切换（开关、选中条、
      // tab 下划线回位），enter 220ms 是整块内容进场，breathe 2.4s 是加载循环。
      // 曲线按方向分（技能: easing）：进场减速、状态切换两端缓、回弹只给位移，
      // 匀速曲线留给真正的等速循环。
      // 变量挂在两个插件根节点上而不是 :root —— 不污染宿主主题，也不会被别的
      // 插件同名变量覆盖（都带 dsh-po- 前缀）。
      ".dsh-po-composer-controls,.dsh-po-section{--dsh-po-dur-tap:90ms;--dsh-po-dur-fast:120ms;--dsh-po-dur-base:180ms;--dsh-po-dur-enter:220ms;--dsh-po-dur-breathe:2.4s;--dsh-po-ease-out:cubic-bezier(.16,.84,.44,1);--dsh-po-ease-standard:cubic-bezier(.2,0,0,1);--dsh-po-ease-spring:cubic-bezier(.34,1.28,.44,1);--dsh-po-ease-soft:cubic-bezier(.45,0,.55,1)}",
      // 内容进场的两种基本动作：块级「浮起 + 淡入」、行内「淡入」。
      // 都只动 transform / opacity（技能: transform-performance），并且靠 CSS
      // 在元素插入的同一帧起跑 —— 不需要 JS 计时，也就不会阻塞主线程。
      "@keyframes dsh-po-rise-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}",
      "@keyframes dsh-po-fade-in{from{opacity:0}to{opacity:1}}",

      // ---------------------------------------------------------------- 按钮
      // overflow 不能 hidden：呼吸态的辉光是画在盒子外的，裁掉就只剩一个不动的星。
      // 配色与缩放分开计时：配色是状态切换，按下是即时反馈，后者必须更快。
      // filter 一起过渡，禁用的去色与加载恢复才不会一瞬间切开。
      ".dsh-po-btn{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#bcbcbe);cursor:pointer;padding:0;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),transform var(--dsh-po-dur-tap,90ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)),filter var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-btn:active:not(:disabled){transform:scale(.94)}",
      ".dsh-po-btn:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:1px}",
      ".dsh-po-btn:disabled{cursor:not-allowed;filter:grayscale(1)}",
      ".dsh-po-btn.dsh-po-busy:disabled{cursor:progress;filter:none;color:var(--dsw-alias-label-primary,#f9fafb)}",
      // 图标只在「✨ → 撤销」换位时重挂载，所以这里只负责进场：起点缩放收到
      // .84、时间压到 base 档，旧图标被替换后不会出现一段明显的空档。
      ".dsh-po-glyph{display:inline-flex;align-items:center;justify-content:center;animation:dsh-po-glyph-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      "@keyframes dsh-po-glyph-in{from{opacity:0;transform:scale(.84) rotate(-6deg)}to{opacity:1;transform:none}}",
      // 星芒是单色 SVG（fill:currentColor），视觉重量和工具栏其余线性图标一致；
      // 加载时仍是同一枚，只叠加呼吸。辉光用 currentColor，深浅主题各自成立。
      // 请求结束时呼吸动画被摘掉，辉光会从 drop-shadow 硬切成 none —— 这条过渡
      // 把那层光按 base 档淡出，收尾不是「啪」地一下。transform 按规范不会因此
      // 补过渡（before-change style 不含动画效果），所以这里只管辉光。
      ".dsh-po-spark{display:block;width:15px;height:15px;transform-origin:50% 50%;fill:currentColor;transition:filter var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      // 关键帧只改 transform（scale/rotate）：走合成器，不逐帧重绘；辉光是静态滤镜。
      // 呼吸是等速循环，缓存后的 ease-soft 在这里比缓入缓出更稳定；
      // 渐变只做 transform 与静态 drop-shadow，不动布局也不逐帧重绘。
      ".dsh-po-btn.dsh-po-busy .dsh-po-spark{animation:dsh-po-breathe var(--dsh-po-dur-breathe,2.4s) var(--dsh-po-ease-soft,cubic-bezier(.45,0,.55,1)) infinite;filter:drop-shadow(0 0 3px currentColor)}",
      // 峰值收窄到 1.03 / 4.5°：工具栏 28px 的按钮里，振幅再大就会碰到相邻图标。
      // 中间帧补到 0.92 / 1.0 两档，相邻关键帧的间距变均匀 —— 这样在任何一帧
      // 中断，图标离静止位都不远，收尾不会出现明显的"弹一下"。
      "@keyframes dsh-po-breathe{0%{transform:scale(.92) rotate(-4.5deg)}23%{transform:scale(1.02) rotate(3deg)}46%{transform:scale(1.03) rotate(3.5deg)}62%{transform:scale(1) rotate(1deg)}78%{transform:scale(.97) rotate(-1.5deg)}100%{transform:scale(.92) rotate(-4.5deg)}}",
      ".dsh-po-btn.dsh-po-undo{color:var(--dsw-alias-label-primary,#f9fafb)}",
      // 失败反馈：图标短暂染成错误色并左右轻摆两次（只动 transform），同时在
      // 按钮上方弹出一条说明。原先失败只写 console，用户看到的是「点了没反应」。
      ".dsh-po-btn.dsh-po-failed{color:var(--dsw-alias-state-error-primary,#f87171);animation:dsh-po-shake 320ms var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      "@keyframes dsh-po-shake{0%,100%{transform:none}20%{transform:translateX(-2px)}40%{transform:translateX(2px)}60%{transform:translateX(-1.5px)}80%{transform:translateX(1px)}}",
      // ✨ 与提示气泡的定位容器：气泡和浮层同一种实体面板语言（描边 + 阴影 + 12px 圆角）。
      ".dsh-po-run{position:relative;display:inline-flex;align-items:center;height:28px;flex:none}",
      ".dsh-po-toast{position:absolute;left:0;bottom:calc(100% + 8px);z-index:42;box-sizing:border-box;width:max-content;max-width:min(280px,calc(100vw - 24px));display:flex;align-items:flex-start;gap:6px;padding:7px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2,#3a3a3c);color:var(--dsw-alias-label-primary,#f9fafb);border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 11%,transparent);box-shadow:0 10px 28px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);font-size:12px;line-height:18px;text-wrap:pretty;word-break:break-word;cursor:default;transform-origin:bottom left;animation:dsh-po-pop-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      ".dsh-po-toast-icon{display:inline-flex;flex:none;margin-top:2px}",
      ".dsh-po-toast-error .dsh-po-toast-icon{color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-toast-info .dsh-po-toast-icon{color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 只给读屏器的文字：视觉上不占位，状态变化（优化中 / 已优化 / 已撤销）照样播报。
      ".dsh-po-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}",

      // ------------------------------------------------------ 优化提示词单选
      // 触发器与 ✨ 同高（28px），只占一个按钮宽度；选项放在向上浮层里，
      // 不改变输入框、工具行高度或右侧发送区布局。
      ".dsh-po-composer-controls{display:inline-flex;align-items:center;gap:2px;height:28px;flex:none}",
      ".dsh-po-picker-wrap{position:relative;display:inline-flex;align-items:center;height:28px;flex:none}",
      // 悬停底色是状态切换（fast 档）；按下缩放是即时反馈，单独走 tap 档，
      // 否则按下要等一个完整的配色时长才有反应。
      ".dsh-po-choice{display:inline-flex;align-items:center;gap:5px;max-width:148px;height:28px;flex:none;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#bcbcbe);cursor:pointer;padding:0 6px 0 7px;font:inherit;font-size:12px;line-height:18px;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),transform var(--dsh-po-dur-tap,90ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      // 触发器只放标题 + 箭头，不放图标：
      // 空心圆点是「单选」的符号，而这里点开的是菜单；换成星芒又会和右侧执行按钮
      // 撞成两枚一样的图标。下拉的语义由箭头和 hover 底色表达已经足够。
      ".dsh-po-choice-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#bcbcbe);transition:color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-choice:hover:not(:disabled) .dsh-po-choice-title,.dsh-po-choice-open .dsh-po-choice-title{color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-choice:hover:not(:disabled),.dsh-po-choice-open{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,#f9fafb)}",
      // 按下时轻微内收：与 ✨ 一致，给出「已经收到点击」的即时反馈。
      ".dsh-po-choice:active:not(:disabled){transform:scale(.97)}",
      ".dsh-po-choice:disabled{cursor:not-allowed;opacity:.45}",
      ".dsh-po-choice:disabled .dsh-po-choice-title{color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 箭头是面板开关状态的唯一视觉线索：展开时翻 180°。
      // 它是「开 / 合」唯一的公共线索，所以它是唯一保留回弹的位移：
      // enter 档 + 轻微过冲，展开像弹开、收起像落回，两端都读得懂；
      // 过冲只作用在 transform 上，不会牵动周围布局。
      ".dsh-po-choice-chevron{display:inline-flex;align-items:center;justify-content:center;flex:none;margin-left:1px;transform:rotate(0deg);transition:transform var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-spring,cubic-bezier(.34,1.28,.44,1))}",
      ".dsh-po-choice-chevron-open{transform:rotate(180deg)}",
      ".dsh-po-choice:focus-visible,.dsh-po-popover-retry:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:1px}",
      ".dsh-po-choice:disabled:focus-visible{outline-color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 挂到 body 时的整屏容器：浮层按触发器的实测位置用 left / bottom 定位，
      // 因此不会被工具行的裁剪或滚动容器截断；遮罩与面板都在这一层里。
      ".dsh-po-layer{position:fixed;inset:0;z-index:40}",
      // 遮罩与面板同帧淡入：点外关闭的可点区域从第一帧就存在，
      // 只是视觉上随面板一起显形，避免面板已出现却找不到可点区域的割裂。
      ".dsh-po-popover-backdrop{position:fixed;inset:0;z-index:40;animation:dsh-po-fade-in var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      // 浮层：细描边 + 深阴影，做出浮起来的实体面板，而不是一块无边界色块。
      // 浮层从触发器一侧（bottom left）长出来，方向与「向上打开」一致：
      // 看到的是面板从按钮上抽出，而不是凭空闪出一块。
      // 进场走 enter 档 + 减速曲线；关闭时面板同步卸载（aria-expanded 必须
      // 立刻为 false），连续性交给触发器自己的箭头与底色反向过渡，不做
      // 「留在原地等退场动画」的遮罩 —— 状态正确性永远不依赖动画结束事件。
      ".dsh-po-popover{position:absolute;left:0;bottom:calc(100% + 8px);z-index:41;box-sizing:border-box;width:max-content;min-width:184px;max-width:min(260px,calc(100vw - 24px));display:flex;flex-direction:column;gap:2px;padding:5px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,#3a3a3c);color:var(--dsw-alias-label-primary,#f9fafb);border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 11%,transparent);box-shadow:0 10px 28px rgba(0,0,0,.34),0 1px 3px rgba(0,0,0,.22);font-size:13px;line-height:18px;transform-origin:bottom left;animation:dsh-po-pop-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      "@keyframes dsh-po-pop-in{from{opacity:0;transform:translateY(6px) scale(.96)}to{opacity:1;transform:none}}",
      ".dsh-po-options{display:flex;flex-direction:column;gap:1px;max-height:280px;overflow:auto}",
      // 行高、内边距、字号对齐宿主原生下拉（如权限菜单）；选中项只靠整行高亮底色表示，
      // 不再叠加勾号、竖条或其它记号。
      ".dsh-po-option{position:relative;display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;padding:0 6px 0 12px;border-radius:8px;cursor:pointer;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-option:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsh-po-option-selected{background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 8%,transparent)}",
      ".dsh-po-option:focus-within{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      // 键盘聚焦到隐藏的 radio 时，整行画一圈焦点环（鼠标点击不出现，跟随 focus-visible）。
      ".dsh-po-option:has(.dsh-po-option-main>input:focus-visible){box-shadow:inset 0 0 0 1.5px var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-option-main{display:flex;align-items:center;min-width:0;flex:0 1 auto;cursor:pointer;overflow:hidden}",
      ".dsh-po-option-main>input{position:absolute;width:1px;height:1px;margin:0;padding:0;border:0;opacity:0;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;overflow:hidden}",
      ".dsh-po-option-main>input:disabled{cursor:progress}",
      ".dsh-po-option-body{display:flex;align-items:center;gap:6px;min-width:0;flex:0 1 auto}",
      ".dsh-po-option-name{font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary,#f9fafb);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:176px}",
      ".dsh-po-option-kind{font-size:10px;line-height:15px;padding:0 5px;border-radius:4px;border:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 16%,transparent);color:var(--dsw-alias-label-secondary,#bcbcbe);white-space:nowrap}",
      // 每行末尾的原生 checkbox，视觉做成 28x16 的 toggle。
      ".dsh-po-switch{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:32px;min-height:32px;flex:none;cursor:pointer}",
      ".dsh-po-switch-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
      // 开关是形态切换（base 档）：轨道换底色 + 滑块位移同时发生，
      // 滑块带一点过冲，读起来像被「推」过去而不是瞬移。
      ".dsh-po-switch-track{box-sizing:border-box;display:inline-flex;align-items:center;width:28px;height:16px;padding:2px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 18%,transparent);transition:background-color var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-switch-thumb{width:12px;height:12px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 72%,transparent);transition:transform var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-spring,cubic-bezier(.34,1.28,.44,1)),background-color var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      // 打开态跟随文字色而不是荧光绿，并压到 60%：原生菜单里最亮的元素是文字和勾号，
      // 纯白的开关会抢走对当前选中哪一条的注意力。
      ".dsh-po-switch-input:checked+.dsh-po-switch-track{background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 60%,transparent)}",
      ".dsh-po-switch-input:checked+.dsh-po-switch-track .dsh-po-switch-thumb{transform:translateX(12px);background:var(--dsw-alias-bg-layer-2,#3a3a3c)}",
      ".dsh-po-switch-input:focus-visible+.dsh-po-switch-track{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:2px}",
      ".dsh-po-switch-input:disabled+.dsh-po-switch-track{cursor:progress;opacity:.6}",
      // 浮层底部的状态行（保存失败 / 加载中 / 加载失败重试）：与选项同一左缘（12px），
      // 浮层底色比页面亮一级，纯错误红在上面只有 4.1:1，所以向文字色混 28% 提到 AA 以上。
      // 顶部一条分隔线把它和选项区分开，不会被误读成又一条选项。
      ".dsh-po-popover-error{display:block;font-size:12px;line-height:16px;margin-top:3px;padding:6px 8px 4px 12px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent);color:var(--dsw-alias-state-error-primary,#f87171);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 72%,var(--dsw-alias-label-primary,#f9fafb));animation:dsh-po-fade-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      ".dsh-po-popover-retry{display:flex;align-items:center;gap:6px;width:100%;min-height:30px;margin-top:3px;font:inherit;font-size:12px;line-height:16px;text-align:left;color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;border:none;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent);border-radius:0 0 8px 8px;padding:6px 8px 4px 12px;cursor:pointer;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-popover-retry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}",
      ".dsh-po-popover-retry-error{color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-popover-loading{display:flex;align-items:center;gap:8px;margin-top:3px;padding:6px 8px 4px 12px;border-top:1px solid color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent);font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 加载占位条：一条在原位来回扫光的细条，表达「在取数据」而不是转圈。
      ".dsh-po-skeleton-bar{display:block;height:10px;border-radius:5px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent);background-image:linear-gradient(90deg,transparent 0,color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 9%,transparent) 50%,transparent 100%);background-size:200% 100%;background-repeat:no-repeat;animation:dsh-po-shimmer 1.4s linear infinite}",
      "@keyframes dsh-po-shimmer{from{background-position:150% 0}to{background-position:-50% 0}}",


      // ------------------------------------------------------------ 设置页
      // 版式基线（从本插件已用 token 与宿主实测值归纳，见 README「颜色约定」）：
      // 间距走 4px 网格（4 / 8 / 12 / 16 / 24）；圆角三档：控件与行 8px、
      // 卡片与浮层 12px、徽标胶囊 999px；控件统一 32px 高、页签 36px；
      // 描边：卡片 / 次要按钮用宿主同款 .5px border-l2，输入框用 1px（需 3:1 边界对比）。
      // container 让卡片按设置面板的实际宽度而不是视口宽度折行（面板常常比视口窄得多）。
      ".dsh-po-section{display:flex;flex-direction:column;gap:16px;padding:4px 0 24px;font-size:14px;line-height:22px;container-type:inline-size}",
      ".dsh-po-head{display:flex;flex-direction:column;gap:4px}",
      ".dsh-po-title{font-size:17px;font-weight:600;letter-spacing:-.01em;line-height:24px}",
      ".dsh-po-desc{max-width:62ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#bcbcbe);text-wrap:pretty}",
      // 页签栏：左侧页签、右侧保存状态。状态放在这里而不是列表最底部 ——
      // 列表一长，底部那行「保存失败」根本不在视野里。
      ".dsh-po-tabbar{display:flex;align-items:flex-end;justify-content:space-between;gap:4px 12px;flex-wrap:wrap;border-bottom:.5px solid var(--dsw-alias-border-l2,#464647)}",
      ".dsh-po-tabs{display:flex;gap:4px}",
      // Tab 的下划线用 inset 阴影画，所以它天然是「从下往上压出来」的：
      // 配色走 fast 档，下划线走 base 档，切换时像一条线滑到位再落定。
      ".dsh-po-tab{font:inherit;color:var(--dsw-alias-label-secondary,#bcbcbe);background:transparent;border:none;border-radius:8px 8px 0 0;min-height:36px;padding:6px 12px;cursor:pointer;transition:color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),box-shadow var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),transform var(--dsh-po-dur-tap,90ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      ".dsh-po-tab:hover{color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
      ".dsh-po-tab-active{color:var(--dsw-alias-label-primary,#f9fafb);font-weight:500;box-shadow:inset 0 -2px 0 var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-tab:active:not(:disabled){transform:translateY(1px)}",
      ".dsh-po-status{display:inline-flex;align-items:center;gap:6px;min-height:36px;max-width:100%;font-size:12px;line-height:16px}",
      // 保存中：一枚低频明灭的小圆点，比「保存中…」文字本身更早被余光捕捉到。
      ".dsh-po-saving{display:inline-flex;align-items:center;gap:6px}",
      ".dsh-po-saving::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;animation:dsh-po-pulse 1.2s var(--dsh-po-ease-soft,cubic-bezier(.45,0,.55,1)) infinite}",
      "@keyframes dsh-po-pulse{0%,100%{opacity:.35}50%{opacity:1}}",
      ".dsh-po-list{display:flex;flex-direction:column;gap:8px}",
      // 列表进场按行错开 25ms（技能: stagger-sequence）：首行 0ms，之后每行 +25ms。
      // 只给前三行排延迟，第四张起同批进场 —— 否则长列表的末尾要等小半秒才出现。
      // 最长延迟 75ms + enter 220ms = 295ms，仍在 300ms 以内。
      ".dsh-po-list>.dsh-po-card:nth-child(2){animation-delay:25ms}",
      ".dsh-po-list>.dsh-po-card:nth-child(3){animation-delay:50ms}",
      ".dsh-po-list>.dsh-po-card:nth-child(4){animation-delay:75ms}",
      // 卡片不是点击目标，不给悬停位移（会带得标题和按钮一起晃）。
      // 它只在真正挂载时进场一次：key 由 prompt.id 决定，保存时的重渲染不会重放。
      ".dsh-po-card{display:flex;flex-direction:column;gap:8px;padding:12px 16px;border:.5px solid var(--dsw-alias-border-l2,#464647);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);animation:dsh-po-rise-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards;transition:border-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      // 编辑中的卡片描边加深：一眼看出「这张正在改」，而不是和其它卡片混在一起。
      ".dsh-po-card-editing{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 36%,transparent)}",
      ".dsh-po-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:32px}",
      ".dsh-po-name{font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 徽标会随「设为默认」出现/消失，直接插入会把按钮行推开一格；用反相推进场，
      // 让它先在原位淡入再落定，眼睛读到的是「标记被盖上」而不是「布局跳了一下」。
      ".dsh-po-badge{flex:none;font-size:11px;line-height:18px;padding:0 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,#464647);color:var(--dsw-alias-label-primary,#f9fafb);animation:dsh-po-badge-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      "@keyframes dsh-po-badge-in{from{opacity:0;transform:scale(.88)}to{opacity:1;transform:none}}",
      ".dsh-po-text{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#bcbcbe);white-space:pre-wrap;word-break:break-word}",
      ".dsh-po-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-left:auto}",
      // 按下只下沉 0.5px：这里是设置页的密集按钮区，1px 已经能看出「整块在动」，
      // 再深就会带得相邻按钮一起晃。
      ".dsh-po-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;border:.5px solid var(--dsw-alias-border-l2,#464647);border-radius:8px;min-height:32px;padding:6px 10px;white-space:nowrap;cursor:pointer;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),border-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),transform var(--dsh-po-dur-tap,90ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1))}",
      ".dsh-po-action:active:not(:disabled){transform:translateY(.5px)}",
      ".dsh-po-action:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}",
      ".dsh-po-action:disabled{cursor:not-allowed;color:var(--dsw-alias-label-secondary,#bcbcbe);border-color:var(--dsw-alias-border-l2,#464647);background:transparent}",
      ".dsh-po-action[aria-busy=true]{cursor:progress}",
      // 主操作按钮：填充用 label-primary、文字用 bg-base。品牌色在本主题下接近白色，
      // 白字叠白底只有 1.4:1；这一对是主题自己保证的对比组合（13.3:1）。
      // hover/active/disabled 用 color-mix 做同一色相的明度变化，前面保留一条纯色回退。
      // 一屏只留一个主按钮：卡片上的「设为默认」降为次要按钮，不再和「新增 / 保存 / 开始测试」抢视线。
      ".dsh-po-primary{color:var(--dsw-alias-bg-base,#2c2c2e);background:var(--dsw-alias-label-primary,#f9fafb);border-color:transparent;font-weight:500}",
      ".dsh-po-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary,#f9fafb);background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 88%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-primary:active:not(:disabled){background:var(--dsw-alias-label-primary,#f9fafb);background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 78%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-primary:disabled{cursor:not-allowed;color:var(--dsw-alias-label-secondary,#bcbcbe);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 10%,var(--dsw-alias-bg-base,#2c2c2e));border-color:transparent;font-weight:400}",
      ".dsh-po-primary:disabled:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 10%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-primary[aria-busy=true]:disabled{cursor:progress}",
      // 危险按钮：平时只有红字 + 半透明红描边（不和主按钮抢眼）；进入「确认删除」后才铺底色。
      ".dsh-po-danger{color:var(--dsw-alias-state-error-primary,#f87171);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 45%,transparent)}",
      ".dsh-po-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 12%,transparent);border-color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-confirm{color:var(--dsw-alias-label-primary,#f9fafb);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 22%,var(--dsw-alias-bg-base,#2c2c2e));border-color:var(--dsw-alias-state-error-primary,#f87171);font-weight:500;animation:dsh-po-badge-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-confirm:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 32%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-field{display:flex;flex-direction:column;gap:6px}",
      ".dsh-po-label{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 输入控件：可见的 surface + 边框，避免“看起来就是一行文字”而认不出是输入框。
      ".dsh-po-input,.dsh-po-textarea{box-sizing:border-box;width:100%;min-height:32px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#f9fafb);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 8%,var(--dsw-alias-bg-base,#2c2c2e));border:1px solid var(--dsw-alias-border-l2,#464647);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 44%,var(--dsw-alias-bg-base,#2c2c2e));border-radius:8px;padding:5px 10px;transition:border-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),box-shadow var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-input::placeholder,.dsh-po-textarea::placeholder{color:var(--dsw-alias-label-secondary,#bcbcbe);opacity:1}",
      ".dsh-po-textarea{min-height:96px;padding:8px 10px;resize:vertical}",
      // 边框三级：静止 44% → 悬停 60% → 聚焦 80%，聚焦时再加一圈 3px 柔光；
      // 原先 hover 与静止是同一个值，鼠标移上去没有任何反馈。
      ".dsh-po-input:hover,.dsh-po-textarea:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 60%,var(--dsw-alias-bg-base,#2c2c2e))}",
      ".dsh-po-input:focus,.dsh-po-textarea:focus{outline:none;border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 80%,var(--dsw-alias-bg-base,#2c2c2e));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 14%,transparent)}",
      ".dsh-po-input[aria-invalid=true],.dsh-po-textarea[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary,#f87171)}",
      // 输入框的焦点由「80% 边框 + 3px 柔光」表达（对比度 > 3:1），不再叠一圈 outline；
      // 校验失败时柔光也换成错误色，不会出现白描边套红边框的双重信号。
      ".dsh-po-input[aria-invalid=true]:focus,.dsh-po-textarea[aria-invalid=true]:focus{border-color:var(--dsw-alias-state-error-primary,#f87171);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 22%,transparent)}",
      ".dsh-po-tab:focus-visible,.dsh-po-action:focus-visible,.dsh-po-primary:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:1px}",
      // 原生 select 的系统箭头在深色主题里是一枚浅灰位图，和其它控件格格不入：
      // 换成与触发器同款的细线折角，颜色跟随次要文字色。
      ".dsh-po-select{position:relative;display:block}",
      ".dsh-po-select>select{appearance:none;-webkit-appearance:none;padding-right:32px;cursor:pointer;text-overflow:ellipsis}",
      ".dsh-po-select>select option{background:var(--dsw-alias-bg-layer-2,#3a3a3c);color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-select::after{content:'';position:absolute;right:13px;top:50%;width:6px;height:6px;margin-top:-5px;border-right:1.5px solid var(--dsw-alias-label-secondary,#bcbcbe);border-bottom:1.5px solid var(--dsw-alias-label-secondary,#bcbcbe);transform:rotate(45deg);pointer-events:none}",
      // 这三种状态文本是在同一行里互相替换的（保存中 → 已保存 / 失败原因），
      // 淡入式进场让「内容换了」读得到，又不会像滑入那样把整行推来推去。
      ".dsh-po-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      ".dsh-po-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#f87171);animation:dsh-po-status-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary,#4ade80);animation:dsh-po-status-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      "@keyframes dsh-po-status-in{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}",
      ".dsh-po-count{align-self:flex-end;font-variant-numeric:tabular-nums}",
      ".dsh-po-count-warn{color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-count-max{color:var(--dsw-alias-state-error-primary,#f87171)}",
      // 结果预览与「查看内置指令」都是同一个 <pre>，出现时轻轻浮起，
      // 与卡片同族，但只动 opacity/transform，不参与高度过渡。
      ".dsh-po-preview{margin:0;padding:10px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#464647);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 8%,var(--dsw-alias-bg-base,#2c2c2e));color:var(--dsw-alias-label-primary,#f9fafb);font-family:inherit;font-size:13px;line-height:20px;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto;animation:dsh-po-rise-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      // 测试运行中：在结果区原位放三条扫光占位，结果到达后同一位置被真实文本替换，版面不跳。
      ".dsh-po-preview-skeleton{display:flex;flex-direction:column;gap:9px;padding:14px 12px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#464647);background:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 4%,var(--dsw-alias-bg-base,#2c2c2e));animation:dsh-po-fade-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-preview-skeleton>.dsh-po-skeleton-bar:nth-child(1){width:92%}",
      ".dsh-po-preview-skeleton>.dsh-po-skeleton-bar:nth-child(2){width:78%}",
      ".dsh-po-preview-skeleton>.dsh-po-skeleton-bar:nth-child(3){width:54%}",
      ".dsh-po-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsh-po-output-head{display:flex;align-items:center;justify-content:space-between;gap:8px}",
      ".dsh-po-editor-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".dsh-po-shortcut{margin-left:auto}",
      ".dsh-po-check{display:flex;align-items:center;gap:8px;min-height:32px;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-check input{width:15px;height:15px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-check input:disabled{cursor:progress}",
      ".dsh-po-check input:focus-visible{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:2px}",
      ".dsh-po-file{display:flex;align-items:center;gap:10px;flex-wrap:wrap;cursor:pointer}",
      ".dsh-po-file-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
      ".dsh-po-file-button{display:inline-flex;align-items:center;gap:6px;min-height:32px;font-size:12px;color:var(--dsw-alias-label-primary,#f9fafb);background:transparent;border:.5px dashed var(--dsw-alias-border-l2,#464647);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 36%,transparent);border-radius:8px;padding:6px 12px;transition:background-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1)),border-color var(--dsh-po-dur-fast,120ms) var(--dsh-po-ease-standard,cubic-bezier(.2,0,0,1))}",
      ".dsh-po-file:hover .dsh-po-file-button{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 60%,transparent)}",
      ".dsh-po-file-input:focus-visible+.dsh-po-file-button{outline:2px solid var(--dsw-alias-label-primary,#f9fafb);outline-offset:1px}",
      ".dsh-po-file-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      ".dsh-po-file-picked{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
      // 缩略图在选择/移除之间切换：淡入 + 轻微放大，读起来像「照片被放下」。
      ".dsh-po-thumb{width:44px;height:44px;object-fit:cover;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,#464647);flex:none;animation:dsh-po-thumb-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      "@keyframes dsh-po-thumb-in{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}",
      ".dsh-po-file-name{font-size:12px;color:var(--dsw-alias-label-secondary,#bcbcbe);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 空状态：图标 + 一句话 + 指向下方按钮的提示，虚线框与卡片同圆角。
      ".dsh-po-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:20px 16px;text-align:center;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary,#bcbcbe);border:.5px dashed var(--dsw-alias-border-l2,#464647);border-color:color-mix(in srgb,var(--dsw-alias-label-primary,#f9fafb) 24%,transparent);border-radius:12px;animation:dsh-po-rise-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-empty-icon{display:inline-flex;color:var(--dsw-alias-label-secondary,#bcbcbe)}",
      // 首次加载：三张与真实卡片同尺寸的骨架。延迟 150ms 才显形 ——
      // 本地接口通常几十毫秒就返回，这样快速加载时不会闪一下骨架。
      ".dsh-po-skeleton-list{display:flex;flex-direction:column;gap:8px}",
      ".dsh-po-skeleton{display:flex;flex-direction:column;gap:10px;padding:16px;border:.5px solid var(--dsw-alias-border-l2,#464647);border-radius:12px;background:var(--dsw-alias-bg-layer-1,transparent);animation:dsh-po-fade-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) 150ms backwards}",
      ".dsh-po-skeleton>.dsh-po-skeleton-bar:nth-child(1){width:32%;height:12px}",
      ".dsh-po-skeleton>.dsh-po-skeleton-bar:nth-child(2){width:86%}",
      ".dsh-po-skeleton>.dsh-po-skeleton-bar:nth-child(3){width:64%}",
      // 加载失败：带图标与重试按钮的提示块，而不是一行容易被忽略的红字。
      ".dsh-po-alert{display:flex;align-items:flex-start;gap:10px;padding:12px 12px 12px 14px;border-radius:12px;border:.5px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#f87171) 8%,var(--dsw-alias-bg-base,#2c2c2e));animation:dsh-po-rise-in var(--dsh-po-dur-enter,220ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-alert-icon{display:inline-flex;flex:none;margin-top:3px;color:var(--dsw-alias-state-error-primary,#f87171)}",
      ".dsh-po-alert-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}",
      ".dsh-po-alert-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary,#f9fafb)}",
      ".dsh-po-alert-text{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#bcbcbe);word-break:break-word}",

      // 设置页签内容（提示词列表 / 测试表单）在切换时整块换掉：给容器一次
      // 极短的淡入，让「换了一页」可感知，但不做横向滑动 —— 两个页签没有前后关系。
      ".dsh-po-panel{animation:dsh-po-fade-in var(--dsh-po-dur-base,180ms) var(--dsh-po-ease-out,cubic-bezier(.16,.84,.44,1)) backwards}",
      ".dsh-po-panel:focus-visible{outline:none}",

      // ------------------------------------------------------------ 窄面板
      // 设置面板窄于 520px（侧栏 / 手机）时：卡片操作区独占一行并左对齐，
      // 按钮不再被挤到标题右侧折成参差的两行；页签栏的保存状态换到下一行。
      "@container (max-width:520px){.dsh-po-card-head .dsh-po-actions{margin-left:0;width:100%;justify-content:flex-start}.dsh-po-card{padding:12px}.dsh-po-shortcut{display:none}.dsh-po-file-name{max-width:160px}}",
      // 触屏没有 hover，把可点击高度从 32px 提到 36px，手指更容易命中。
      "@media (pointer:coarse){.dsh-po-action,.dsh-po-input,.dsh-po-check{min-height:36px}.dsh-po-option{min-height:40px}}",
      // 强制配色模式（Windows 高对比度）：自绘的开关、选中行与焦点环改用系统色，不会消失。
      // 激活页签用 outline 而不是 border-bottom：后者会把这枚页签撑高 2px，下划线错位。
      "@media (forced-colors:active){.dsh-po-switch-track{border:1px solid CanvasText}.dsh-po-switch-input:checked+.dsh-po-switch-track{background:Highlight}.dsh-po-option-selected{outline:1px solid Highlight}.dsh-po-tab-active{box-shadow:none;outline:2px solid Highlight;outline-offset:-2px}.dsh-po-skeleton-bar{background:GrayText}.dsh-po-btn:focus-visible,.dsh-po-choice:focus-visible{outline-color:Highlight}}",

      // ---------------------------------------------------- 减少动效（统一兜底）
      // 一处覆盖全部动效，而不是散落在各条规则旁边：新增的过渡/关键帧默认
      // 就被关掉，不会漏掉某个选择器（技能: reduced-motion）。
      // 只保留 opacity/颜色这类「不动位置」的变化，空间位移、缩放、回弹全部取消。
      // 过渡压到 1ms 而不是 none：颜色仍然立即到位，但不会因为缺过渡约束
      // 在状态间留下半途的中间色。
      "@media (prefers-reduced-motion:reduce){.dsh-po-btn,.dsh-po-spark,.dsh-po-choice,.dsh-po-choice-title,.dsh-po-choice-chevron,.dsh-po-tab,.dsh-po-action,.dsh-po-input,.dsh-po-textarea,.dsh-po-switch-track,.dsh-po-switch-thumb,.dsh-po-file-button,.dsh-po-option,.dsh-po-card,.dsh-po-popover-retry{transition-duration:1ms!important}}",
      "@media (prefers-reduced-motion:reduce){.dsh-po-glyph,.dsh-po-popover,.dsh-po-popover-backdrop,.dsh-po-badge,.dsh-po-card,.dsh-po-preview,.dsh-po-thumb,.dsh-po-empty,.dsh-po-panel,.dsh-po-error,.dsh-po-ok,.dsh-po-toast,.dsh-po-btn.dsh-po-failed,.dsh-po-popover-error,.dsh-po-confirm,.dsh-po-alert,.dsh-po-skeleton,.dsh-po-skeleton-bar,.dsh-po-preview-skeleton,.dsh-po-saving::before{animation:none!important}}",
      "@media (prefers-reduced-motion:reduce){.dsh-po-btn:active:not(:disabled),.dsh-po-choice:active:not(:disabled),.dsh-po-tab:active:not(:disabled),.dsh-po-action:active:not(:disabled){transform:none}}",
      // 循环动画（呼吸、骨架扫光、保存中圆点）全部停下：按钮仍有 drop-shadow 提示「在忙」，
      // 骨架条与圆点保持静态可见，状态信息不丢。
      "@media (prefers-reduced-motion:reduce){.dsh-po-btn.dsh-po-busy .dsh-po-spark{animation:none}}"
    ].join("\n")

    const h = react.createElement

    /**
     * 优化图标：单色双星芒（一枚大星 + 两枚点缀）。
     *
     * 不用彩色 ✨ emoji：它是唯一一枚彩色字形，放在一排线性图标里像贴纸，
     * 且随系统字体渲染而变形。改成 fill:currentColor 的 SVG 后，
     * 悬停 / 禁用 / 深浅主题全部自动跟随，视觉重量与相邻图标一致。
     */
    /**
     * 四角星芒路径：四个尖角用二次曲线连到中心附近，得到内凹的圆角星。
     * @param cx - 星心 x。
     * @param cy - 星心 y。
     * @param r - 尖角半径。
     * @param k - 控制点收进量（越小越尖）。
     */
    function starD(cx, cy, r, k) {
      const a = r * k
      const p = (n) => Math.round(n * 100) / 100
      return "M" + p(cx) + " " + p(cy - r)
        + "Q" + p(cx + a) + " " + p(cy - a) + " " + p(cx + r) + " " + p(cy)
        + "Q" + p(cx + a) + " " + p(cy + a) + " " + p(cx) + " " + p(cy + r)
        + "Q" + p(cx - a) + " " + p(cy + a) + " " + p(cx - r) + " " + p(cy)
        + "Q" + p(cx - a) + " " + p(cy - a) + " " + p(cx) + " " + p(cy - r) + "Z"
    }

    /**
     * 星芒几何：一枚主星 + 两枚伴星。
     *
     * 主星略偏右下、伴星在左上与左下，中心加权后落在视窗正中，
     * 这样 13–15px 的小尺寸下不会显得"跑到一边去"。
     */
    const SPARKLE_D = [
      starD(13.7, 13, 7.4, 0.2),
      starD(5.7, 6.2, 2.6, 0.2),
      starD(6.3, 16.6, 3.4, 0.2)
    ].join(" ")

    /**
     * 优化图标：单色星芒。
     *
     * 不用彩色 ✨ emoji：它是工具栏里唯一一枚彩色字形，视觉上像贴纸；
     * 而且字形随系统 emoji 字体变化，跨平台不可控。换成 fill:currentColor
     * 的 SVG 后，悬停 / 禁用 / 深浅主题全部自动跟随。
     */
    function SparkleIcon() {
      return h("svg", {
        width: 15, height: 15, viewBox: "0 0 24 24",
        className: "dsh-po-spark",
        "aria-hidden": true,
        focusable: "false"
      }, h("path", { d: SPARKLE_D }))
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

    /**
     * 下拉箭头。
     *
     * 展开时绕自身中心翻 180°，用同一枚字形表达「开 / 合」两个状态 ——
     * 这是判断面板有没有打开的第一视觉线索，比换图标或加颜色都直接。
     */
    function ChevronDownIcon() {
      return h("svg", {
        width: 10, height: 10, viewBox: "0 0 24 24", fill: "none",
        className: "dsh-po-chevron",
        "aria-hidden": true,
        focusable: "false"
      },
        h("path", {
          d: "M6 9.5 12 15.5 18 9.5",
          stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round"
        })
      )
    }

    /** 圆形感叹号：失败提示气泡与加载失败提示块共用。 */
    function AlertIcon(props) {
      const size = props && props.size ? props.size : 14
      return h("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true, focusable: "false"
      },
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "M12 7.5v5" }),
        h("path", { d: "M12 16.2v.3" })
      )
    }

    /** 圆形信息符号：「模型认为无需改动」这类中性提示用。 */
    function InfoIcon() {
      return h("svg", {
        width: 14, height: 14, viewBox: "0 0 24 24", fill: "none",
        stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round",
        "aria-hidden": true, focusable: "false"
      },
        h("circle", { cx: 12, cy: 12, r: 9 }),
        h("path", { d: "M12 11v5.5" }),
        h("path", { d: "M12 7.6v.3" })
      )
    }

    /** 让一个元素获得焦点；元素不存在或不可聚焦（测试替身、旧宿主）时静默跳过。 */
    function focusElement(element) {
      if (element !== null && element !== undefined && typeof element.focus === "function") {
        try { element.focus({ preventScroll: true }) } catch { /* 不可聚焦时什么也不做 */ }
      }
    }

    /** 按 id 聚焦；没有 DOM 的环境返回 null 后什么也不做。 */
    function focusById(id) {
      if (typeof document === "undefined" || typeof document.getElementById !== "function") return
      focusElement(document.getElementById(id))
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
      /** 触发器：关闭浮层后把焦点还给它，键盘用户不会「掉」到页面顶部。 */
      const triggerRef = react.useRef(null)
      /** 浮层：打开时把焦点移到当前选中的选项上。 */
      const popoverRef = react.useRef(null)
      /** 最近一次按键是否为 Tab：区分键盘离开与鼠标导致的失焦。 */
      const tabbingOut = react.useRef(false)
      /** 浮层挂到 body 时的锚点（相对视口的像素）；null 表示还没量到。 */
      const [anchor, setAnchor] = react.useState(null)
      /**
       * 能否把浮层挂到 `document.body`：需要 react-dom 的 createPortal 和一个可用的
       * document.body。宿主没提供 react-dom 时退回原地渲染，浮层内容完全一致。
       */
      const canPortal = createPortal !== null
        && typeof document !== "undefined"
        && document !== null
        && document.body !== null
        && document.body !== undefined
      const options = catalogOptions(catalog)
      const active = activeCatalogOption(catalog)
      const activeSupport = imageSupportFor(active, catalog.capabilities)
      const currentDefaultId = catalog.config && typeof catalog.config.defaultId === "string"
        ? catalog.config.defaultId
        : ""

      // 打开后焦点进入浮层，落在已选中的 radio 上：方向键立刻可用，读屏器也会
      // 先读出「当前是哪一条」。鼠标打开时这次聚焦不会触发 focus-visible 焦点环。
      react.useEffect(() => {
        if (!open) return
        const panel = popoverRef.current
        if (panel === null || typeof panel.querySelector !== "function") return
        focusElement(panel.querySelector("input[type=radio]:checked") || panel.querySelector("input[type=radio]"))
      }, [open])

      /** 视口尺寸：优先用文档元素（不含经典滚动条），拿不到就退回 window。 */
      const viewportSize = () => {
        if (typeof window === "undefined") return null
        const root = typeof document !== "undefined" && document !== null ? document.documentElement : null
        const width = root !== null && root !== undefined && typeof root.clientWidth === "number" && root.clientWidth > 0
          ? root.clientWidth
          : window.innerWidth
        const height = root !== null && root !== undefined && typeof root.clientHeight === "number" && root.clientHeight > 0
          ? root.clientHeight
          : window.innerHeight
        if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) return null
        return { width, height }
      }

      /**
       * 面板的锚点样式：贴触发器左缘，左右夹在视口边距内。
       * 向下展开时必须显式写 `bottom:auto` —— CSS 里的 `bottom:calc(100%)` 仍在，
       * 若与 top 同时生效，绝对定位元素的高度会被拉成两者的差值（负值 → 0），
       * 面板就塌成一条细边。
       */
      const anchorStyle = (rect, viewport, below) => {
        const left = Math.max(8, Math.min(rect.left, viewport.width - POPOVER_MAX_WIDTH - 8))
        return below === true
          ? { left, top: rect.bottom + 8, bottom: "auto" }
          : { left, bottom: Math.max(8, viewport.height - rect.top + 8) }
      }

      /** 打开浮层；挂 portal 时先量好锚点，浮层第一帧就落在触发器旁边。 */
      const openMenu = () => {
        const trigger = triggerRef.current
        const viewport = viewportSize()
        const rect = trigger !== null && trigger !== undefined && typeof trigger.getBoundingClientRect === "function"
          ? trigger.getBoundingClientRect()
          : null
        setAnchor(canPortal && rect !== null && rect !== undefined && viewport !== null
          ? anchorStyle(rect, viewport, false)
          : null)
        setError("")
        setOpen(true)
      }

      // 面板挂载后才量得到真实高度，方向与位置都在这里校准：上方放不下、并且下方确实
      // 更宽裕时才向下展开；两侧都挤时留在上方，不为了几像素的溢出把面板翻到视口外。
      // 挂到 body 后浮层不再跟着触发器走：滚动、窗口尺寸、触发器尺寸变化都要重算，
      // 同一帧内的多次变化用 rAF 合并，坐标没变就不 setState。
      react.useEffect(() => {
        if (!open || !canPortal) return undefined
        const apply = () => {
          const trigger = triggerRef.current
          const viewport = viewportSize()
          if (viewport === null || trigger === null || trigger === undefined) return
          if (typeof trigger.getBoundingClientRect !== "function") return
          const rect = trigger.getBoundingClientRect()
          const panel = popoverRef.current
          const panelHeight = panel !== null && panel !== undefined && typeof panel.getBoundingClientRect === "function"
            ? panel.getBoundingClientRect().height
            : 0
          const spaceAbove = rect.top - 8
          const spaceBelow = viewport.height - rect.bottom - 8
          const below = panelHeight > 0 && spaceAbove < panelHeight && spaceBelow > spaceAbove
          const next = anchorStyle(rect, viewport, below)
          setAnchor((current) => current !== null
            && current.left === next.left
            && current.top === next.top
            && current.bottom === next.bottom
            ? current
            : next)
        }
        apply()
        let frame = 0
        const schedule = () => {
          if (typeof requestAnimationFrame !== "function") { apply(); return }
          if (frame !== 0) return
          frame = requestAnimationFrame(() => { frame = 0; apply() })
        }
        const trigger = triggerRef.current
        const observer = typeof ResizeObserver === "function" && trigger !== null && trigger !== undefined
          ? new ResizeObserver(schedule)
          : null
        if (observer !== null) observer.observe(trigger)
        const listen = typeof window !== "undefined" && typeof window.addEventListener === "function"
        if (listen) {
          window.addEventListener("resize", schedule)
          window.addEventListener("scroll", schedule, true)
        }
        return () => {
          if (frame !== 0 && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame)
          frame = 0
          if (observer !== null) observer.disconnect()
          if (listen) {
            window.removeEventListener("resize", schedule)
            window.removeEventListener("scroll", schedule, true)
          }
        }
      }, [open, canPortal])

      /** Close the menu; `restoreFocus` hands focus back to the trigger. */
      const close = (restoreFocus) => {
        setOpen(false)
        setError("")
        if (restoreFocus) focusElement(triggerRef.current)
      }

      /** Select one prompt as the default and close the menu on success. */
      const choose = async (id) => {
        if (saving) return
        if (id === currentDefaultId) { close(true); return }
        setSaving(true)
        setError("")
        const result = await persistConfig((config) => ({ ...config, defaultId: id }))
        setSaving(false)
        if (result.ok) close(true)
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
        // 记下「这次失焦是 Tab 键造成的」，onMenuBlur 只认这一种离开方式。
        tabbingOut.current = event.key === "Tab"
        if (event.key === "Escape") {
          event.preventDefault()
          close(true)
        } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
          event.preventDefault()
          moveSelection(1)
        } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
          event.preventDefault()
          moveSelection(-1)
        }
      }

      /**
       * 只在「用 Tab 键离开浮层」时收起。
       *
       * 鼠标按在浮层里时，宿主输入框会在 mousedown 阶段把焦点抢回 textarea；
       * 如果因此收起，浮层会在 click 之前卸载，点击就穿透落到输入框上
       * （开关点不到）。所以指针操作造成的失焦一律不收起，点外部交给遮罩处理。
       */
      const onMenuBlur = (event) => {
        if (!tabbingOut.current) return
        tabbingOut.current = false
        const next = event.relatedTarget
        const panel = popoverRef.current
        // 浮层挂到 body 后它是文档里最后一段可聚焦内容：从最后一个控件按 Tab，焦点
        // 会交给浏览器 UI，relatedTarget 为空。这也是「离开浮层」，收起并把焦点还回
        // 触发器，否则菜单会挂在一个已经没有任何焦点的位置上。
        if (next === null || next === undefined) { close(true); return }
        if (panel === null || typeof panel.contains !== "function") { close(false); return }
        if (panel.contains(next) || next === triggerRef.current) return
        close(false)
      }

      /** 浮层：挂 portal 时按锚点定位，原地渲染的坐标交给 CSS。 */
      /**
       * 浮层本体。挂 portal 时锚点由测量结果给出（量不到时退回到左下角安全区，
      * 至少不会跑到视口外）；原地渲染的坐标交给 CSS。
       */
      const renderPopover = (style) => pickerPopover({
        catalog, options, active, saving, error, choose, toggleImages,
        onMenuKeyDown, onMenuBlur, popoverRef, style,
        onMenuMouseDown: () => { tabbingOut.current = false }
      })

      /** 遮罩：点外关闭并归还焦点；和浮层同处一层，一起搬进 portal。 */
      const renderBackdrop = () => h("div", {
        className: "dsh-po-popover-backdrop",
        "aria-hidden": true,
        onClick: () => close(true)
      })

      const label = "优化提示词选项：" + active.name + "（" + activeSupport.label + "）"
      return h("div", { className: "dsh-po-picker-wrap" },
        h("button", {
          type: "button",
          ref: triggerRef,
          className: "dsh-po-choice" + (open ? " dsh-po-choice-open" : ""),
          title: label + "。点击切换",
          "aria-label": label,
          "aria-haspopup": "dialog",
          "aria-controls": "dsh-po-prompt-popover",
          "aria-expanded": open,
          disabled: props.disabled === true,
          onClick: () => { if (open) close(false); else openMenu() },
          onKeyDown: (event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              openMenu()
            } else if (event.key === "Escape") {
              close(false)
            }
          }
        },
          h("span", { className: "dsh-po-choice-title", title: active.name }, active.name),
          h("span", {
            className: "dsh-po-choice-chevron" + (open ? " dsh-po-choice-chevron-open" : ""),
            "aria-hidden": true
          }, h(ChevronDownIcon))),
        open && canPortal
          ? createPortal(
            // 整层拦下指针与键盘事件：宿主输入框不会收到冒泡的回车，
            // 点击也不会在 click 之前被宿主的 mousedown 抢走焦点。
            h("div", {
              className: "dsh-po-layer",
              onMouseDown: (event) => event.stopPropagation(),
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => event.stopPropagation(),
              onKeyDown: (event) => event.stopPropagation()
            },
              renderPopover(anchor === null ? { left: 8, bottom: 8 } : anchor),
              renderBackdrop()),
            document.body)
          : null,
        open && !canPortal ? renderPopover(undefined) : null,
        open && !canPortal ? renderBackdrop() : null)
    }

    /**
     * The radio + per-row image switch menu inside the composer picker.
     *
     * 底部状态位始终只占一个子节点：保存失败、目录加载中、加载失败重试三者互斥，
     * 浮层结构在保存期间不增不减（高度不跳）。
     */
    function pickerPopover({ catalog, options, active, saving, error, choose, toggleImages, onMenuKeyDown, onMenuBlur, popoverRef, style, onMenuMouseDown }) {
      return h("div", {
        className: "dsh-po-popover",
        id: "dsh-po-prompt-popover",
        ref: popoverRef,
        role: "dialog",
        "aria-label": "优化提示词",
        "aria-busy": saving,
        // 挂到 body 时由调用方给出 left / bottom；原地渲染交给 CSS。
        style: style,
        onKeyDown: onMenuKeyDown,
        onBlur: onMenuBlur,
        // 在浮层内按下鼠标时不让焦点离开浮层：阻止 mousedown 的默认聚焦行为
        // （不影响随后的 click，开关和选项照常切换），也不把事件冒泡给宿主输入框。
        onMouseDown: (event) => {
          // 指针操作说明用户没有在用 Tab 离开：清掉上一次的「Tab 离开」意图。
          if (typeof onMenuMouseDown === "function") onMenuMouseDown()
          event.stopPropagation()
          event.preventDefault()
        }
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
                  h("span", { className: "dsh-po-option-name", title: option.name }, option.name),
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
        error === "" ? null : h("span", { className: "dsh-po-popover-error", role: "alert" }, "保存失败：" + error),
        catalog.status === "error"
          ? h("button", {
            type: "button", className: "dsh-po-popover-retry",
            onClick: () => { void loadCatalog() }
          },
            h("span", { className: "dsh-po-popover-retry-error", "aria-hidden": true }, h(AlertIcon, { size: 13 })),
            h("span", null, "配置加载失败，重试"))
          : catalog.status === "loading"
            ? h("div", { className: "dsh-po-popover-loading", role: "status" },
              h("span", { className: "dsh-po-skeleton-bar", style: { width: 48 }, "aria-hidden": true }),
              h("span", null, "正在同步提示词…"))
            : null)
    }

    function OptimizeButton(props) {
      const [busy, setBusy] = react.useState(false)
      // 撤销态：记录本次优化前后的草稿。仅当草稿仍是优化结果时图标才显示为撤销，
      // 用户手动改写后自然回到 ✨，避免“撤销”覆盖用户自己的编辑。
      const [undo, setUndo] = react.useState(null)
      // 按钮上方的一次性提示气泡：{ kind: 'error' | 'info', text }。
      // 失败原先只进 console，用户看到的是「点了没反应」；现在原因会在原位出现 4 秒。
      const [notice, setNotice] = react.useState(null)
      // 读屏播报文本：优化中 / 已优化 / 已撤销，视觉上不可见。
      const [announce, setAnnounce] = react.useState("")
      react.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), notice.kind === "error" ? 4200 : 2600)
        return () => clearTimeout(timer)
      }, [notice])
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
        setNotice(null)

        // 撤销：把优化后的草稿还原成点击前的原文。
        if (canUndo) {
          const before = undo.before
          setUndo(null)
          if (props.inputActions && typeof props.inputActions.setDraft === "function") {
            props.inputActions.setDraft(before)
          }
          setAnnounce("已恢复原始提示词")
          return
        }

        const text = draft
        if (text.trim() === "") return
        setUndo(null)
        setBusy(true)
        setAnnounce("正在优化提示词…")
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
              // 模型原样返回时没有可撤销的差异，保持 ✨ 而不是显示无效的撤销按钮，
              // 但要告诉用户「已经跑完了，只是不需要改」—— 否则看起来像没反应。
              if (data.optimized === text) {
                setUndo(null)
                setNotice({ kind: "info", text: "提示词已足够清晰，无需改动" })
                setAnnounce("")
              } else {
                setUndo({ before: text, after: data.optimized })
                setAnnounce("提示词已优化，再次点击可撤销")
              }
            }
          } else {
            const message = data && typeof data.error === "string" ? data.error : ("HTTP " + res.status)
            console.error("[dsh-prompt-optimizer]", message)
            setNotice({ kind: "error", text: "优化失败：" + message })
            setAnnounce("")
          }
        } catch (error) {
          console.error("[dsh-prompt-optimizer]", error)
          const message = error instanceof Error ? error.message : String(error)
          setNotice({ kind: "error", text: "优化失败：" + (message === "" ? "网络异常" : message) })
          setAnnounce("")
        } finally {
          setBusy(false)
        }
      }

      // 加载中不换图标：同一枚 ✨ 由 .dsh-po-busy 驱动呼吸动画，
      // 用户看到的是「操作在进行」，而不是「符号被替换掉了」。
      const icon = canUndo ? h(UndoIcon) : h(SparkleIcon)
      const label = busy ? "正在优化提示词…" : canUndo ? "撤销优化，恢复原始提示词" : "优化提示词"
      const failed = notice !== null && notice.kind === "error"

      return h("div", { className: "dsh-po-composer-controls" },
        h(PromptPicker, { disabled: busy }),
        // ✨ 与提示气泡放在同一个定位容器里：气泡贴着按钮向上弹出，不改变工具行布局。
        h("div", { className: "dsh-po-run" },
          h("button", {
            type: "button",
            className: "dsh-po-btn" + (busy ? " dsh-po-busy" : "") + (canUndo ? " dsh-po-undo" : "") + (failed ? " dsh-po-failed" : ""),
            title: label,
            "aria-label": label,
            "aria-busy": busy,
            "aria-describedby": notice !== null ? "dsh-po-run-notice" : undefined,
            disabled: disabled,
            onClick: onClick
          },
            // key 变化即重新挂载，触发一次 .dsh-po-glyph 过渡，避免图标生硬替换。
            // busy 不参与 key：加载与空闲是同一枚图标，只是动画不同。
            h("span", { className: "dsh-po-glyph", key: canUndo ? "undo" : "idle" }, icon)
          ),
          notice === null
            ? null
            : h("div", {
              id: "dsh-po-run-notice",
              className: "dsh-po-toast dsh-po-toast-" + notice.kind,
              role: notice.kind === "error" ? "alert" : "status",
              // 点一下即可提前收起；它不挡输入框，只是给不想等 4 秒的人一个出口。
              onClick: () => setNotice(null)
            },
              h("span", { className: "dsh-po-toast-icon" }, notice.kind === "error" ? h(AlertIcon) : h(InfoIcon)),
              h("span", null, notice.text)),
          h("span", { className: "dsh-po-sr", role: "status", "aria-live": "polite" }, announce))
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
      /** 复制结果的反馈：'' | 'ok' | 'fail'，1.6 秒后回到「复制」。 */
      const [copied, setCopied] = react.useState("")
      const [test, setTest] = react.useState({ id: "", input: "", running: false, output: "", error: "" })
      // 图片输入是可选项：默认不启用，仅在模型能力声明 image 时才提供勾选框。
      const [image, setImage] = react.useState({
        enabled: false, data: "", mediaType: "", name: "", previewUrl: ""
      })
      // 选图失败与「测试跑失败」是两件事：前者测试根本没开始，不能套「测试失败：」。
      const [imageError, setImageError] = react.useState("")
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

      /** 「确认删除」5 秒内没点就自动退回「删除」：避免二次确认态一直挂着，下次误触即删。 */
      react.useEffect(() => {
        if (confirmId === null) return undefined
        const timer = setTimeout(() => setConfirmId(null), 5000)
        return () => clearTimeout(timer)
      }, [confirmId])

      react.useEffect(() => {
        if (copied === "") return undefined
        const timer = setTimeout(() => setCopied(""), 1600)
        return () => clearTimeout(timer)
      }, [copied])

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
          setImageError("仅支持 PNG / JPEG / WebP / GIF 图片")
          return
        }
        const reader = new FileReader()
        reader.onload = () => {
          const url = typeof reader.result === "string" ? reader.result : ""
          const comma = url.indexOf(",")
          if (comma < 0) {
            setImageError("无法读取该图片")
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
          setImageError("")
        }
        reader.onerror = () => setImageError("无法读取该图片")
        reader.readAsDataURL(file)
      }

      /** 清除已选图片，但保留勾选状态，方便重新挑一张。 */
      const clearImage = () => {
        setImage((current) => ({ ...current, data: "", mediaType: "", name: "", previewUrl: "" }))
        setImageError("")
      }

      const runTest = async () => {
        if (selectedTest === undefined || test.input.trim() === "" || test.running) return
        setImageError("")
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
        if (test.output === "") return
        if (typeof navigator === "undefined" || navigator.clipboard === undefined) { setCopied("fail"); return }
        navigator.clipboard.writeText(test.output).then(() => setCopied("ok"), () => setCopied("fail"))
      }

      /** ⌘/Ctrl + Enter：编辑器里是保存，测试输入里是开始测试。 */
      const isSubmitKey = (event) => event.key === "Enter" && (event.metaKey === true || event.ctrlKey === true)

      // ------------------------------------------------------------ 渲染片段

      const actionButton = (text, onClick, options = {}) => h("button", {
        type: "button",
        className: "dsh-po-action"
          + (options.primary ? " dsh-po-primary" : "")
          + (options.danger ? " dsh-po-danger" : "")
          + (options.confirm ? " dsh-po-confirm" : ""),
        onClick: onClick,
        disabled: options.disabled === true,
        "aria-busy": options.busy === true ? true : undefined,
        "aria-label": options.label,
        title: options.title
      }, text)

      const editorCard = () => {
        const form = editor
        const nameInvalid = editorError === "请填写名称"
        const instructionInvalid = editorError === "请填写提示词内容"
        const length = form.instruction.length
        return h("div", {
          className: "dsh-po-card dsh-po-card-editing",
          key: "editor",
          role: "group",
          "aria-label": form.mode === "edit" ? "编辑提示词" : "新增提示词",
          onKeyDown: (event) => {
            if (event.key === "Escape") { event.preventDefault(); cancelEditor() }
            else if (isSubmitKey(event)) { event.preventDefault(); if (!saving) saveEditor(form) }
          }
        },
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
              autoFocus: true,
              "aria-invalid": nameInvalid,
              "aria-describedby": nameInvalid ? "dsh-po-editor-error" : undefined,
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
              "aria-invalid": instructionInvalid,
              "aria-describedby": instructionInvalid ? "dsh-po-editor-error dsh-po-instruction-count" : "dsh-po-instruction-count",
              placeholder: "描述希望模型如何改写用户的提示词…",
              onChange: (event) => setEditor((current) => ({ ...current, instruction: event.target.value }))
            }),
            // 接近上限（90%）时字数变亮，到达上限变红；平时保持次要色不打扰。
            h("span", {
              id: "dsh-po-instruction-count",
              className: "dsh-po-hint dsh-po-count" + (length >= 8000 ? " dsh-po-count-max" : length >= 7200 ? " dsh-po-count-warn" : "")
            }, length + " / 8000")),
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
          editorError === "" ? null : h("span", { className: "dsh-po-error", id: "dsh-po-editor-error", role: "alert" }, editorError),
          h("div", { className: "dsh-po-editor-foot" },
            actionButton("保存", () => saveEditor(form), { primary: true, disabled: saving }),
            actionButton("取消", cancelEditor),
            h("span", { className: "dsh-po-hint dsh-po-shortcut", "aria-hidden": true }, "⌘/Ctrl + Enter 保存 · Esc 取消"))
        )
      }

      const promptCard = (prompt) => {
        const isDefault = config.defaultId === prompt.id
        if (editor !== null && editor.mode === "edit" && editor.id === prompt.id) return editorCard()
        // key 只由 prompt.id 决定：保存闪烁（saving/saved）不会重建卡片，
        // 卡片上的进场动画因此只在真正新增时播放一次，不会每次保存都重放。
        return h("div", { className: "dsh-po-card", key: prompt.id },
          h("div", { className: "dsh-po-card-head" },
            h("span", { className: "dsh-po-name" }, prompt.name),
            isDefault ? h("span", { className: "dsh-po-badge" }, "默认") : null,
            prompt.useImages === true ? h("span", { className: "dsh-po-badge" }, "含图片") : null,
            h("div", { className: "dsh-po-actions" },
              isDefault ? null : actionButton("设为默认", () => setDefault(prompt.id), {
                disabled: saving,
                title: "优化提示词时使用这一条"
              }),
              actionButton("编辑", () => startEdit(prompt), { disabled: saving }),
              actionButton("测试", () => {
                setTest((current) => ({ ...current, id: prompt.id, output: "", error: "" }))
                setTab("test")
              }),
              // 二次确认：「删除」变成实心的「确认删除」，旁边给一个「取消」退路；5 秒不点自动复原。
              confirmId === prompt.id
                ? actionButton("取消", () => setConfirmId(null), { label: "取消删除「" + prompt.name + "」" })
                : null,
              confirmId === prompt.id
                ? actionButton("确认删除", () => removePrompt(prompt.id), {
                  danger: true, confirm: true, disabled: saving, label: "确认删除「" + prompt.name + "」"
                })
                : actionButton("删除", () => setConfirmId(prompt.id), {
                  danger: true, disabled: saving, label: "删除「" + prompt.name + "」"
                }))),
          h("div", { className: "dsh-po-text", title: prompt.instruction.length > 160 ? prompt.instruction : undefined }, prompt.instruction)
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
          ? h("div", { className: "dsh-po-empty" },
            h("span", { className: "dsh-po-empty-icon", "aria-hidden": true }, h(SparkleIcon)),
            h("span", null, "还没有自定义提示词，新增一条后即可设为默认。"))
          : config.prompts.map(promptCard),
        h("div", { className: "dsh-po-row" },
          actionButton("新增提示词", startCreate, {
            primary: true,
            disabled: saving || editor !== null,
            title: editor !== null ? "请先保存或取消正在编辑的提示词" : undefined
          }),
          config.defaultId !== "" && config.prompts.some((prompt) => prompt.id === config.defaultId)
            ? h("span", { className: "dsh-po-hint" }, "当前默认：" + config.prompts.find((prompt) => prompt.id === config.defaultId).name)
            : null)
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
          h("span", { className: "dsh-po-select" },
            h("select", {
              id: "dsh-po-test-select",
              className: "dsh-po-input",
              value: test.id,
              disabled: test.running,
              onChange: (event) => setTest({ ...test, id: event.target.value, output: "", error: "" })
            },
              h("option", { value: "" }, (builtin.name || FALLBACK_BUILTIN.name) + "（内置）"),
              config.prompts.map((prompt) => h("option", { key: prompt.id, value: prompt.id },
                prompt.name + (config.defaultId === prompt.id ? "（默认）" : "")))))),
        h("div", { className: "dsh-po-field" },
          h("label", { className: "dsh-po-label", htmlFor: "dsh-po-test-input" }, "测试输入"),
          h("textarea", {
            id: "dsh-po-test-input",
            className: "dsh-po-textarea",
            rows: 4,
            value: test.input,
            placeholder: "输入一段提示词，看看它会被优化成什么样…",
            onChange: (event) => setTest({ ...test, input: event.target.value }),
            onKeyDown: (event) => {
              if (isSubmitKey(event)) { event.preventDefault(); void runTest() }
            }
          })),
        // 图片输入整体只在模型声明支持 image 时出现；不支持时这里什么都不渲染，
        // 页面与纯文本版本完全一致，也不会提前触发任何图片相关请求。
        capabilities.image ? imageField() : null,
        h("div", { className: "dsh-po-row" },
          actionButton(test.running ? "测试中…" : "开始测试", () => { void runTest() }, {
            primary: true,
            busy: test.running,
            disabled: test.running || test.input.trim() === "" || selectedTest === undefined,
            title: test.input.trim() === "" ? "先填写测试输入" : "⌘/Ctrl + Enter"
          }),
          h("span", { className: "dsh-po-hint" }, "调用当前激活模型，测试不会保存任何改动。")),
        imageError === "" ? null : h("span", { className: "dsh-po-error", role: "alert" }, "无法使用该图片：" + imageError),
        test.error === "" ? null : h("span", { className: "dsh-po-error", role: "alert" }, "测试失败：" + test.error),
        // 运行中在结果区原位放骨架；结果到达后同一位置换成真实文本，版面不跳。
        test.running
          ? h("div", { className: "dsh-po-field", role: "status", "aria-label": "正在生成优化结果" },
            h("span", { className: "dsh-po-label", "aria-hidden": true }, "优化结果"),
            h("div", { className: "dsh-po-preview-skeleton", "aria-hidden": true },
              h("span", { className: "dsh-po-skeleton-bar" }),
              h("span", { className: "dsh-po-skeleton-bar" }),
              h("span", { className: "dsh-po-skeleton-bar" })))
          : test.output === ""
            ? null
            : h("div", { className: "dsh-po-field" },
              h("div", { className: "dsh-po-output-head" },
                h("span", { className: "dsh-po-label", id: "dsh-po-output-label" }, "优化结果"),
                // 播报文案单独成一个不可见节点：按钮留在播报区域里会把按钮名一起念出来。
                h("span", { className: "dsh-po-sr", role: "status", "aria-live": "polite" },
                  copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : ""),
                actionButton(copied === "ok" ? "已复制" : copied === "fail" ? "复制失败" : "复制", copyOutput)),
              h("pre", { className: "dsh-po-preview", "aria-labelledby": "dsh-po-output-label", tabIndex: 0 }, test.output))
      )

      /** 页签：方向键 / Home / End 在两枚页签间移动并切换（WAI-ARIA tabs 的自动激活模式）。 */
      const TABS = [{ id: "prompts", label: "提示词" }, { id: "test", label: "测试" }]
      const onTabKeyDown = (event) => {
        const index = TABS.findIndex((item) => item.id === tab)
        let next = -1
        if (event.key === "ArrowRight") next = (index + 1) % TABS.length
        else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length
        else if (event.key === "Home") next = 0
        else if (event.key === "End") next = TABS.length - 1
        if (next < 0) return
        event.preventDefault()
        setTab(TABS[next].id)
        focusById("dsh-po-tab-" + TABS[next].id)
      }

      // 保存状态放在页签栏右侧，任何一张卡片触发的保存都在同一处反馈；
      // role=status 让读屏器在「保存中 → 已保存 / 失败」时自动播报。
      // 保存失败自己是 alert；这时外层不再当 status，避免两个 live region 重复播报。
      const saveStatusFails = !saving && status === "ready" && error !== ""
      const saveStatus = saving
        ? h("span", { className: "dsh-po-hint dsh-po-saving" }, "保存中…")
        : status === "ready" && error !== ""
          ? h("span", { className: "dsh-po-error", role: "alert" }, "保存失败：" + error)
          : saved
            ? h("span", { className: "dsh-po-ok" }, "已保存")
            : null

      return h("div", { className: "dsh-po-section" },
        h("div", { className: "dsh-po-head" },
          h("span", { className: "dsh-po-title" }, "提示词优化"),
          h("span", { className: "dsh-po-desc" }, "管理优化时使用的提示词；标记为默认的一条，会在点击输入框旁的星芒按钮时生效。"),
          // 图片入口在「测试」页签，这里给一句指引，避免在提示词页签找不到。
          capabilities.image
            ? h("span", { className: "dsh-po-hint" }, "想附带图片测试？切到「测试」页签，勾选「使用图片作为输入」。")
            : null),

        h("div", { className: "dsh-po-tabbar" },
          h("div", { className: "dsh-po-tabs", role: "tablist", "aria-label": "提示词设置" },
            TABS.map((item) => h("button", {
              type: "button",
              key: item.id,
              id: "dsh-po-tab-" + item.id,
              role: "tab",
              "aria-selected": tab === item.id,
              "aria-controls": "dsh-po-tabpanel",
              tabIndex: tab === item.id ? 0 : -1,
              className: "dsh-po-tab" + (tab === item.id ? " dsh-po-tab-active" : ""),
              onClick: () => setTab(item.id),
              onKeyDown: onTabKeyDown
            }, item.label))),
          h("span", {
            className: "dsh-po-status",
            role: saveStatusFails ? undefined : "status",
            "aria-live": saveStatusFails ? undefined : "polite"
          }, saveStatus)),

        // 首次加载：与真实卡片同尺寸的骨架（150ms 后才显形，快速加载不闪）。
        status === "loading"
          ? h("div", { className: "dsh-po-skeleton-list", role: "status", "aria-label": "正在加载配置…" },
            h("span", { className: "dsh-po-sr" }, "正在加载配置…"),
            [0, 1, 2].map((index) => h("div", { className: "dsh-po-skeleton", key: index, "aria-hidden": true },
              h("span", { className: "dsh-po-skeleton-bar" }),
              h("span", { className: "dsh-po-skeleton-bar" }),
              h("span", { className: "dsh-po-skeleton-bar" }))))
          : null,
        status === "error"
          ? h("div", { className: "dsh-po-alert", role: "alert" },
            h("span", { className: "dsh-po-alert-icon" }, h(AlertIcon, { size: 16 })),
            h("div", { className: "dsh-po-alert-body" },
              h("span", { className: "dsh-po-alert-title" }, "配置加载失败"),
              h("span", { className: "dsh-po-alert-text" }, error)),
            actionButton("重试", load))
          : null,
        // 页签内容整块换页时给一次淡入：class 只负责动效，不改变渲染结构。
        status === "ready"
          ? h("div", {
            className: "dsh-po-panel",
            id: "dsh-po-tabpanel",
            role: "tabpanel",
            "aria-labelledby": "dsh-po-tab-" + tab
          }, tab === "prompts" ? manageTab() : testTab())
          : null
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
