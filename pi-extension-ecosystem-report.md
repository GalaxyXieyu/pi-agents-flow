# pi-coding-agent Extension 生态调研报告

> **调研时间**：2026-08-10
> **调研范围**：pi-coding-agent 生态（官方内置、官方 examples、社区贡献），时间窗口 2024-09 至 2026-01
> **调研方法**：三条并行 research lane（官方机制 / 社区 skills / 安装途径），交叉核验
> **证据基准**：`@earendil-works/pi-coding-agent@0.81.0` 官方文档 + GitHub 仓库 + 社区实测

---

## 摘要

pi-coding-agent 的 Extension 生态由两种形态构成：**Extension（TypeScript 代码模块）** 和 **Skill（Agent Skills 标准指令包）**。官方内置 70+ 参考扩展示例，社区 skills 生态（skills.sh）安装量最高的 find-skills 已达约 300 万 installs。

**当前最值得上手的 Extension 组合**：
- **研究类**：`deep-research` + `dynamic-workflow`（多通道可追溯研究流水线）
- **知识积累类**：`llm-wiki-skill`（Karpathy 式自编译 wiki）
- **多代理/桌面操作类**：`orca-cli` / `orchestration` / `computer-use`（每日发版，结构化多代理协调）
- **发现/安装类**：`find-skills`（生态第一安装量，持续发现新能力）
- **子代理编排类**：`pi-agents-flow`（并行 fork 子代理，减少上下文膨胀）

---

## 1. Extension 与 Skill：pi 的两种扩展形态

pi-coding-agent 的能力扩展通过 **Extension** 和 **Skill** 两种形态实现，官方文档明确区分：

### 1.1 Extension（TypeScript 代码模块）

- **定义**：TypeScript 模块，导出接收 `ExtensionAPI` 的默认工厂函数，通过 `jiti` 在运行时加载（**无需编译**）。
- **核心能力**：
  - 订阅生命周期事件（`session_start` / `before_agent_start` / `tool_call` 等 30+ 事件）
  - 注册自定义工具（`pi.registerTool()`，LLM 可调用）
  - 注册斜杠命令（`pi.registerCommand()`，如 `/plan`、`/review`）
  - 注册键盘快捷键、CLI flag、自定义 provider、自定义 TUI 渲染
  - 拦截/改写事件（block tool call、modify tool result、transform input）
- **加载路径**：
  - 全局：`~/.pi/agent/extensions/*.ts` 或 `*/index.ts`
  - 项目局部：`.pi/extensions/*.ts` 或 `*/index.ts`（需项目受信任）
  - 热重载：`/reload`
  - 临时测试：`pi -e ./my-extension.ts`（`--extension` flag）
- **定位**：编程式接入，深度嵌入 pi 运行时，改工具、改事件、改 UI。

### 1.2 Skill（Agent Skills 标准指令包）

- **定义**：遵循 [Agent Skills 标准](https://agentskills.io/specification) 的目录包，包含必需的 `SKILL.md`（frontmatter 定义 `name` 和 `description`），可附带 `scripts/`、`references/`、`assets/`。
- **核心能力**：
  - 提供专业化工作流、setup 指令、helper 脚本、参考资料
  - 注册为 `/skill:name` 命令（`/settings` 中 `enableSkillCommands` 开关）
  - 渐进式披露：启动时只扫描名称与描述注入系统提示，任务匹配时才加载完整 `SKILL.md`
- **加载路径**：
  - 全局：`~/.pi/agent/skills/`、`~/.agents/skills/`
  - 项目：`.pi/skills/`、`.agents/skills/`（从 cwd 向上搜索）
  - CLI：`--skill <path>`（可重复，`--no-skills` 下仍加载）
  - 跨 harness 复用：`settings.skills` 数组可加入 `~/.claude/skills`、`~/.codex/skills`
- **定位**：工作流/文档式接入，一套可复用的提示词、脚本与参考文档，按需加载。

### 1.3 选型原则

| 需求 | 优先形态 | 示例 |
|------|---------|------|
| 改工具、改事件、改 UI | Extension | 权限闸门、Git 检查点、自定义 provider |
| 叠加可复用工作流 | Skill | deep-research、llm-wiki、ui-motion |
| 两者兼有 | Extension + Skill | subagent/（extension）+ skills/（指令） |

---

## 2. 官方内置 Extension：70+ 参考示例

官方 `examples/extensions/` 目录内置了 **70+ 个可直接照抄的参考扩展**（从 `hello.ts` 最小示例到复杂实现）。以下是最能代表"机制能力"的 5 个：

### 2.1 `subagent/` —— 子代理编排

- **能力**：把任务委托给拥有**独立上下文窗口**的专业子代理；每个子代理运行在独立 `pi` 子进程。支持单代理、并行（最多 8 任务、4 并发）、链式（`chain` 带 `{previous}` 占位符）、markdown 输出、每代理用量统计（turns/tokens/成本/上下文）、Ctrl+C 中止传播。
- **入口结构**：`index.ts`（扩展）+ `agents.ts` + `agents/`（scout/planner/reviewer/worker 的 `.md` 定义）+ `prompts/`（工作流模板）。
- **使用**：
  ```bash
  mkdir -p ~/.pi/agent/extensions/subagent
  ln -sf .../examples/extensions/subagent/index.ts ~/.pi/agent/extensions/subagent/index.ts
  ln -sf .../examples/extensions/subagent/agents.ts ~/.pi/agent/extensions/subagent/agents.ts
  ```
  交互示例：`Run 2 scouts in parallel: one to find models, one to find providers`；
  工作流：`/implement add Redis caching to the session store`、`/implement-and-review add input validation`。

### 2.2 `plan-mode/` —— Claude Code 风格计划模式

- **能力**：只读探索模式。内置 `edit`/`write` 工具禁用，bash 走命令白名单（只允许 `cat/find/grep/git status` 等）；从 `Plan:` 段落提取编号步骤；`[DONE:n]` 标记跟踪进度；`/plan` 命令 + `Ctrl+Alt+P` 快捷键 + `--plan` flag；状态跨会话持久化。
- **演示 API**：`registerCommand`、`registerShortcut`、`registerFlag`、`setStatus`、`setWidget`、`sendMessage`、`setActiveTools` 的组合用法。

### 2.3 `todo.ts` —— 有状态的工具 + 状态管理范式

- **能力**：为 LLM 注册 `todo` 工具（list/add/toggle/clear）+ 用户 `/todos` 命令，带自定义 TUI 渲染。**关键范式**：状态存在工具结果 `details`（而非外部文件），从而在 `/fork` 分支时 todo 状态自动正确；`session_start` 时从 `ctx.sessionManager` 重建状态。
- **演示 API**：`registerTool`（`StringEnum` 参数，Google 兼容）、`registerCommand`、`appendEntry`、`renderResult`、`ui.custom` 组件。

### 2.4 `ssh.ts` —— 远程执行与可插拔工具操作

- **能力**：通过可插拔的 Operations 接口（`ReadOperations`/`BashOperations`/`WriteOperations`/`EditOperations`/`LsOperations`/`GrepOperations`/`FindOperations`）把所有内置工具委托到远程机器；`user_bash` 钩子可替换本地 bash 后端；`before_agent_start` 注入远程上下文；`--ssh` flag 控制。

### 2.5 `custom-provider-anthropic/` —— 自定义 provider

- **能力**：注册自定义 Anthropic provider，含 OAuth 支持与自定义流式实现；配对 `custom-provider-gitlab-duo/`（经代理用 pi-ai 内置流式）。

**其他值得注意的内置示例**：`permission-gate.ts`（危险命令拦截）、`protected-paths.ts`（保护 `.env`/`node_modules`）、`git-checkpoint.ts`（每轮 git stash 检查点）、`dynamic-tools.ts`（运行时注册工具）、`structured-output.ts`（`terminate: true` 结构化收尾）、`preset.ts`（模型/工具/思考级别预设）、`tools.ts`（`/tools` 开关）、`handoff.ts`（跨会话交接）。

---

## 3. 社区 Skills 生态高频 Extension

### 3.1 deep-research（项目内技能，Pi 专用）

- **形态**：skill（指令包）
- **核心能力**：产出"有来源支撑的研究交付物"——并行 research 通道、定向验证、接受声明合成、独立评审。含 `references/question-decomposition.md`、`reference/source-and-search-policy.md`、`conflict-and-gap-policy.md`、`synthesis-and-review.md`。
- **典型用例**：报告/简报/证据评审/技术对比备忘录；与 `dynamic-workflow` 配合在根 Pi 会话运行默认长文工作流。
- **对 pi 工作流增强**：**高**——把研究从闲聊式问答升级为多通道、可追溯、有评审门禁的流水线。
- **维护活跃度**：随仓库演进，活跃（自带评审门禁与 gate）。
- **上手成本**：中——需遵循 scope guard（研究与可发布文章分流）。

### 3.2 dynamic-workflow（项目内技能，Pi 专用）

- **形态**：skill（指令包）
- **核心能力**：在根 Pi 会话运行 supervisor 持有的耐久工作流——动态创建有界子代理、调度类型化 DAG、结构化结果评估、经显式 accept/repair 收敛。通过 `workflow` 工具作为状态转移边界。
- **典型用例**：多节点研究/实现/评审编排；`apply_plan`（tasks + workUnits）与 `run_ready`。
- **对 pi 工作流增强**：**高**——Pi 原生多代理编排。
- **维护活跃度**：随仓库演进，活跃。
- **上手成本**：中——约束多（child completion ≠ acceptance 等）。

### 3.3 pi-agents-flow（官方 workflow 运行时，即本 repo）

- **形态**：Pi 官方 workflow 运行时（本 repo `pi-agents-flow`，注意有 **s**）
- **核心能力**：完整的 supervisor-led durable workflow 引擎——typed DAG 调度（research → verification → section-writer → editor → reviewer）、显式 accept/reject 门禁、repair loop、deep-research 模式、coding preset、quality gates、observability。通过 `workflow` 工具作为状态转移边界。
- **典型用例**：多节点研究/实现/评审编排；`apply_plan`（tasks + workUnits）与 `run_ready`；Deep Research 报告生成；Coding DAG（plan → build → verify）。
- **维护活跃度**：**高**——Pi 团队维护，随仓库持续演进。
- **上手成本**：中——约束多（child completion ≠ acceptance、output contract V1 等）。

> ⚠️ **注意区分**：社区有一个名字几乎一样的独立项目 **`pi-agent-flow`**（**没 s**，作者 tuanhung303，`pi install npm:pi-agent-flow`）。它是轻量级子代理 fork 编排（scout/build/debug/audit flows），功能范围远小于本 repo 的完整 workflow 引擎。两者不是同一个东西。

### 3.4 llm-wiki-skill（Lewis Liu 的 Karpathy 式知识库技能）

- **README**：https://github.com/lewislulu/llm-wiki-skill
- **形态**：skill（OpenClaw/Codex/Pi 通用）
- **核心能力**：构建"自编译"的交叉链接 Markdown wiki——`compile`/`ingest`/`query`/`lint`/`audit` 五操作；附带 `plugins/obsidian-audit/`（Obsidian 注释插件）与 `web/`（本地 Node 预览/反馈服务器，mermaid/KaTeX/wikilinks）。
- **典型用例**：研究深潜、个人 wiki、团队知识库、读书伴读。
- **维护活跃度**：**中**——README 标注 "Experimental skill — will iterate over time"，社区 fork 多，说明被广泛二次开发。
- **上手成本**：中——需 scaffold + 多脚本工具链。

### 3.5 find-skills（vercel-labs/skills）

- **README**：https://github.com/vercel-labs/skills（`skills/find-skills/SKILL.md`）
- **形态**：skill（发现型）
- **核心能力**：引导 agent 发现并安装开放生态技能——`npx skills find [query] [--owner]`、`npx skills add`、`npx skills update`；优先推荐安装量 >1000、来源可信（Vercel/Anthropic）、高 star 的技能。
- **典型用例**：用户问"how do I do X / find a skill for X"。
- **维护活跃度**：**最高**——生态内安装量第一（~3M Installs）。
- **上手成本**：低。

### 3.6 computer-use / orca-cli / orchestration（stablyai/orca）

- **README**：https://github.com/stablyai/orca
- **形态**：skill（Orca 关联）
- **核心能力**：
  - **computer-use**：通过 Orca 的 computer-use CLI 用 accessibility tree、截图、安全 UI 动作操作桌面应用窗口（list-apps、get app state、click、type、keypress、scroll、drag、set values）。
  - **orca-cli**：操作 Orca-managed worktrees、folder contexts、terminals、repos、automations、内嵌浏览器。
  - **orchestration**：结构化多代理协调——threaded messages、阻塞 ask/reply、task dispatch、worker_done/escalation waits、task DAG、decision gates。
- **典型用例**：桌面应用交互（Spotify/Slack）、浏览器窗口、spawn codex/claude in a worktree、多代理 DAG 协调。
- **维护活跃度**：**高**——Orca 每日发版（"we ship daily"），MIT，活跃 Discord/社区。
- **上手成本**：中。

### 3.7 ui-motion-router / brand-assets（本地 ~/.agents/skills）

- **形态**：skill（路由型 / 资产处理型）
- **核心能力**：
  - **ui-motion-router**：把前端视觉设计/Apple 风格交互/UI 打磨/动画命名/motion 审计/动画机会发现/动画评审/UI 库选择路由到已安装的专业技能（animation-vocabulary、apple-design、emil-design-eng、find-animation-opportunities、improve-animations、review-animations、pick-ui-library、brand-assets）。
  - **brand-assets**：品牌视觉资产处理——Logo/IP 部署、sprite 自动切图、角色提取、空状态装饰、渐变与品牌规范应用。
- **典型用例**：一次请求精准触发最窄的 motion 技能，避免全量加载；用户提到"切图/拆分 sprite/Logo/LUMO/品牌资产/mascot/空状态/品牌规范"时触发。
- **维护活跃度**：随本地技能集演进。
- **上手成本**：低。

---

## 4. 安装与发现途径

发现与安装 pi Extension 主要有四条途径：

### 4.1 `--skill` / `--extension` 命令行标志

- `--skill <path>`：可重复，加载指定 skill；即使在 `--no-skills` 下也仍会加载（additive）。
- `--extension`（别名 `-e`）：可重复，加载指定 TypeScript 扩展；`pi -e npm:package-name` 可单会话试用一个 package 而不安装。
- `--no-skills` / `--no-extensions`：关闭自动发现，用于隔离/调试。

### 4.2 目录约定（自动发现）

pi 在启动时扫描以下位置的扩展与 skill：
- **Extensions**：`~/.pi/agent/extensions/`（全局）、`.pi/extensions/`（项目，需项目受信任）。
- **Skills**：全局 `~/.pi/agent/skills/`、`~/.agents/skills/`；项目 `.pi/skills/`、`.agents/skills/`（从 cwd 向上搜索，直到 git 仓库根或文件系统根）。另外 settings 的 `skills` 数组可显式加入目录（例如复用 Claude Code 的 `~/.claude/skills` 与 Codex 的 `~/.codex/skills`）。
- 目录内直接根级 `.md` 文件在 `~/.pi/agent/skills/` 与 `.pi/skills/` 会被当作独立 skill；含 `SKILL.md` 的子目录被递归发现。

### 4.3 package 安装（pi packages 机制）

pi packages 把 extensions、skills、prompt templates、themes 打包成可分发的单元，通过 npm 或 git 共享。

- **创建**：在 package.json 加 `pi` 键指向各资源目录（如 `pi.extensions: ['./extensions']`、`pi.skills: ['./skills']`），并加关键字 `pi-package` 以便在 npm 上被发现。
- **安装**：`pi install <source>`，source 可以是 npm 包、git 仓库或本地路径：
  - `pi install npm:package-name`
  - `pi install git:github.com/user/repo`
  - `pi install ./path/to/package`
  - 默认装到用户 settings；`-l` 装到项目本地 settings（可随团队共享）；`-e` 仅单会话试用。
- **管理**：安装后用 `pi config` 启用/禁用包内具体的 extension、skill、prompt、theme。

### 4.4 社区发现途径

- **Pi Map**（https://www.pi-map.org）是社区维护的资源/新闻中心，按 extension、skill、project 分类收录生态。
- 社区 skill 可在 pi 内直接搜索安装：`/skill:pi-package-search [keyword]`（forjd/pi-package-search）、pi-find-packages、pi-marketplace 等会检索 npm 上带 `pi-package` 标签的包。
- 官方 skill 仓库：badlogic/pi-skills（web search、browser automation、Google APIs、transcription）；Anthropic Skills 仓库可直接复用。
- skills.sh 生态：`npx skills find <query>` 搜索、`npx skills add <owner/repo>` 安装、`npx skills update` 更新、`npx skills use <source>` 免安装临时使用。

---

## 5. 选型评估维度

评估一个 pi Extension 是否值得加入工作流，建议用四个维度，并给出可核对的证据来源：

### 5.1 维护活跃度（Maintenance Activity）

- **证据**：GitHub 最近提交/发布节奏、npm 包最近版本时间、README 是否与当前 pi 版本适配、issue 是否得到回应。
- **打分口径**：近 3 个月有提交/发布 = 活跃；近 1 年无更新 = 高风险，尤其当依赖的 pi API 变化时。

### 5.2 对核心 pi 工作流的增强幅度（Workflow Enhancement）

- 判断该扩展是否触及你日常高频动作：连接外部工具、调度子 agent、产出研究/创作成果、自动化重复操作。
- 增强幅度 = 省下的手动步骤数 × 使用频率。只在冷门场景有用的扩展，增强幅度低。

### 5.3 上手成本（Onboarding Cost）

- 安装是否一行命令（`pi install npm:...`，成本低）；是否需要额外 API key、环境变量、编译（成本高）。
- 是否自带 `SKILL.md`/README 的清晰 Setup 与 Usage（skill 需在首次使用前跑 setup，如 `npm install`）。
- `.pi/extensions/` 手写扩展需要 TypeScript 知识，成本最高。

### 5.4 稳定性（Stability）

- 是否官方内置/官方 examples（最稳）；社区但纯文档型 skill（稳定，因为不深入运行时）；社区但深度改运行时/UI 的 extension（风险较高，需随 pi 升级验证）。
- 注意安全：skills 可指示模型执行任意动作并可能含可执行代码——官方文档明确要求「review skill content before use」。项目信任（trust）机制也决定扩展是否在项目中生效。

### 5.5 可操作判断清单（照抄即用）

1. 该扩展是否仍在维护（看最近提交/发布）？
2. 它是否增强你每周至少用几次的核心流程？
3. `pi install` 一行搞定，还是需要 API key/编译/env？
4. 来源是否官方/官方 examples/可信社区，是否含可执行代码需审查？
5. 是否与当前 pi 版本匹配（看 README/兼容性字段）？

以上 4 项通过即可尝试单会话 `-e` 试用，再决定 `-l` 项目化或全局安装。

---

## 6. 三种典型用户的最小组合建议

| 用户类型 | 推荐组合 | 理由 |
|---------|---------|------|
| **编码型** | 官方 examples 内置扩展（`plan-mode`、`todo`、`permission-gate`）+ 自定义 `.pi/extensions/` | 优先 extension 形态，改工具、改事件、改 UI；从官方 examples 起步，成本最低 |
| **调研型** | `deep-research` + `dynamic-workflow` + `llm-wiki-skill` | 多通道可追溯研究流水线；确定性 plan-search-reflect-iterate 流程；知识库持续积累 |
| **创作型** | `ui-motion-router` + `brand-assets` + `find-skills` | 前端视觉/动画/品牌资产一站式处理；持续发现新能力 |

**通用推荐**（所有用户类型都建议安装）：
- `find-skills`（生态第一安装量，持续发现新能力，上手成本最低）
- `orca-cli` / `orchestration`（每日发版，多代理协调与桌面 UI 自动化）
- `pi-agents-flow`（子代理编排，减少上下文膨胀）

---

## 附录 A：官方 Extension 完整 API 清单

### A.1 命令钩子

- `pi.registerCommand(name, opts)`：注册 `/mycommand`。同名命令会被保留并加数字后缀（`/review:1`、`/review:2`）。支持 `getArgumentCompletions` 做参数补全。
- `pi.registerShortcut(shortcut, opts)`：注册键盘快捷键（如 `ctrl+shift+p`）。
- `pi.registerFlag(name, opts)`：注册 CLI flag（如 `--plan`），用 `pi.getFlag()` 读取。
- `pi.getCommands()`：列出当前可调用的命令（extension/template/skill，含 `sourceInfo` 溯源）。

命令 handler 收到 `ExtensionCommandContext`（扩展了 `ExtensionContext`），额外提供会话控制：`ctx.reload()`、`ctx.newSession()`、`ctx.fork()`、`ctx.switchSession()`、`ctx.navigateTree()`、`ctx.waitForIdle()`、`ctx.getSystemPromptOptions()`。

### A.2 UI 钩子

- `ctx.ui`：`select` / `confirm` / `input` / `editor`（对话框）、`notify`（通知）、`setStatus`（footer 状态）、`setWidget`（编辑器上下 widget）、`setWorkingMessage/Visible/Indicator`（流式工作指示）、`setFooter/setHeader`、`setTitle`、`setEditorText`、`addAutocompleteProvider`（叠加自动补全）、`setTheme`、`setEditorComponent`（自定义编辑器，如 vim 模式）、`custom()`（完全自定义 TUI 组件，支持键盘输入，可 overlay 浮层）。
- `pi.registerMessageRenderer(customType, fn)` / `pi.registerEntryRenderer(customType, fn)`：自定义消息/条目的 TUI 渲染。
- `ctx.mode`（`"tui"|"rpc"|"json"|"print"`）与 `ctx.hasUI` 用于守卫 TUI-only 特性。

### A.3 system prompt 钩子

- `pi.on("before_agent_start", ...)`：返回 `systemPrompt` 可**逐轮替换级联系统提示**；返回 `message` 可注入持久消息；`event.systemPromptOptions` 暴露 pi 构建系统提示的全部结构化输入（customPrompt、selectedTools、toolSnippets、promptGuidelines、appendSystemPrompt、contextFiles、skills 等）。
- `pi.on("context", ...)`：在每次 LLM 调用前非破坏性修改消息。
- `pi.on("before_provider_headers")` / `before_provider_request` / `after_provider_response`：改写请求头、替换/检查 provider payload、检查响应状态。
- `ctx.getSystemPrompt()`：读取当前系统提示字符串。
- `pi.registerProvider(name, config)` / `pi.unregisterProvider(name)`：动态注册/移除模型 provider（含自定义 OAuth、`refreshModels`）。

### A.4 事件钩子（`pi.on(event, handler)`）

完整的生命周期事件（`docs/extensions.md` "Events"）：

- **启动/信任**：`project_trust`、`session_start`、`resources_discover`（可返回 skill/prompt/theme 路径以贡献资源）
- **会话**：`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_compact`/`session_compact`、`session_before_tree`/`session_tree`、`session_shutdown`
- **Agent/回合**：`before_agent_start`、`agent_start`/`agent_end`/`agent_settled`、`turn_start`/`turn_end`、`message_start`/`message_update`/`message_end`
- **工具**：`tool_execution_start`/`_update`/`_end`、`tool_call`（**可 block/改写参数**，用 `isToolCallEventType` 获取类型化输入）、`tool_result`（**可修改结果**）
- **用户 bash**：`user_bash`（拦截 `!`/`!!`，可替换为 SSH/远程操作）
- **输入**：`input`（可 transform/handled/continue，先于 skill/template 展开）
- **模型**：`model_select`、`thinking_level_select`

### A.5 其他 API

- `pi.registerTool()`（含 `promptSnippet`/`promptGuidelines` 注入系统提示、`prepareArguments` 兼容旧 schema、`terminate: true` 提前结束、`renderCall`/`renderResult` 自定义渲染、覆盖内置工具、`withFileMutationQueue` 并发安全写文件、动态工具加载 `setActiveTools`）
- `pi.sendMessage()` / `pi.sendUserMessage()` / `pi.appendEntry()`（会话持久化）
- `pi.setSessionName()` / `pi.setLabel()` / `pi.setModel()` / `pi.setThinkingLevel()`
- `pi.exec()`（执行 shell 命令）、`pi.events`（扩展间事件总线）
- 工具输出截断工具：`truncateHead`/`truncateTail`/`DEFAULT_MAX_BYTES`(50KB)/`DEFAULT_MAX_LINES`(2000)

---

## 附录 B：调研过程中的 bug 发现

在调研过程中，我们发现并修复了 pi-agents-flow 运行时中的两个 bug：

### B.1 `DEFAULT_WORKFLOW_CHILD_TURN_BUDGET is not defined`

- **现象**：所有 workflow child node 在启动时直接 ReferenceError 失败。
- **根因**：`src/workflows/delegation-adapter.ts:239` 引用了 `DEFAULT_WORKFLOW_CHILD_TURN_BUDGET` 常量，但该常量在 `src/runs/shared/turn-budget.ts` 中未定义。这是之前重构（`b257c89 fix(subagent): restore missing imports from executor refactor`）漏掉的 import。
- **修复**：在 `src/runs/shared/turn-budget.ts` 补充常量定义（25 turns），并在 `delegation-adapter.ts` 补充 import。

### B.2 Context Pack 物化时 JSON.parse 崩溃

- **现象**：verification 节点（v1/v2）持续失败，context pack 目录为空，verifier 收到空 task 返回 Markdown 而非结构化 JSON。
- **根因**：`src/workflows/context-pack.ts:94` 的 `artifactValue` 函数在读取 mediaType 为 `application/json` 的 artifact 时，若文件内容实际为 Markdown（损坏的 artifact），`JSON.parse` 抛出异常，导致整个 context pack 物化崩溃，下游节点无法启动。
- **修复**：两处 graceful degradation：
  1. `artifactValue` 的 JSON.parse 加 try-catch，降级返回原始文本；
  2. `resolveSources` 调用加 try-catch，单 binding 失败标记 omitted 而非阻塞整个 pack。

这两个修复已提交至 `fix(workflow): restore missing turn budget constant and harden context pack resolution`（commit `6fe56ac`）。

---

*调研基准版本：`@earendil-works/pi-coding-agent@0.81.0`（本地 node_modules）。所有引用均为官方文档/示例原文。*
