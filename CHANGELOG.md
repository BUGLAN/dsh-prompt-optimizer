# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

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

- **设置页「提示词」**（`settings.section`，order 58）：内置默认指令以只读卡片展示，自定义提示词支持新增 / 编辑 / 删除 / 设为默认；「默认」徽标随选择即时更新。
- **测试 Tab**：选择任意一条提示词（含内置默认），填写测试输入后调用当前模型试跑，结果在预览区展示并可复制。测试走独立接口，不写任何配置。
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
