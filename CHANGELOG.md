# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- **动效统一到一套 token**：原先 6 种时长（0.12/0.16/0.18/0.2/0.22/2.4s）与 5 条各自随手的
  `cubic-bezier` 散落在各条规则里。现在在插件两个根节点上定义 `--dsh-po-dur-*` 与
  `--dsh-po-ease-*`（tap 90ms / fast 120ms / base 180ms / enter 220ms / breathe 2.4s），
  全部过渡与关键帧只引用这套值；变量挂在组件根节点而非 `:root`，不污染宿主主题。
- **补齐缺失的状态反馈**：触发器按下内收、Tab 按下下沉；输入框边框的 hover / focus 由同一条
  过渡接管（原先边框颜色会瞬跳）；开关滑块与箭头保留轻微过冲，其余位移一律无回弹。
- **进场动效**：设置页卡片按行错开 25ms 进场，徽标、「已保存 / 保存失败」状态文本、
  结果预览、缩略图、空状态、页签容器各自有只动 `opacity` / `transform` 的进场。
  卡片的 `key` 由 `prompt.id` 决定，保存时的重渲染不会重放进场。
- **浮层与遮罩**：浮层从触发器一侧（`bottom left`）长出，遮罩同帧淡入；关闭时面板即时卸载，
  `aria-expanded` 不依赖动画结束事件。
- **选中竖条改用 `scaleY` 生长**，不再对 `height` 做过渡，切换选中时该行不再逐帧重排。
- **呼吸动画可中断**：关键帧从 3 帧补到 6 帧，相邻帧间距均匀，请求在任意一帧结束都不会
  突然弹回静止位；振幅由 1.06 / 4° 收到 1.03 / 3.5°，28px 按钮内不再蹭到相邻图标；
  请求结束时 `drop-shadow` 辉光按 base 档淡出，而不是硬切。
- **`prefers-reduced-motion` 合并为一处兜底**：原先散落的 3 条只覆盖 4 个选择器，
  现在统一覆盖全部过渡与关键帧，并额外取消按下位移。

### Fixed

- **`animation` 简写里的 `var()` 缺少回退值会让整条声明失效**：浮层、卡片、徽标等进场动画
  在浏览器里实际为 `animation-name: none`（单测只做字符串匹配，无法发现）。已为全部
  86 处 token 引用补上回退值。

### Verification

- `npm test` 112 项全通过；`node test/style-audit.mjs` 输出 `ALL PAIRS PASS`。
- 用真实渲染核对（非字符串断言）：浮层进场 `opacity` 0 → 0.57 → 0.92 → 1、`scale` 0.96 → 1；
  箭头 220ms 翻转 180°；开关滑块 113ms 过冲到 12.29px 后收回 12px；选中竖条 `scaleY`
  0 → 0.84 → 1；忙碌结束时辉光淡出到 `none`；开启 reduced-motion 后全部进场动画为 `none`、
  过渡为 1ms。

## [1.4.0] - 2026-10-24

### Changed

- **优化按钮图标改为单色星芒 SVG**：原先的彩色 ✨ emoji 是工具栏里唯一一枚彩色字形，
  视觉上像贴纸，且字形随系统 emoji 字体变化。现在改为 `fill:currentColor` 的几何星芒，
  悬停、禁用、深浅主题全部自动跟随，跨平台一致。
- **下拉触发器重做**：去掉暗示「单选」的空心圆点（这里点开的是菜单），也不再放星芒
  （会与右侧执行按钮撞成两枚一样的图标），只保留「当前提示词标题 + 箭头」。
- **箭头反映展开状态**：`open` 时绕自身旋转 180°，220ms 回弹曲线，这是判断面板
  开合的第一视觉线索。
- **浮层做成实体面板**：细描边 + 收敛后的双层阴影 + 160ms 入场动画；当前项改用左侧
  2px 竖条标记，不再只靠整行底色深浅；「内置」徽标从浅底改为细描边。
- **图片开关跟随文字色**：去掉荧光绿，避免面板里两行都开启时与「当前选中哪条」争夺注意力。
- **设置页层级与可操作性**：标题加重到 17px/600，说明文字限制在 62ch 以免行长过宽；
  选项卡、卡片操作按钮、勾选框与「添加图片」入口统一到 32–36px 的可点击高度，
  并补上 hover / 按下 / 键盘聚焦与 disabled 聚焦状态。
- **浮层与触发器的语义关联**：触发器通过 `aria-controls` 指向浮层 `id`，
  读屏与自动化都能明确知道这个按钮展开的是哪块面板。

### Fixed

- **呼吸辉光被裁掉**：`.dsh-po-btn` 上的 `overflow:hidden` 会裁掉画在盒外的 `drop-shadow`，
  导致加载动画几乎看不见。已移除该属性。
- **CSS 注释里的引号污染样式表**：`CSS` 数组按字符串抽取时，JS 注释中的中文引号会被
  一并扫入，产生残缺规则，使 `.dsh-po-popover` 之后的规则（浮层定位、背景、描边、
  开关态）整段失效。注释已改写，抽取逻辑也收紧为只接受以 `.`/`@`/`:` 开头的字符串。

### Verification

- `npm test` 112 项全通过；对比度审计 `ALL PAIRS PASS`。
- 把 `lib/client.js` 的真实 CSS 与真实星芒路径抽入独立页面渲染，核对深/浅主题、
  收起/展开、悬停/按下/禁用三态，并用 `getAnimations()` 确认呼吸动画处于 running。

## [1.3.1] - 2026-10-24

### Changed

- **加载动画改为「原样 ✨ 呼吸」**：优化进行中不再把图标换成描边旋转圈，
  而是保留同一枚彩色 emoji，叠加 `scale` / 微旋 / 暖色 `drop-shadow` 的呼吸动画。
  加载前后是同一个视觉符号，不再出现「符号突然消失」的割裂感。
- 呼吸动画只作用于 `.dsh-po-spark`，`.dsh-po-glyph` 的入场过渡保持原样；
  `busy` 不再参与 React `key`，避免每次进出加载态都重新挂载并打断动画。

### Removed

- `SpinnerIcon` 组件、`.dsh-po-spinner` 类与 `@keyframes dsh-po-spin`。
  加载态与其下划线进度条属于重复表达，现在只保留一种。

### Verification

- `npm test` 109 项全通过；新增断言覆盖：加载中不替换图标、
  按钮内不出现任何额外文案、CSS 里 `dsh-po-breathe` 存在且 spinner 相关规则已删除。

## [1.3.0] - 2026-10-24

### Added

- **输入框工具栏新增「优化提示词」单选框**：位于 ✨ 左侧。
  触发器显示「圆点 + 当前提示词标题 + 下拉箭头」，标题过长时省略；
  `conversation.input.left` 内保持 28px 行高，不改变输入框或发送区布局。
- **每个提示词一个可交互的图片输入开关**：弹出列表每行右侧是真实 toggle，
  不额外显示文字标签；打开即允许该条提示词携带草稿图片，关闭则只发送文本。开关值随提示词持久化：
  自定义条目写入 `prompts[].useImages`，内置条目写入 `builtinUseImages`。
- **开关失败回滚**：保存中禁用所有选项；失败时恢复原值并在浮层内显示服务端原因。

### Behavior

- 默认选中项与既有配置一致：`defaultId` 指向有效的自定义提示词时选中它，
  否则选中「默认」。切换后标题立即更新，旧配置无需迁移。
- 开关的保存与默认项切换共用同一条 `POST /api/prompt-optimizer/config` 路径；
  切换图片开关不会改变当前选中的提示词，浮层保持打开以便连续调整。
- 实际是否发送图片仍由「该提示词开关已打开」且「当前模型 `inputModalities`
  含 `image`」共同决定。模型不支持时开关状态保留，悬停说明会解释暂不发送图片。
- 设置页的内置卡片也提供同一开关；工具栏与设置页共享提示词目录状态。

### Fixed

- 选项整行均可点击切换提示词；名称、行内空白和隐藏 radio 都指向同一选择逻辑，
  右侧开关阻止冒泡，不会误切换当前提示词。
- 保存开关时不再临时渲染「正在保存…」行，浮层高度与 `max-content` 宽度保持稳定；
  busy 状态只禁用控件，不改变菜单结构。

### Verification

- 新增 Client 交互测试：触发器位于 ✨ 左侧、触发器标题随选择更新、
  每行 toggle 的数量与 ARIA、内置项 `builtinUseImages` 保存、开关失败回滚、
  以及打开开关后下一次 ✨ 请求确实携带图片。
- 菜单采用与宿主一致的紧凑样式：无标题/说明/页脚三段式堆叠，选项单行显示；
  行首不显示额外单选图标，选中行仅以浅色底标识，图片能力由开关本身表达。
- 新增回归：点击选项行空白处可切换提示词；开关保存期间菜单行数与结构不变。
- `npm test` 共 109 项，全部通过；`npm run test:style` 通过。

## [1.2.0] - 2026-10-23

### Added

- **每条提示词一个「允许图片输入」参数**：`prompts[].useImages`（布尔，默认 false）。
  勾选后，用该条提示词优化时会把输入框里粘贴的图片一并送去；不勾选则始终按纯文本处理。
- 该参数随配置持久化，并直接决定 ✨ 按钮的行为：默认提示词的 `useImages` 即全局生效值。
- 设置页每条提示词的编辑卡片内新增勾选框；勾选过的提示词在卡片上显示「含图片」标记。

### Behavior

- **图片来源**：输入框里粘贴/拖入的图片，可有多张。它们由宿主 Conversation 服务持有，
  通过 `InputState.attachmentIds` + `ctx.get("conversation").resolveDraftAttachments()` 取回，
  仅挑出 `kind === 'image'` 的附件，转成 base64 后按原顺序批量提交。
- **三重门槛**：模型支持图片（`inputModalities` 含 `image`）＋ 该提示词 `useImages === true`
  ＋ 输入框确实有图片。任一不满足就只发文本，请求体与旧版本完全一致。
- **不支持时静默降级**：不渲染勾选框（改为一行说明）、不调用上传接口、不发起任何图片请求、
  不报错也不提示。
- 单张图片读取失败不影响其余；Conversation 服务缺失或抛错时整体回退为纯文本。
- 支持图片但载荷非法时（非白名单媒体类型、超出 `imageLimits.maxImageBytes` / `maxImagesPerMessage`）
  返回 400 并在界面提示。

### Verification

- 实机双向验证（默认模型 `capabilities.image = true`，64×64 红圆 PNG）：
  - `useImages: true` → 模型回「一个红色的圆形。」（图片确实进入请求）；
  - 同一条提示词改为 `useImages: false`、同一载荷 → 模型回「我这边没有收到图片，无法描述其中的内容。」。
- 以真实解析器返回 `['text']` 运行同一载荷：HTTP 200、上传调用 0 次、内容块仅 `["text"]`。
- `npm test` 共 89 项，全部通过。

## [1.1.1] - 2026-10-23

### Fixed

- **主操作按钮文字不可读**：`.dsh-po-primary` 用 `background:var(--dsw-alias-brand-primary)` + `color:#fff`。本主题下品牌色解析为近白（实测 `#d9dadb`），白字叠上去只有 **1.40:1**，截图里「保存」「开始测试」几乎看不见字。改为主题自带的对比组合：填充 `label-primary`、文字 `bg-base`（**13.34:1**）；hover 10.67:1、active 8.73:1、disabled 5.41:1，四种状态全部重新定义。
- **输入框看起来不像输入框**：`.dsh-po-input/.dsh-po-textarea` 的 `border` 用了 `--dsw-alias-border-l2`，该 token 在本主题解析不出颜色，边框完全不显示；又因为 `.5px` 在 1x 屏常被抹掉，名称输入、指令文本域、测试输入都退化成一排裸文字。改为自带 surface（`label-primary` 8%）+ 1px 实边框，边框对表面 **3.03:1**，满足 WCAG 1.4.11 的非文本对比度。
- **占位符过淡**：placeholder 未设色，落到浏览器默认色（实测 3.02:1，且随 UA 变化）。显式设为 `label-secondary` 且 `opacity:1`，实测 **5.76:1**。
- 设置页所有文字不再用 `opacity` 压暗：`.dsh-po-desc/.dsh-po-label/.dsh-po-hint/.dsh-po-text/.dsh-po-empty` 改用 `label-secondary`，`.dsh-po-tab` 的选中/未选中改用色值而非透明度。
- 危险色与成功色改为 `#f87171` / `#4ade80`（原 `#dc2626` 在深色底上仅 2.89:1），并对 `--dsw-alias-state-*` 保留 token。
- 焦点环由近白的品牌色改为 `label-primary`，保证在深色背景上可见。

### Changed

- **回退图标换形**：原 `rotate-ccw` 的环形箭头与「刷新」几乎同形，容易误解为重新生成。改为开口左向勾形（Lucide `undo-2`）：箭头在左上、弧线向右敞口，与刷新（闭环 + 右上箭头）明显区分。
- 新增 `test/style-audit.mjs`：把 bundle 的 CSS 按实测 token 解析，逐条计算 WCAG 对比度；`npm run test:style` 可单独运行，`npm test` 中也会执行。

## [1.1.0] - 2026-10-23

### Added

- **设置页「提示词」**（`settings.section`，order 58）：「默认」指令以只读卡片展示，自定义提示词支持新增 / 编辑 / 删除 / 设为默认；「默认」徽标随选择即时更新。
- **测试 Tab**：选择任意一条提示词（含「默认」），填写测试输入后调用当前模型试跑，结果在预览区展示并可复制。测试走独立接口，不写任何配置。
- **持久化配置**：提示词文档保存到 `$DSH_HOME/dsh-prompt-optimizer/prompts.json`，采用临时文件 + rename 的原子替换；文件损坏或不可读时回落到内置指令，不影响优化按钮。
- **配置与优化联动**：`POST /api/prompt-optimizer` 通过 `resolveInstruction(config)` 取默认提示词作为系统提示词，设为默认的指令在下一次优化即生效。
- **新增接口**：`GET/POST /api/prompt-optimizer/config`、`POST /api/prompt-optimizer/test`。
- **测试**：新增 Host / HTTP / Client 三组测试（含一个内置迷你 React 渲染器用于挂载真实 client 代码），共 52 项。

### Changed

- 优化成功后的图标不再是静态 ✨：切换为「回退/撤销」箭头，点击即把草稿还原为点击前的原文；图标切换带缩放 + 淡入过渡，并遵循 `prefers-reduced-motion`。
- 撤销仅在草稿仍等于本次优化结果时可用；用户手动编辑后自动退回 ✨，避免覆盖用户输入。
- 模型原样返回（优化结果与原文相同）时不提供无效的撤销态。
- `lib/index.js` 抽出 `optimize()` 复用同一段模型调用，提示词文档逻辑独立到 `lib/prompts.js`。

### Removed

- 删除按钮底部的 `_` 滑动进度条（`.dsh-po-progress` 及其 `dsh-po-slide` 关键帧）。它与旋转加载圈表达同一件事，属于重复动画。

### Fixed

- `POST /api/prompt-optimizer/config` 不再把无关请求体当成空文档处理：缺少 `prompts` 且未用 `{ config }` 包裹时返回 400，避免误清空已保存的提示词。

## [1.0.4] - 2026-09-12

### Fixed

- 1.0.3 的禁用态过度保守（opacity .95 + saturate .45 对 15px emoji 几乎不可感知），启用/禁用看起来相同。改为 `filter:grayscale(1)`：禁用 = 纯灰 ✨，启用 = 全彩 ✨，色相差异一眼可辨；同时实测前景对比度 35.4 vs 35.8（像素统计），禁用态与启用态一样清晰、不再发虚。

## [1.0.3] - 2026-09-12

### Fixed

- 禁用态图标过淡难以辨认：原「次级文字色 + 45% 透明度」双重衰减把 ✨ emoji 压得近乎隐形。现改为保持亮度（opacity .95）+ 降饱和（saturate .45）表达禁用感，配合原有 `cursor:not-allowed`，语义清晰且看得清。
- 样式注入改为幂等刷新：HMR 热替换模块（不刷新页面）时旧样式元素会残留上一版 CSS，此前"已存在即跳过"的写法让新样式永不落地；现每次 apply 都重写 textContent。

## [1.0.2] - 2026-09-11

### Changed

- 空闲图标由手绘 SVG 星芒改为真正的 ✨ emoji 字形（15px，随主题文字色），加载旋转图标保持不变。
- 已在 DSH Web 0.1.5-rc.x 环境经 headless 浏览器端到端实测：输入解除置灰、点击优化、草稿回填全链路正常（1.0.1 的 `useInput` 契约兼容代码在新宿主下无回归）。

## [1.0.1] - 2026-09-10

### Fixed

- 适配 DSH Web 0.1.2 槽位系统重构：`conversation.input.left` 的渲染点不再把 `input` 快照作为 owner props 下发，草稿改经会话标准 kit 的 `useInput(selector)` hook 提供（`inputActions` 仍为 prop）。旧读法恒得 `undefined`，✨ 按钮被永久置灰。现优先走 `useInput`，同时保留对旧宿主 `props.input` 的兼容回退。
- Host 半无需改动：`webServer` / `llm` / `agentDefaultModel` 契约在 0.1.2-rc.1 中保持不变（已对运行中的实例实测 `POST /api/prompt-optimizer` 返回正常）。

## [1.0.0] - 2026-08-18

### Added

- 首次发布 `dsh-prompt-optimizer`：在 DSH Web 输入框工具行左侧新增 ✨ 图标按钮，一键调用当前激活模型把草稿提示词优化得更清晰、更具体，并自动回填。
- Host 半：注册 `POST /api/prompt-optimizer` 数据路由，读取当前默认模型并通过 `ctx.llm.stream` 流式生成优化结果。
- Client 半：通过 `__ModuleLoader__` 向 `conversation.input.left` 槽位注入图标按钮，含悬停提示、加载旋转圈与底部进度条、空内容置灰保护。
- 组合补丁 `cordis.patch.yml`：随 profile 组合自动挂载，`dsh plugin add` 后重启即可持久化加载。
- 安装方式：本地路径、`github:` 源、手动接入组合、动态插件（临时试用）。
