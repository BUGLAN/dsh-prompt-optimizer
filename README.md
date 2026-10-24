# dsh-prompt-optimizer

一个 DeepSeek Harness（DSH）Web 插件：在输入框工具行新增一个 ✨ 图标按钮，点击后调用当前激活模型，把输入框里的提示词优化得更清晰、更具体，并自动回填；优化成功后可一键撤销。设置页新增「提示词」页面，用来管理多条可复用的优化指令并试跑。

> 核心功能封装为可复用、可持久化的 DSH Web 插件包，随组合（composition）挂载后即可随部署自动加载。

## 功能特性

- **一键优化提示词**：点击 ✨ 按钮，将当前草稿改写为更适合 AI 编程助手的高质量提示词；
- **保留意图与语言**：只做清晰化、具体化改写，不改变原任务意图与语言；
- **图标按钮 + 悬停提示**：界面不显示说明文字，仅在鼠标悬停时显示「优化提示词」；
- **输入框内单选切换**：✨ 左侧新增带标题的单选框（圆点 + 当前提示词名称 + 下拉箭头），展开后可在「默认」与各条自定义提示词间切换；每行末尾有独立的图片输入开关（开关本身即入口，不额外显示文字），开关值随提示词保存并实际生效；
- **进度反馈**：优化过程中按钮切换为旋转加载圈（单一动画，不再叠加第二条进度线）；
- **成功后可撤销**：优化完成后图标平滑切换为「回退」勾形箭头（不是刷新环形箭头），点击即还原为点击前的原文；
- **空内容保护**：输入框为空时按钮自动置灰，避免误触发；
- **流式生成**：Host 端通过 `ctx.llm.stream` 流式读取模型输出，再统一回填；
- **提示词设置页**：自定义多条优化指令，可新增 / 编辑 / 删除 / 设为默认，并带测试输入与效果预览；配置持久化并与实际优化联动。
- **每条提示词可选图片输入**：「允许图片输入」是每条提示词自己的参数（`useImages`，默认关闭）。开启后，用这条提示词优化时会把输入框里粘贴的图片（可多张）一并送去；不开启则始终按纯文本处理。模型不支持图片时该勾选框不出现，流程静默退回纯文本。

## 目录结构

```
dsh-prompt-optimizer/
├── package.json        # 包元信息 + dsh.bundle / dsh.client 清单
├── cordis.patch.yml    # 组合补丁：向组合挂载本插件
├── lib/
│   ├── index.js        # Host 半：注册 /api/prompt-optimizer 系列路由
│   ├── prompts.js      # Host 半：提示词文档的校验、持久化与默认解析
│   └── client.js       # Client 半：__ModuleLoader__ 图标按钮 + 设置页
├── test/               # 契约、Host、HTTP、Client 测试
├── CHANGELOG.md
├── LICENSE             # MIT
└── README.md
```

## 工作原理

- **Host 半**（`lib/index.js`）：导出 Cordis 插件，`inject` 依赖 `webServer`、`llm`、`agentDefaultModel`，注册四个精确路由：

  | 方法 | 路径 | 作用 |
  | --- | --- | --- |
  | `POST` | `/api/prompt-optimizer` | 用**当前默认提示词**优化草稿，返回 `{ optimized }` |
  | `POST` | `/api/prompt-optimizer/test` | 用请求里带的指令试跑一段输入（可附带一张 `image`），不写任何配置 |
  | `GET` | `/api/prompt-optimizer/config` | 读取提示词文档、内置指令与 `capabilities` |
  | `POST` | `/api/prompt-optimizer/config` | 校验并保存整份提示词文档 |

  优化时通过 `resolveInstruction(config)` 解析系统提示词：默认提示词存在就用它，否则回落到内置指令。模型来自 `agentDefaultModel.currentSelection()`，经 `ctx.llm.stream` 流式生成。
- **提示词存储**（`lib/prompts.js`）：文档落在 `$DSH_HOME/dsh-prompt-optimizer/prompts.json`（`DSH_HOME` 未设置时为 `~/.dsh`），写入走「临时文件 + rename」的原子替换，并在内存缓存中同步刷新，保存后下一次优化立即可见。文件损坏或不可读时回落到内置指令，不会让优化按钮失效。
- **Client 半**（`lib/client.js`）：通过 `window.__ModuleLoader__.load` 注册，`apply` 时向 `conversation.input.left` 注入 ✨ 与单选触发器、向 `settings.section` 注入「提示词」设置页；读取草稿（`useInput(selector)`，旧宿主回退 `props.input`）、调用接口、再写回（`inputActions.setDraft`）。工具栏与设置页共享一份提示词目录状态。

## 使用说明

### 优化按钮

1. 在输入框输入一段提示词；
2. 可选：单选框位于 ✨ 左侧，触发器上直接显示当前提示词标题。点击展开后选择其他提示词，标题即时更新并保存为默认；每行右侧的开关控制该条提示词是否允许图片输入，开关状态独立保存；
3. 点击输入框工具行左侧的 ✨ 图标按钮；
4. 按钮进入加载状态（旋转图标）；
5. 完成后，优化后的提示词自动替换输入框内容，图标切换为撤销箭头；
6. 点击撤销箭头即可还原成点击前的原文（手动改写过草稿后，箭头会自动退回 ✨，不会覆盖你的编辑）。

### 设置页「提示词」

打开「设置 → 提示词」：

- **提示词 Tab**：「默认」指令始终以只读卡片展示；「新增提示词」可填写名称与优化指令；每条卡片支持「编辑」「删除」「设为默认」，被设为默认的卡片带「默认」徽标；
- **测试 Tab**：选择要测试的提示词（含「默认」），填入测试输入后点击「开始测试」，结果会显示在下方预览区，可一键复制。测试只调用模型，不保存任何改动。
- **允许图片输入（每条提示词）**：编辑提示词时勾选「允许图片输入」，该参数随提示词一起保存，卡片上会显示「含图片」标记。它是这条提示词自己的开关：只有设为默认的那条开启时，✨ 才会把输入框里粘贴的图片一并送去优化。当前模型不支持图片时，勾选框不出现，只显示一行说明。

改动会即时 POST 到 Host 保存；保存失败时界面回滚并显示服务端给出的原因。

## 配置文件

```jsonc
// $DSH_HOME/dsh-prompt-optimizer/prompts.json
{
  "version": 1,
  "defaultId": "",        // "" = 使用「默认」；否则为某条 prompts[].id
  "prompts": [
    { "id": "p1", "name": "工程严谨版", "instruction": "你是提示词优化助手……", "useImages": false }
  ]
}
```

上限：最多 50 条；名称 ≤ 60 字符；指令 ≤ 8000 字符。`defaultId` 指向不存在的条目时会自动回落到「默认」。

## 安装步骤

### 方式一：本地路径安装（已验证，无需网络 / SSH）

```bash
dsh plugin --profile web add "file:/绝对路径/to/dsh-prompt-optimizer"
```

`dsh plugin add` 会自动完成两步：把包写入 profile 的 `dependencies`，并注册进 `dsh.profile.bundles`。重启对应 profile 的 Web 界面后，插件即随组合自动加载，无需每次手动激活。

### 方式二：从 GitHub 安装

```bash
dsh plugin --profile web add "github:<owner>/dsh-prompt-optimizer#main"
```

> ⚠️ 注意：pnpm 对 `github:` 源走 SSH（`git+ssh://git@github.com/...`），要求本机已配置 GitHub SSH 密钥。没有 SSH 密钥时会报 `Permission denied (publickey)`，此时请改用方式一（本地路径）。也可以先把仓库发布到 npm 再用 `dsh plugin --profile web add dsh-prompt-optimizer` 安装。

### 方式三：手动接入组合

在目标 profile 的 `package.json` 中把本包加入 `dependencies` 与 `dsh.profile.bundles`，然后运行 `dsh plugin --profile web install` 并重启。

### 方式四：动态插件（临时试用，不持久化）

仅用于临时验证、重启即失效：

1. 打开 DSH Web 的 Cordis 插件开发能力；
2. 分别把 `lib/index.js`（Host）与 `lib/client.js`（Client）的 `apply` 逻辑封装为动态 Package；
3. 运行并批准。

## 常见问题 (FAQ)

- **按钮为什么是灰色的？** 输入框为空时按钮会自动置灰（`disabled`），避免对空内容发起优化请求；输入内容后即可点击。撤销状态下即使草稿为空也可点击。
- **优化用的是哪个模型？** 使用当前激活的默认模型（`agentDefaultModel.currentSelection()`）；在界面上切换模型即可改变优化所用的模型。
- **优化用的是哪条提示词？** 输入框 ✨ 旁单选框的当前选中项；也可在设置页「设为默认」。没有自定义默认时使用内置指令。工具栏切换会立即持久化，并与设置页的「默认」徽标同步。测试 Tab 只影响预览，不改动默认。
- **为什么点了撤销箭头又变回 ✨？** 当草稿内容与本次优化结果不一致（你手动编辑过）时，撤销不再安全，按钮会自动回到 ✨，避免覆盖你的修改。
- **为什么 `dsh plugin add "github:..."` 报 `Permission denied (publickey)`？** pnpm 对 `github:` 源默认走 SSH。请改用本地路径安装，或先配置 GitHub SSH 密钥，或发布到 npm 后按包名安装（见上文「安装步骤」）。
- **为什么某个选项写着「不支持图片输入」？** 该标签表示选中这条提示词时的实际能力：既要求该提示词的 `useImages` 为 true，也要求当前模型在 `inputModalities` 中声明 `image`。任一不满足都只发送文本；切换模型或提示词后标签会即时更新。
- **为什么看不到「添加图片」？** 图片入口只在当前模型声明支持图片输入时渲染。模型能力取自 `inputModalities`（`Model['input']` 的镜像）：未声明 `image` 时入口整体不出现，也不会发出任何图片相关请求。
- **优化会改变提示词的原意吗？** 内置指令要求只做清晰化、具体化改写，保留原任务意图与语言；若你自己写的默认指令要求别的风格，则以你的指令为准。

## 开发与测试

```bash
npm test         # 契约 + Host + HTTP + Client + 样式回归，共 109 项
npm run test:style   # 只跑对比度审计
```

- `test/contract.test.mjs`：清单、导出、组合补丁与关键代码约定；
- `test/host.test.mjs`：提示词文档校验、持久化、默认解析，以及路由处理函数；
- `test/http.test.mjs`：在真实 `node:http` 服务上跑通四个接口；
- `test/client.test.mjs`：用内置迷你渲染器挂载真实的 `lib/client.js`，驱动按钮与设置页；
- `test/style-audit.mjs`：按主题 token 实测值解析 bundle 里的 CSS，逐条计算 WCAG 对比度；
- `test/support.mjs`：上述测试共用的 React/DOM 测试替身。

### 颜色约定

设置页只使用 `--dsw-alias-*` token，并按实测对比度选配对（主题里的 `brand-primary` 在深色下接近白色，**不可**当作按钮底色再配白字）：

| 用途 | 填充 | 文字 | 对比度 |
| --- | --- | --- | --- |
| 主按钮 | `label-primary` | `bg-base` | 13.34:1 |
| 主按钮 hover / active | 88% / 78% `label-primary` | `bg-base` | 10.67 / 8.73:1 |
| 主按钮 disabled | 10% `label-primary` | `label-secondary` | 5.41:1 |
| 输入框 | 8% `label-primary`，1px 44% 边框 | `label-primary` | 文字 10.46:1，边框 3.03:1 |
| 次要文字 / 占位符 | — | `label-secondary` | 5.76–7.35:1 |

改动样式后跑 `npm run test:style`；低于 4.5:1（非文本边界 3:1）会直接失败。


## 贡献指南

欢迎提交 Issue 与 Pull Request。

- **代码风格**：普通 JavaScript（ESM），不使用 TypeScript/JSX 转译；
- **Host/Client 约定**：Host 半导出 `name` / `inject` / `apply`；Client 半通过 `__ModuleLoader__.load` 注册并返回 `{ inject, apply }`；
- **副作用可逆**：所有注册（路由、槽位、样式）都通过 `ctx.effect` / `slots.inject` 等生命周期 API 挂载，随插件卸载自动清理；
- **数据最小化**：跨端只传递 JSON 标量，不序列化运行时对象；
- **提交前自检**：`npm test` 全绿，并确认 `cordis.patch.yml` 的 `insert` 条目与包名一致。

### 开发流程

1. Fork 本仓库并克隆到本地；
2. 修改 `lib/` 下的 Host/Client 代码；
3. `npm test`，再把本地包链接到 DSH profile 验证 UI 与接口行为；
4. 提交 PR，附上改动说明与截图（如有）。

## 许可证

[MIT](./LICENSE)
