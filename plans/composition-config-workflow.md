# Composition Config Layer: 主 Agent 自主组装 Subagent/Skill/Tool 的声明式编排

> 版本: v3（已实施，含实施后修正）
> 状态: 已实现。阶段 1-4 全部落地，实施中发现的偏差已回写本文档（见 4.2 的工具形态、4.3.4 启动参数管线、4.3.5 收窄守卫、第 8 节决策记录）
> 关联文档: `script-driven-workflow.md`（脚本模式，范围收窄后与本文档并列，非替代关系；该文档尚未按收窄后的边界重写）
> 执行引擎: 不改动。复用现有 `Controller.execute()`、`Scheduler`、`DelegationAdapter`、`Store`、`Reducer`、`Gates`；新增的只是"谁来生成节点计划"这一层。
> 例外：节点级 tool 绑定需要扩展 `SubagentDelegationV2Request` 传输契约（见 4.3），这是执行引擎之外的传输层扩展。

---

## 1. 背景与问题

### 1.1 现状问题（来自实际使用）

当前多 subagent 串行流程（计划 → 开发 → 验证）由主 Agent 全程在上下文里驱动：每一步 transition 都要主 Agent 读懂当前累积的全部历史再决定下一步调用什么。这在长流程/多轮修复循环下会退化：

- 上下文变长后，主 Agent 对早期约束（比如计划阶段定的验收标准）的遵循度下降，不是模型变笨，是长上下文对指令遵循本身有已知的衰减模式。
- 表现为"不按流程执行"——该验证的步骤被跳过，该串行的依赖关系被打乱，行为不稳定，难以复现。

这不是 `script-driven-workflow.md` 里说的"O(n) 上下文开销"问题（那是效率问题），是**正确性/稳定性问题**：流程结构本身如果只存在于主 Agent 的持续记忆里，长流程后期会失真。

### 1.2 核心洞察

解决稳定性问题的关键，不是让主 Agent 更努力地记住流程，而是**尽早把流程结构从主 Agent 的持续记忆里搬出来，变成一份主 Agent 决策一次、之后不再依赖记忆去执行的确定性表示**。

现有 Controller 已经支持这个模式的一半：`apply_plan` 本来就能接收一整张 `WorkflowNodePlan[]` 一次性提交（`src/workflows/types.ts:125`），依赖关系用 `dependsOn: string[]` 声明，执行由 `Scheduler` 按依赖图调度，不需要主 Agent 逐步 `run_ready`。

问题是**现在主 Agent 倾向于把 `apply_plan` 当成"提交下一小步"来用**，一步步交替调用 `apply_plan` + `run_ready`，而不是在拿到完整意图后一次性把整张图定好。这才是"漂移"的真正来源：不是 Controller 不支持一次性声明，是主 Agent 的调用模式没有利用这个能力。

### 1.3 与脚本模式的关系（边界）

`script-driven-workflow.md` 的脚本模式解决的是另一个问题：**当依赖关系或节点集合需要在运行中根据中间结果动态变化时**（比如"gap 数 > 0 就加 verifier，循环到 gap 为 0"），静态 DAG 提交不够表达，需要命令式控制流。这类场景目前只有 deep research 的验证循环站得住。

本文档的组合配置层解决的是更常见的场景：**依赖关系在启动前就已知**的场景，比如"先计划、后开发、后验证"。这类场景不需要脚本引擎、沙箱、审批 UI。

**划分不变量**：组合配置层的一切求值都发生在**渲染期**（提交 `apply_plan` 之前），执行开始时 DAG 已完全确定且不再变化。任何需要在执行过程中依据结果改变拓扑的需求，一律归脚本模式。

| 场景特征 | 用哪个 |
|---|---|
| 依赖关系静态，启动前已知（先计划后开发后验证） | 组合配置层（本文档），一次性 `apply_plan` |
| 依赖关系或节点集合需要运行时动态变化（gap 修复循环） | 脚本模式（`script-driven-workflow.md`） |

---

## 2. 设计目标

1. **稳定性优先**：主 Agent 的组合决策一次做完、一次提交，执行阶段不再依赖主 Agent 的持续记忆去驱动流程顺序——依赖关系由 Scheduler 强制执行。
2. **资产是 subagent，不是流程**：主 Agent 只需要知道"有哪些 subagent、skill、tool 可用，以及怎么组合"，不需要理解每个 subagent/skill 内部如何工作。Subagent 自己负责读取绑定给它的 skill。
3. **支持 skill/tool 的节点级动态绑定**：不仅是"选哪个 subagent"，还要能"给这个节点动态配哪些 skill、哪些 MCP tool"。
4. **可固化、可复用**：主 Agent 第一次生成的组合方案，用户可以看、可以改、改完存下来，之后照配置+新参数重跑，不用每次让主 Agent 重新决策。
5. **确定性优先于模型判断**：模板里的条件判断应尽量从原始参数确定性推导，而不是让（可能较弱的）模型在运行时临时判断。

---

## 3. 现状能力盘点

### 3.1 零改动的部分

| 组件 | 文件 | 说明 |
|---|---|---|
| Controller | `controller.ts` | `apply_plan`/`run_ready`/`evaluate`/`accept`/`reject`/`complete` 等 action 全部复用 |
| Scheduler | `scheduler.ts` | 按 `dependsOn` 调度节点，worker 池、并发控制不变 |
| Store / Reducer / Gates | 对应文件 | 事件溯源、纯函数归约、质量门禁不变 |
| Agent / skill 发现 | `agents/agents.ts`、`agents/skills.ts` | 作为资产清单的数据源，只读复用 |

### 3.2 已有且可直接用的字段

`WorkflowNodePlan`（`types.ts:125-131`）已经支持完整 DAG 声明：

```typescript
export interface WorkflowNodePlan {
	id: string;
	kind: WorkflowNodeKind;
	label: string;
	dependsOn: string[];
	agentSpec: EphemeralAgentSpec;
}
```

`EphemeralAgentSpec`（`types.ts:21-35`）已带 `skills?: string[]`，且**全链路已打通**：`delegation-adapter.ts` 在 preflight 输入和 `SubagentDelegationV2Request` 里都传了 `skill` 字段。因此**节点级 skill 动态绑定是零成本的，现在就能用**。

### 3.3 缺失的部分

1. **MCP tool 的节点级绑定**：不存在。tool 可用性来自 `AgentConfig.tools`/`mcpDirectTools`（agent 定义级），`preflight.ts:275` 从 `agent.mcpDirectTools` 解析，`SubagentLaunchContractInput`（`preflight.ts:43`）和 `SubagentDelegationV2Request`（`delegation.ts:118-119`）都没有 tool 覆盖字段。
2. **主 Agent 一次性提交完整 DAG 的引导**：能力存在，但没有被强制成默认用法。
3. **组合方案的固化与复用**：`apply_plan` 提交后不落地成可复用文件。

### 3.4 一个不能复用的现有机制

`EphemeralAgentSpec.toolBudget.block?: string[] | "*"` **不能**用来做工具禁用。它的语义在 `runs/shared/tool-budget.ts:3-10` 和 `extension/schemas.ts:120` 定义为"hard 预算耗尽后封锁这些工具，让子 agent 能收尾"（默认 `["read","grep","find","ls"]`），是预算耗尽后的降级机制，不是授权拒绝。工具禁用需要独立字段。

---

## 4. 详细设计

### 4.1 一次性组合提交（核心行为改变，零代码改动）

**现状**：

```
apply_plan([planNode]) → run_ready() → evaluate()
apply_plan([devNode])  → run_ready() → ...
```

每次追加都要主 Agent 重新读状态、重新决策，决策次数与上下文长度成正比，这就是漂移发生的地方。

**改进**：依赖关系启动前已知时，一次性提交完整 DAG：

```
apply_plan([
  { id: "plan",   kind: "custom",       dependsOn: [],       agentSpec: { baseAgent: "planner",  skills: ["spec-writing"], ... } },
  { id: "dev",    kind: "custom",       dependsOn: ["plan"], agentSpec: { baseAgent: "worker",   skills: ["typescript"],   ... } },
  { id: "verify", kind: "verification", dependsOn: ["dev"],  agentSpec: { baseAgent: "reviewer", skills: ["testing"],      ... } },
])
run_ready()   // Scheduler 按 dependsOn 严格排序执行，主 Agent 不再介入顺序
```

之后主 Agent 只需 `evaluate()` 看总体结果。这是解决稳定性问题的主要手段，**零代码改动**，落地靠引导与约束：

- `skills/dynamic-workflow/SKILL.md` 增补：依赖关系在启动前已知时，必须一次性提交完整 DAG，禁止把已知的静态依赖拆成多次 `apply_plan`。
- 仅当后续节点集合/依赖确实依赖运行时结果（如 deep research 的 gap 修复）才允许追加节点或引入脚本模式。

### 4.2 资产清单查询（`workflow_assets`）

**实施后修正**：本文档原计划做成 `workflow` 工具的 `list_assets` action，实际实现为独立只读工具 `workflow_assets`。原因是 `WorkflowControllerDetails.run` 是必填字段，且 `workflows/tool.ts` 的 `renderResult` 把「缺 run」当错误渲染——做成 action 就必须为一个与 run 状态无关的查询凭空造或加载一个 run。

主 Agent 要做组合决策，需要知道有什么可选。新增一个只读聚合视图：

```typescript
interface AssetCatalog {
  agents: Array<{
    name: string;
    description: string;
    inheritSkills: boolean;
    skills?: string[];      // AgentConfig.skills，agent 默认绑定
    tools?: string[];       // AgentConfig.tools
    mcpDirectTools?: string[];
  }>;
  skills: Array<{ name: string; description: string; path: string }>;
  mcpTools: Array<{ name: string; server: string; description: string }>;
}
```

数据源全部是现有发现机制（`agents/agents.ts` 的 `AgentDiscoveryResult`、`agents/skills.ts`、已注册 MCP server 元数据）的聚合，**不新增存储或注册系统**。

**实时扫描，不缓存**（决策 4）。理由：目录扫描成本远低于一次 LLM 调用，加缓存会引入"改了 skill 没生效"的困惑。主 Agent 调用一次拿全貌，不必逐节点查询。

### 4.3 节点级 skill / tool 动态绑定

**Skill**：用现有 `EphemeralAgentSpec.skills`，零改动（见 3.2）。

**Tool（决策 1B + 2：追加与禁用两个方向都做）**：给 `EphemeralAgentSpec` 增加两个可选字段：

```typescript
export interface EphemeralAgentSpec {
	// ...现有字段不变
	extraTools?: string[];   // 本次节点额外授予的工具 / MCP direct tool
	denyTools?: string[];    // 本次节点显式撤销的工具（即使 baseAgent 默认拥有）
}
```

语义：以 `baseAgent` 解析出的工具集为基线，先并入 `extraTools`，再减去 `denyTools`（`denyTools` 优先级更高）。与 `toolBudget.block` 正交——后者是预算耗尽后的降级，前者是授权集合本身（见 3.4）。

**这条链路要穿 6 层，是本文档最重的一块**（实施后修正：原估 4 层偏少）：

| 层 | 文件 | 改动 |
|---|---|---|
| 1. 节点计划类型 + 解析 | `workflows/types.ts`、`workflows/tool.ts`（`parseAgentSpec`） | 新增两字段及其校验（非空字符串数组、上限 64、拒绝扩展路径） |
| 2. 启动契约输入 | `api/preflight.ts`（`SubagentLaunchContractInput`） | 新增覆盖字段并传给 `resolvePiLaunchToolPlan`；契约暴露 `grantedTools`/`revokedTools` |
| 3. 传输契约类型 | `api/delegation.ts`（`SubagentDelegationV2Request`） | 新增可选字段 |
| 4. **接收侧字段白名单** | `slash/delegation-request.ts`（`v2SupportedFields`） | **必须同步加入，否则请求被判 `invalid_request`**（见 4.3.2） |
| 5. 语义实现 | `runs/shared/pi-args.ts`（`resolvePiLaunchToolPlan`） | grant 在 ceiling 过滤前并入、deny 在之后减去 |
| 6. **子进程启动参数** | `slash/delegation-adapters.ts`、`shared/types.ts`、`runs/foreground/subagent-executor.ts`、`runs/foreground/execution.ts` | **实际生成 `--tools` 的是 `buildPiArgs`**；不打通这段，grant 只存在于契约里，子进程收不到（见 4.3.4） |

**`extension/schemas.ts` 不需要改动**（实施后修正：原文档预判要改）。那里的 `additionalProperties: false` 属于 `subagent` 工具的参数 schema，workflow 委派路径不经过它。

#### 4.3.1 版本耦合问题（已查证，风险不存在）

发送方与解析方在**同一进程、同一 extension 激活、同一包版本**内：`extension/index.ts:413` 注册解析侧 `registerPromptTemplateDelegationBridge`，`:428` 创建发送侧 `createWorkflowDelegationAdapter`，两者共用同一个 `pi.events`；传输是进程内事件（`delegation.ts:6`）。真正跨进程的是 bridge 之后 spawn 的子 pi 进程，那已在本协议之外。

**结论**：不存在新旧混版收发的场景，**不需要按对端能力裁剪字段，不需要降级路径，不提升 `SUBAGENT_DELEGATION_PROTOCOL_VERSION`**。

#### 4.3.2 但未知字段是硬拒绝，不是静默忽略

`slash/delegation-request.ts:129` 对 v2 请求做严格白名单校验：

```ts
const unsupportedField = Object.keys(value).find((key) => !v2SupportedFields.has(key));
if (unsupportedField) return { ok: false, ...identity, error: `Unsupported delegation field: ${unsupportedField}.` };
```

`v2SupportedFields`（`:36-52`，当前 17 项）是第一道关卡，比 `schemas.ts` 更靠前。新增 `extraTools`/`denyTools` 必须同时加入该 Set，否则请求直接以 `invalid_request` 失败。

#### 4.3.3 需配套的尺寸上限

同文件对 `skill` 字段已有一套上限约定，新增的两个字符串数组字段应照此先例对齐，避免防御一致性缺口：

- 条目数上限（`MAX_SKILL_ENTRIES` = 256）
- 单条字节上限（`MAX_SHORT_TEXT_BYTES` = 1 KiB）
- 聚合字节上限（`MAX_SKILL_AGGREGATE_BYTES` = 64 KiB，`delegation-request.ts:60`）

实施结果：工具授权用了更紧的 64 条 / 1 KiB 单条 / 16 KiB 聚合，因为工具名远短于 skill 名且数量本就有限。

#### 4.3.4 契约算出来不等于子进程收到（实施中发现）

真正生成 `--tools` 命令行参数的是 `runs/shared/pi-args.ts` 的 `buildPiArgs`，而它原先只接收 `agent.tools`。`preflight.ts` 里的 `resolvePiLaunchToolPlan` 只产出**契约**，不产出启动参数。因此仅打通前 5 层的话，`grantedTools` 会正确出现在契约里，但子进程实际拿不到那个工具——功能是空的。

必须补的一段：`DelegatedSubagentExecutionParams`（`slash/delegation-adapters.ts`）→ `toSubagentDelegationV2ExecutionParams` 映射 → `RunSyncOptions`（`shared/types.ts`）→ `SubagentParamsLike` 与 `runSync` 调用（`runs/foreground/subagent-executor.ts`）→ `execution.ts` 里 `buildPiArgs` 与 `resolvePiLaunchToolPlan` 两个调用点，外加 `BuildPiArgsInput` 本身新增字段并向内层透传。

配套地，`execution.ts` 的 completion mutation guard 也要用调整后的工具集判断，否则 `denyTools` 掉 write 之后 guard 仍会期待子 agent 修改文件，产生误判。

background 路径（`runs/background/subagent-runner.ts`）无需改动：v2 委派参数固定 `async: false` / `foregroundOnly: true`，不经过该路径。

#### 4.3.5 一条反直觉的安全约束（实施中发现）

`extraTools`/`denyTools` 必须要求 baseAgent 已声明显式 `tools` 白名单，否则报错。原因是 `explicitToolAllowlist` 的推导逻辑：baseAgent 没有白名单时子 agent 本来不受限，一旦叠加一个列表，该标志翻转为 true，子 agent 反而被**收窄**成只有列表里这几个工具——与"授权"意图完全相反。静默做这件事比报错危险得多。

### 4.4 组合方案的固化与复用

存储声明式配置，不是脚本：

```
.pi-swarm/compositions/
  └── <name>.json
```

配置结构：带占位参数的 `WorkflowNodePlan[]` + 参数声明 + 可选的节点启用条件：

```json
{
  "name": "plan-dev-verify",
  "description": "标准计划-开发-验证串行流程",
  "params": [
    { "name": "goal", "required": true },
    { "name": "targetModule", "required": true }
  ],
  "nodes": [
    {
      "id": "plan", "kind": "custom", "dependsOn": [],
      "agentSpec": { "baseAgent": "planner", "objective": "为 {{targetModule}} 制定计划: {{goal}}", "skills": ["spec-writing"], "...": "..." }
    },
    {
      "id": "dev", "kind": "custom", "dependsOn": ["plan"],
      "agentSpec": { "baseAgent": "worker", "skills": ["typescript"], "...": "..." }
    },
    {
      "id": "db-verify", "kind": "verification", "dependsOn": ["dev"],
      "enableIf": "targetModule includes \"db\"",
      "agentSpec": { "baseAgent": "reviewer", "skills": ["testing"], "extraTools": ["mcp__db__query"], "...": "..." }
    },
    {
      "id": "verify", "kind": "verification", "dependsOn": ["dev"],
      "agentSpec": { "baseAgent": "reviewer", "skills": ["testing"], "denyTools": ["bash"], "...": "..." }
    }
  ]
}
```

#### 4.4.1 `enableIf`：受限渲染期表达式（决策 3）

选择理由：纯布尔开关（`enableIf: "hasDb"`）要求调用方自己把 `hasDb` 算出来，而调用方常常就是模型——等于把判断又交回给模型，弱模型下不可靠。允许从原始参数确定性推导（`targetModule includes "db"`）才能真正把判断从模型手里拿走。受限表达式是纯布尔开关的超集，`enableIf: "hasDb"` 仍然合法。

**守边界的不变量**：表达式只在渲染期求值一次，求值完成后 DAG 完全确定；被禁用的节点在提交 `apply_plan` 之前就已从数组中移除，Controller 和 Scheduler 完全不感知 `enableIf` 的存在。运行时才能确定的分支仍归脚本模式。

**受限语法**（故意做窄，防止演化成控制流）：

- 操作数：仅 `params` 中已声明的参数名、字符串/数字/布尔字面量
- 运算符：`===` `!==` `>` `<` `>=` `<=` `&&` `||` `!`、括号
- 允许的操作：`includes`、`startsWith`、`endsWith`、`length`
- 禁止：赋值、循环、任意函数调用、成员访问链、全局对象、模板字面量嵌套
- 求值结果必须是布尔值，否则渲染期报错
- 引用未声明参数 → 渲染期报错（不静默当 false，避免弱模型笔误导致节点被悄悄跳过）

**实现方式：手写词法分析 + 递归下降求值器，不使用 `eval` / `new Function` / `vm`。** 这与"本层不引入沙箱"一致，也让语法边界由解析器强制而非约定。

#### 4.4.2 参数渲染

`{{param}}` 字符串占位替换，作用于 `agentSpec` 的字符串字段。缺少 required 参数 → 渲染期报错。

#### 4.4.3 `/composition` 命令

- `/composition save <name>`：把当前 run 的节点计划固化为模板
- `/composition run <name> --param goal=... --param targetModule=...`：渲染 → 求值 `enableIf` → 调用 `apply_plan`，跳过主 Agent 重新决策
- `/composition list` / `/composition show <name>`

**同名保存直接覆盖，不保留历史版本**（决策 5）。这些文件应进 git 由用户自己版本化，再造一套 `history/` 是重复机制。

#### 4.4.4 Deep research 的模板化路径

`script-driven-workflow.md` 里设想的"预置 `deep-research.js` 模板"，在本方案下变成：用户跑过一次后存成 `.pi-swarm/compositions/deep-research.json`。但其中 gap 修复循环属于运行时动态拓扑，仍需脚本模式承担；该模板应是"静态部分声明式 + 动态部分引用脚本片段"的混合体。混合结构的具体形态留给脚本模式落地时定义，本文档不展开。

---

## 5. 实施计划

### 阶段 1：使用规范落地（仅文档，立即可做）

| 任务 | 文件 |
|---|---|
| 补充"一次性提交完整 DAG"的强制引导 | `skills/dynamic-workflow/SKILL.md` |
| 明确脚本模式的适用边界（运行时动态拓扑才用） | `skills/dynamic-workflow/SKILL.md`、`script-driven-workflow.md` |

优先做，成本最低，直接缓解当前漂移问题，不依赖后续阶段。

### 阶段 2：资产清单查询（约 0.5 天）

| 任务 | 文件 |
|---|---|
| 新增 `list_assets` action | `src/workflows/tool.ts` |
| 聚合逻辑（实时扫描，复用现有发现机制） | 新文件 `src/workflows/asset-catalog.ts` |
| 单元测试：聚合结果覆盖 agent/skill/mcp 三类 | `test/unit/workflow-asset-catalog.test.ts` |

### 阶段 3：节点级 tool 绑定（约 1.5–2 天）

版本耦合问题已查证清楚（4.3.1），无前置阻塞，可直接开工。

| 任务 | 文件 |
|---|---|
| `EphemeralAgentSpec` 加 `extraTools` / `denyTools` | `src/workflows/types.ts` |
| `parseAgentSpec` 校验两字段 | `src/workflows/tool.ts` |
| `SubagentLaunchContractInput` 加覆盖字段并在工具解析处应用 | `src/api/preflight.ts` |
| `SubagentDelegationV2Request` 加可选字段 | `src/api/delegation.ts` |
| **`v2SupportedFields` 白名单加两字段 + 尺寸上限校验** | `src/slash/delegation-request.ts` |
| `delegation-adapter` 透传（preflight 输入与 request 两处） | `src/workflows/delegation-adapter.ts` |
| 同步 schema（注意 `additionalProperties: false`） | `src/extension/schemas.ts` |
| 单元测试：追加/禁用/两者叠加（deny 优先）/与 `toolBudget.block` 互不干扰/超限拒绝/白名单遗漏回归 | `test/unit/` 对应文件 |

### 阶段 4：组合方案固化与复用（约 1.5 天）

| 任务 | 文件 |
|---|---|
| 表达式求值器（手写解析，禁 `eval`） | 新文件 `src/workflows/composition-expr.ts` |
| 组合配置存储 + 参数渲染 + `enableIf` 求值 | 新文件 `src/workflows/composition-store.ts` |
| `/composition` 命令（save/run/list/show） | `src/workflows/commands.ts` |
| 单元测试：求值器（含语法拒绝用例、未声明参数报错）、渲染、节点裁剪 | `test/unit/` 对应文件 |

### 时间线

```
阶段 1（文档/引导）：立即生效
阶段 2（资产清单）：0.5 天
阶段 3（tool 绑定）：1.5–2 天
阶段 4（固化复用）：1.5 天
─────────────────────
共约 3.5–4 个工作日（不含阶段 1）
```

---

## 6. 影响分析

| 方面 | 影响 |
|---|---|
| 执行引擎（Controller/Scheduler/Store/Reducer/Gates） | 零改动 |
| 现有 `apply_plan` 语义 | 不变，只是引导主 Agent 充分利用"一次提交整图"的既有能力 |
| `EphemeralAgentSpec` | 新增两个可选字段，不影响现有调用方 |
| 传输契约 `SubagentDelegationV2Request` | 新增两个可选字段，不提版本号。收发双方同进程同版本（4.3.1），无混版风险；但接收侧 `v2SupportedFields` 白名单与 `schemas.ts` 必须同步，否则请求被判 `invalid_request` |
| `enableIf` 对执行层的影响 | 无。渲染期即完成节点裁剪，Controller 收到的仍是普通 `WorkflowNodePlan[]` |
| 现有测试 | 阶段 1/4 不影响；阶段 2/3 需新增单元测试 |
| 与脚本模式的关系 | 并列，非替代。脚本模式范围收窄为"仅运行时动态拓扑" |

---

## 7. 剩余未决问题

1. **`extraTools` 的名字空间**：MCP direct tool 与内置工具是否共用一个数组，还是分开两个字段（`extraTools` / `extraMcpTools`）？取决于 `preflight.ts` 里两者的解析路径是否可统一。
2. **`/composition save` 的参数化程度**：从一个已跑完的 run 反推模板时，哪些具体值该自动变成 `{{param}}`？全自动推断容易猜错，可能需要交互式确认或先只做"保存原样 + 用户手改"。

（原第 1 项"父子端版本一致性"已查证并排除，见 4.3.1。）

---

## 8. 决策记录（2026-08-05）

| # | 议题 | 决策 |
|---|---|---|
| 1 | 节点级 tool 绑定是否本轮做 | **做**。接受扩展 `SubagentDelegationV2Request` 传输契约的成本 |
| 2 | tool 绑定语义方向 | **追加与禁用都做**：`extraTools` + `denyTools`，`denyTools` 优先。`toolBudget.block` 语义不同，不复用 |
| 3 | 模板是否支持条件性包含节点 | **支持受限渲染期表达式**（原选项 B 的超集）。理由：纯布尔开关会把判断退回给模型，弱模型下不可靠；表达式可从原始参数确定性推导。守边界靠"仅渲染期求值、DAG 执行前已固定"，求值器手写不用 `eval`/`vm` |
| 4 | `list_assets` 是否缓存 | **实时扫描，不缓存** |
| 5 | `/composition save` 同名是否留历史 | **直接覆盖**，版本化交给 git |

---

## 附录：与 `script-driven-workflow.md` 的分工

| 维度 | 组合配置层（本文档） | 脚本模式（范围已收窄） |
|---|---|---|
| 解决的问题 | 长流程上下文漂移导致的执行不稳定 | 需要运行时动态拓扑的循环/条件 |
| 载体 | 声明式 JSON（节点 + 依赖 + skill/tool 绑定 + 渲染期条件） | 命令式 JS 脚本（沙箱执行） |
| 求值时机 | 渲染期，执行前 DAG 已固定 | 运行期，拓扑可变 |
| 适用场景 | 计划→开发→验证等固定阶段流程、批量同构扫描 | gap 修复循环等依赖运行时结果的分支 |
| 用户复核成本 | 低，读一张 DAG + 装备清单 | 较高，需读懂一段 JS |
| 新增基础设施 | 无沙箱；资产聚合视图 + 模板存储 + 手写表达式求值器 | `worker_threads` + `vm` 沙箱、审批 UI |
| 执行引擎改动 | 无 | 无 |
