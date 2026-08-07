# Script-Driven Workflow: Pi Swarm 脚本驱动工作流设计文档

> 版本: v1 (草案)
> 状态: 待评审
> 评审人: 待定
> 范围修订: 静态拓扑由 `composition-config-workflow.md` 的声明式组合层负责；本文仅处理执行结果会改变后续节点或依赖关系的运行时动态拓扑。

---

## 1. 背景与动机

### 1.1 当前 State of the Art

Pi Swarm 当前的工作流系统是 **Supervisor 驱动模式**。核心流程如下：

```
用户输入 /swarm 或 /deep-research
    │
    ▼
commands.ts 启动 workflow → 构建 supervisor context 消息
    │
    ▼
LLM (Supervisor) 收到 context，开始逐 step 驱动：
    │
    ├── 1. start                         → Controller.execute()
    ├── 2. apply_plan (定义 DAG)         → Controller.execute()
    ├── 3. run_ready                     → Controller → Scheduler → DelegationAdapter
    ├── 4. evaluate                      → Controller.execute()  + Gates
    ├── 5. accept/reject                 → Controller.execute()
    ├── 6. run_ready (新节点)            → Controller → Scheduler
    ├── 7. evaluate → complete           → Controller.execute()
    │
    ▼
    每次 LLM 调用 workflow 工具，结果都回流到 LLM 上下文
```

**关键特征**：
- LLM（Supervisor）是唯一的"总导演"——每次 transition 都需要 LLM 决策
- 所有节点的结果都累积在 LLM 上下文中
- 对于 100+ 节点的大规模任务，上下文开销呈 O(n) 增长
- 无法在 LLM 决策后修改流程——用户必须等待 LLM 重新规划

### 1.2 诉求

用户希望兼容 **Claude Code Dynamic Workflow** 在运行时动态拓扑场景中的优势：

1. **脚本驱动动态拓扑**：当中间结果决定后续节点、依赖或循环次数时，通过预写脚本驱动，不依赖 LLM 逐 step 决策
2. **上下文隔离**：脚本执行结果存在脚本变量中，不回流 LLM 上下文
3. **用户可编辑**：脚本作为文件保存，用户可随时修改后续流程
4. **可复用**：脚本可保存、可版本化、可复用
5. **大规模友好**：100+ Agent 任务时，LLM 上下文只承载最终答案 O(1)

依赖关系在启动前已知时，不使用脚本模式：主 Agent 应一次性向 `apply_plan` 提交完整 DAG，由 Scheduler 按 `dependsOn` 执行。规模大或希望复用本身不是选择脚本模式的理由；静态流程的复用由组合配置层负责。

### 1.3 核心洞察

经过对现有代码的深度排查，我们发现：

**现有 Controller 已经是一个干净的 API 层**，所有 18 种 action 都通过 `execute(params, ctx, signal)` 收敛。静态拓扑应由 Supervisor 一次性提交完整 DAG；只有运行时结果需要改变拓扑时，脚本才成为新的调用者。两种模式的调用区别如下：

```
Supervisor / 组合配置模式：
  LLM 或组合配置渲染器 → 一次性 apply_plan → Controller.execute()
  └── 执行前 DAG 已固定，Scheduler 负责后续顺序

脚本模式：
  ScriptRuntime (JS 沙箱) → Controller.execute()
  └── 中间结果可决定新增节点、依赖或循环，结果存脚本变量
```

**事件流、状态机、UI 更新路径完全一致**——脚本产生的 `node.started`、`node.completed`、`node.failed` 等事件与 Supervisor 模式完全一样。

---

## 2. 架构设计

### 2.1 总体架构

```
                            用户输入
                                │
                    ┌───────────▼───────────┐
                    │    Extension Router     │
                    │  (extension/index.ts)   │
                    └───────┬───────┬────────┘
                            │       │
              ┌─────────────▼─┐ ┌──▼──────────────┐
              │  Supervisor    │ │  Script Runtime  │
              │  (LLM 驱动)    │ │  (JS 沙箱驱动)   │
              │  tool.ts      │ │  script-runtime.ts│
              │  commands.ts  │ │  script-editor.ts │
              └───────┬───────┘ └──────┬────────────┘
                      │                │
                      ▼                ▼
              ┌────────────────────────────────────┐
              │        Controller API 层            │
              │  execute({ action, ... })          │
              │  18 种 action: start, apply_plan,  │
              │  run_ready, evaluate, accept, ...   │
              └──────────────┬─────────────────────┘
                             │
              ┌──────────────▼─────────────────────┐
              │        底层基础设施                   │
              │  Scheduler → DelegationAdapter      │
              │  Store (events.jsonl)               │
              │  Reducer (纯函数归约)                │
              │  Gates (质量门禁)                    │
              └────────────────────────────────────┘
```

### 2.2 不变的部分（零改动）

经过对全部 20+ 个核心文件的逐行排查，以下组件完全不动：

| 组件 | 文件 | 原因 |
|------|------|------|
| **Controller** | `controller.ts` | 18 个 action 全部复用，脚本只是新的调用者 |
| **Scheduler** | `scheduler.ts` | worker 池、并发控制、节点调度，逻辑不变 |
| **DelegationAdapter** | `delegation-adapter.ts` | 子 agent 通信协议，由 Scheduler 调用 |
| **Store** | `store.ts` | Event Sourcing 持久化，脚本也走事件 |
| **Reducer** | `reducer.ts` | 纯函数归约，不关心谁产生的事件 |
| **Gates** | `gates.ts` | 质量门禁评估，输入输出不变 |
| **board.ts** | `board.ts` | 面板渲染，在现有状态上工作 |
| **fleet-status.ts** | `fleet-status.ts` | 子 agent 实时状态，脚本的子 agent 也走同一事件 |
| **visual-language.ts** | `visual-language.ts` | 共享视觉元素，不动 |
| **render-helpers.ts** | `render-helpers.ts` | 辅助函数，不动 |
| **shared/** | 所有 | 类型定义，脚本模式引入新类型但不修改现有类型 |

### 2.3 需要新增的部分

| 新组件 | 文件 | 说明 |
|--------|------|------|
| **ScriptRuntime** | `src/workflows/script-runtime.ts` | 轻量 JS 沙箱执行引擎，~400 行 |
| **Script API 封装** | `src/workflows/script-api.ts` | 提供 `runAgent()`, `runAgents()`, `evaluate()` 等高层 API，~200 行 |
| **Script 编辑器面板** | `src/tui/workflow-script-panel.ts` | 显示/编辑脚本，~200 行 |
| **脚本存储** | `src/workflows/script-store.ts` | 脚本文件管理，~100 行 |
| **脚本 Skill** | `skills/script-workflow/SKILL.md` | 脚本模式使用指南 |
| **脚本参考** | `skills/script-workflow/references/script-runtime.md` | 脚本 API 参考文档 |

### 2.4 需要修改的部分

| 文件 | 改动 | 说明 |
|------|------|------|
| `tool.ts` | 新增 `run_script` action | 在 `WorkflowParams` 枚举中加一项 |
| `commands.ts` | 新增 `/script` 命令 | `run`, `edit`, `list`, `show` 子命令 |
| `extension/index.ts` | 注册 ScriptRuntime、script 命令、script 面板 | 加 ~50 行 |
| `view.ts` | `WorkflowViewSnapshot` 加 `scriptMode`/`scriptSteps` 字段 | 扩展而不修改现有字段 |
| `workflow-cockpit.ts` | `phaseRail()` 加 `SCRIPT` 阶段，`activityLabel()` 加脚本分支 | 条件判断，不影响现有路径 |
| `SKILL.md` | 第 27 条约束从"禁止"改为"条件允许" | 见下文详细说明 |

---

## 3. 详细设计

### 3.1 ScriptRuntime 设计

#### 3.1.1 沙箱选择

**方案**：Node.js `worker_threads` + `vm` 模块

```typescript
// 伪代码
import { Worker } from "node:worker_threads";

class ScriptRuntime {
  async execute(script: string, api: ScriptAPI): Promise<ScriptResult> {
    // 1. 在 worker 线程中创建 vm 上下文
    // 2. 注入 runAgent, runAgents, evaluate 等 API
    // 3. 执行脚本
    // 4. 收集结果
    // 5. 返回 ScriptResult
  }
}
```

**理由**：
- 零外部依赖——`worker_threads` 和 `vm` 都是 Node.js 内置
- 天然隔离——worker 线程崩溃不影响主进程
- 可中断——通过 `worker.terminate()` 支持脚本超时中止
- 安全——`vm` 上下文不暴露 `require`、`process` 等全局对象

#### 3.1.2 Script API

```typescript
interface ScriptAPI {
  // 底层 Controller API 封装
  start(params: { goal: string; mode?: "general" | "deep-research" }): Promise<WorkflowRun>;
  applyPlan(runId: string, nodes: WorkflowNodePlan[]): Promise<WorkflowRun>;
  runReady(runId: string, concurrency?: number): Promise<WorkflowRun>;
  evaluate(runId: string): Promise<WorkflowEvaluation>;
  accept(runId: string, nodeId: string, decision: string): Promise<WorkflowRun>;
  reject(runId: string, nodeId: string, decision: string): Promise<WorkflowRun>;
  complete(runId: string, finalMarkdown: string): Promise<WorkflowRun>;
  status(runId: string): Promise<WorkflowRun>;

  // 高层便利方法
  runAgent(spec: { role: string; objective: string; ... }): Promise<WorkflowResult>;
  runAgents(specs: AgentSpec[]): Promise<WorkflowResult[]>;
  waitForAll(runId: string): Promise<WorkflowRun>;  // 阻塞直到所有节点完成

  // 脚本内变量存储（不回流 LLM 上下文）
  setVar(key: string, value: unknown): void;
  getVar(key: string): unknown;

  // 暂停脚本，等待 Supervisor 回复
  callSupervisor(question: string): Promise<string>;

  // 条件判断
  evaluateGates(run: WorkflowRun): WorkflowEvaluation;
  hasGaps(run: WorkflowRun): boolean;
  hasConflicts(run: WorkflowRun): boolean;
  allAccepted(run: WorkflowRun): boolean;
}
```

#### 3.1.3 脚本示例

```javascript
// 静态反例：节点和依赖在启动前已知，应保存为 composition 并一次性 applyPlan，
// 不应为这类流程启用 ScriptRuntime。此处仅保留为底层 API 形态示意。
const run = await start({ goal: "分析项目代码质量", mode: "general" });

await applyPlan(run.id, [
  { id: "scan-auth", kind: "custom", label: "扫描认证模块", agentSpec: { ... } },
  { id: "scan-payment", kind: "custom", label: "扫描支付模块", agentSpec: { ... } },
  { id: "scan-user", kind: "custom", label: "扫描用户模块", agentSpec: { ... } },
]);

await runReady(run.id, 3);
const eval = await evaluate(run.id);

// 条件分支：有 gap 则加 verifier
if (eval.gaps > 0) {
  await applyPlan(run.id, [
    { id: "verify-crypto", kind: "verification", label: "验证加密实现", dependsOn: ["scan-auth"], agentSpec: { ... } },
  ]);
  await runReady(run.id);
  const eval2 = await evaluate(run.id);
  // 接受所有完成节点
  for (const node of Object.values(eval2.run.nodes)) {
    if (node.status === "completed") {
      await accept(run.id, node.id, "证据充分，接受");
    }
  }
}

// 完成
await complete(run.id, finalMarkdown);
```

```javascript
// 复杂示例：循环 + 条件 + 外部数据
async function deepResearch(goal) {
  const run = await start({ goal, mode: "deep-research" });

  // 第一阶段：侦察
  await applyPlan(run.id, [
    { id: "recon-1", kind: "research", label: "技术扫描", agentSpec: { ... } },
    { id: "recon-2", kind: "research", label: "市场分析", agentSpec: { ... } },
  ]);
  await runReady(run.id);
  await evaluate(run.id);

  // 基于结果动态决定第二阶段
  const recon1 = getResult(run.id, "recon-1");
  const recon2 = getResult(run.id, "recon-2");
  setVar("reconSummary", synthesize(recon1, recon2));

  // 循环：持续修复直到 gap 归零
  let maxIterations = 3;
  while (maxIterations-- > 0) {
    const eval = await evaluate(run.id);
    if (eval.gaps === 0 && eval.conflicts === 0) break;

    // 添加 verifier 节点修复 gap
    const verifierNodes = eval.gaps.map((gap, i) => ({
      id: `verify-${i}`, kind: "verification", label: `验证: ${gap.question}`,
      agentSpec: { ... },
    }));
    await applyPlan(run.id, verifierNodes);
    await runReady(run.id);
  }

  await complete(run.id, finalMarkdown);
}
```

### 3.2 脚本生命周期

```
生成阶段
    LLM 分析目标 → 生成 JS 脚本 → 展示给用户审批
                                      │
                                    用户审批
                                      │
                            ┌─────────▼──────────┐
                            │    审批通过?         │
                            └────┬───────┬───────┘
                          Yes    │       │  No
                            │    │       │
                            ▼    │       ▼
                            │    用户修改脚本 / LLM 重新生成
                            │
执行阶段
    ScriptRuntime 开始执行
        │
        ├── runAgent() → DelegationAdapter → 子 Agent 执行
        │   ├── 成功 → 结果存脚本变量
        │   └── 失败 → 脚本 if/else 决策修复
        │
        ├── evaluate() → Gates 评估
        │   ├── gap=0 → 继续
        │   └── gap>0 → 脚本动态加 verifier
        │
        ├── callSupervisor() → 暂停，等待 LLM 回复
        │   └── LLM 回复后 → 脚本继续执行
        │
        └── complete() → 写最终 artifact

完成后
    脚本可保存为 .pi-swarm/scripts/<runId>.js
    用户可编辑后重跑: /script run <scriptPath>
```

### 3.3 用户审批流程

```
LLM 生成脚本后，通过 workflow 工具返回：
  { action: "run_script", script: "..." }

TUI 弹出审批卡片：
  ┌─────────────────────────────────────────┐
  │  Pi Swarm · 脚本审批                      │
  │  ─────────────────────────────────────── │
  │                                           │
  │  脚本预览:                                │
  │  ┌─────────────────────────────────────┐ │
  │  │ const run = await start({...})      │ │
  │  │ await applyPlan(run.id, [...])      │ │
  │  │ await runReady(run.id)              │ │
  │  │ const eval = await evaluate(run.id) │ │
  │  │ if (eval.gaps > 0) { ... }          │ │
  │  └─────────────────────────────────────┘ │
  │                                           │
  │  [  运行  ]  [ 编辑  ]  [ 取消 ]          │
  └─────────────────────────────────────────┘

用户选择：
  - 运行：直接执行脚本
  - 编辑：打开编辑器，用户可修改脚本再运行
  - 取消：放弃执行
```

### 3.4 TUI 改动

#### 3.4.1 `workflow-cockpit.ts` 阶段轨道

当前：`PLAN → EXEC → REVIEW → FINAL`

脚本模式：`SCRIPT → PLAN → EXEC → REVIEW → FINAL`

```typescript
// 改动集中在 phaseStates() 和 phaseRail()
function phaseStates(snapshot: WorkflowViewSnapshot): Record<"script" | "plan" | "execute" | "review" | "final", CockpitPhaseState> {
  if (!snapshot.scriptMode) {
    // 非脚本模式，SCRIPT 阶段隐藏
    return { script: "completed", plan: ..., execute: ..., review: ..., final: ... };
  }
  // 脚本模式下，SCRIPT 阶段根据脚本执行状态显示
  return { script: scriptRunning ? "running" : "completed", plan: ..., execute: ..., review: ..., final: ... };
}
```

#### 3.4.2 `view.ts` 扩展

```typescript
interface WorkflowViewSnapshot {
  // ... 现有字段不变
  scriptMode?: boolean;
  scriptContent?: string;
  scriptSteps?: Array<{ name: string; status: string }>;
  scriptCurrentStep?: number;
  scriptOutput?: string;
}
```

#### 3.4.3 新增 Script 面板

- 位置：`aboveEditor`，与 workflow summary 并列
- 显示内容：
  - 脚本代码（语法高亮在 pi-tui 支持范围内）
  - 当前执行行指示
  - 执行进度（Step 3/8: Running agent scan-auth）
  - 最近输出行
- 键盘交互：
  - `e` 键编辑脚本（暂停时）
  - `r` 键重跑

### 3.5 SKILL.md 改动

**当前第 27 条**：
```
- Do not execute model-generated JavaScript or create another child executor.
```

**改为**：
```
- Do not execute model-generated JavaScript unless the user explicitly approved the generated script.
- When using script mode, the script must be approved by the user before execution.
- Script mode is activated through the `workflow({ action: "run_script", script: "..." })` tool.
- In script mode, the script calls the same Controller API actions as the Supervisor would,
  but execution results stay in the script's local variables, not in the LLM context.
- The Supervisor can still intervene via `callSupervisor()` pauses embedded in the script.
```

### 3.6 文件存储

**脚本存储路径**：`.pi-swarm/scripts/`

```
.pi-swarm/scripts/
  ├── history/
  │   ├── <runId>-v1.js     # 首次执行的脚本
  │   ├── <runId>-v2.js     # 用户编辑后的版本
  │   └── ...
  ├── templates/
  │   ├── deep-research.js   # 深度研究模板
  │   └── general-swarm.js   # 通用工作流模板
  └── current.js             # 当前工作流软链接
```

**命名规则**：`<runId>-v<revision>.js`

**版本化**：每次编辑保存为新版本，旧版本保留在 `history/` 中

---

## 4. 实施计划

### 阶段 1：脚本 API 定义（1 天）

| 任务 | 文件 | 说明 |
|------|------|------|
| 定义 `ScriptAPI` 接口 | `src/workflows/script-api.ts` | 所有供脚本调用的方法签名 |
| 定义 `ScriptResult` 类型 | `src/workflows/script-api.ts` | 脚本执行结果类型 |
| 定义 `ScriptStep` 类型 | `src/workflows/types.ts` | 脚本步骤类型 |

### 阶段 2：ScriptRuntime 实现（2 天）

| 任务 | 文件 | 说明 |
|------|------|------|
| 实现沙箱执行引擎 | `src/workflows/script-runtime.ts` | worker_threads + vm 沙箱 |
| 实现 API 到 Controller 的映射 | `src/workflows/script-runtime.ts` | `runAgent()` 等调用 `controller.execute()` |
| 实现超时/中止机制 | `src/workflows/script-runtime.ts` | 通过 AbortSignal 和 worker.terminate() |
| 实现 callSupervisor() 暂停 | `src/workflows/script-runtime.ts` | 通过 Promise + 事件等待 |

### 阶段 3：脚本存储与命令（1 天）

| 任务 | 文件 | 说明 |
|------|------|------|
| 实现脚本文件管理 | `src/workflows/script-store.ts` | 保存/加载/列表/版本管理 |
| 注册 `/script` 命令 | `src/workflows/commands.ts` | `run`, `edit`, `list`, `show` |
| 注册 `run_script` action | `src/workflows/tool.ts` | 新增 action 枚举和解析 |
| 扩展 extension/index.ts | `src/extension/index.ts` | 注册新组件 |

### 阶段 4：TUI 扩展（1 天）

| 任务 | 文件 | 说明 |
|------|------|------|
| 扩展 `WorkflowViewSnapshot` | `src/workflows/view.ts` | 加 script 相关字段 |
| 修改阶段轨道 | `src/tui/workflow-cockpit.ts` | 加 SCRIPT 阶段 |
| 修改活动标签 | `src/tui/workflow-cockpit.ts` | 加脚本分支 |
| 实现脚本面板 | `src/tui/workflow-script-panel.ts` | 脚本显示/编辑/执行进度 |
| 实现审批卡片 | `src/tui/workflow-approval.ts` | 用户审批 UI |

### 阶段 5：Skill 文档与测试（1 天）

| 任务 | 说明 |
|------|------|
| 更新 `SKILL.md` | 修改第 27 条约束 |
| 编写 `script-workflow` skill | 脚本模式使用指南 |
| 编写 `script-runtime.md` 参考 | 脚本 API 参考文档 |
| 单元测试 | `script-runtime.test.ts`, `script-api.test.ts` |
| 集成测试 | 脚本从生成到执行到完成的端到端测试 |

### 时间线

```
第 1 天：阶段 1（脚本 API 定义）
第 2-3 天：阶段 2（ScriptRuntime 实现）
第 4 天：阶段 3（脚本存储与命令）
第 5 天：阶段 4（TUI 扩展）
第 6 天：阶段 5（Skill 文档与测试）
─────────────────────────────
共 6 个工作日
```

---

## 5. 影响分析

### 5.1 对现有系统的影响

| 方面 | 影响 |
|------|------|
| **现有 supervisor 工作流** | 零影响。所有现有代码不变，脚本模式只是新增路径 |
| **现有测试** | 全部通过。所有现有测试不涉及脚本模式 |
| **现有用户** | 无感知。不主动使用脚本模式则完全不受影响 |
| **事件存储** | 完全兼容。脚本模式产生的事件与现有事件格式一致 |
| **TUI 显示** | 向后兼容。脚本模式新增字段不影响现有渲染 |
| **SKILL.md** | 唯一需要修改的核心约束，但改为条件约束而非完全禁止 |

### 5.2 安全考虑

| 风险 | 缓解措施 |
|------|----------|
| 脚本包含恶意代码 | 1. 用户审批机制：所有脚本执行前需用户确认 |
| | 2. vm 沙箱：不暴露 `require`、`process`、`fs` 等 API |
| | 3. 超时保护：默认 30 分钟超时自动中止 |
| 脚本死循环 | 超时机制 + worker 可终止 |
| 脚本破坏事件存储 | 脚本只通过 Controller API 写入事件，无法直接操作文件 |
| 脚本并行冲突 | 单脚本单线程，不与其他脚本并行（与 Supervisor 模式一致） |

### 5.3 与 Supervisor 模式的对比

| 维度 | Supervisor 模式 | 脚本模式 |
|------|----------------|----------|
| **决策者** | LLM 每步决策 | 脚本预定义逻辑 |
| **上下文开销** | O(n)，n=节点数 | O(1)，仅最终答案 |
| **支持 100+ 节点** | 上下文爆炸 | 可行 |
| **用户可编辑流程** | 需要 LLM 重新规划 | 直接编辑脚本文件 |
| **可复用性** | 依赖 LLM 记忆 | 脚本可保存/版本化 |
| **灵活性** | 高，LLM 可适应任意场景 | 中，需要预定义逻辑 |
| **调试** | 复杂，需要 LLM 日志 | 简单，脚本可加 console.log |
| **混合能力** | 不支持 | 支持 callSupervisor() 暂停 |

---

## 6. 未解决的问题

1. **脚本如何安全地访问外部资源？** 当前方案中脚本不暴露 `fs`/`http`。如果需要读取文件或调用 API，应该通过 ScriptAPI 的 `readFile()`/`fetch()` 等受控方法，还是直接允许 `import`？

2. **callSupervisor() 的交互 UX？** 暂停脚本后，LLM 回复的上下文应该包含什么？是只包含问题，还是包含当前脚本执行状态（变量、位置、已执行步骤）？

3. **脚本的 CI/CD 集成？** 脚本作为文件保存后，是否应该有 CI 检查（语法验证、API 签名匹配）？是否应该支持在 pre-commit 中自动验证？

4. **大规模脚本的进度展示？** 100+ 节点的脚本执行时，TUI 的 cockpit 只能显示 5 行，是否需要一个新的"脚本执行 DAG 视图"？

5. **脚本模板管理？** 是否应该提供一组内置模板（`deep-research.js`、`security-audit.js` 等），让用户可以直接 `swarm run --template security-audit`？

---

## 附录 A：代码变更清单

```
新增文件：
  src/workflows/script-runtime.ts     (~400 行) 脚本沙箱执行引擎
  src/workflows/script-api.ts         (~200 行) 脚本 API 封装
  src/workflows/script-store.ts       (~100 行) 脚本文件管理
  src/tui/workflow-script-panel.ts    (~200 行) 脚本编辑器面板
  src/tui/workflow-approval.ts        (~100 行) 审批卡片 UI
  skills/script-workflow/SKILL.md     (~50 行)  脚本模式 skill
  skills/script-workflow/references/script-runtime.md (~100 行) API 参考

修改文件：
  src/workflows/tool.ts               +10 行    新增 run_script action
  src/workflows/commands.ts           +40 行    新增 /script 命令
  src/workflows/view.ts               +15 行    扩展 WorkflowViewSnapshot
  src/tui/workflow-cockpit.ts         +30 行    阶段轨道 + 活动标签
  src/extension/index.ts              +50 行    注册新组件
  skills/dynamic-workflow/SKILL.md    +5 行     修改第 27 条约束

新增文件总量：~1050 行
修改文件总量：~150 行
总计：~1200 行
```

## 附录 B：核心 API 参考（草案）

### ScriptAPI

```typescript
interface ScriptAPI {
  // ===== 底层 Controller API 封装 =====
  start(params: WorkflowStartParams): Promise<WorkflowRun>;
  applyPlan(runId: string, nodes: WorkflowNodePlan[]): Promise<WorkflowRun>;
  runReady(runId: string, concurrency?: number): Promise<WorkflowRun>;
  evaluate(runId: string): Promise<WorkflowEvaluation>;
  accept(runId: string, nodeId: string, decision: string): Promise<WorkflowRun>;
  reject(runId: string, nodeId: string, decision: string): Promise<WorkflowRun>;
  complete(runId: string, finalMarkdown: string): Promise<WorkflowCompleteResult>;
  status(runId: string): Promise<WorkflowRun>;
  getResult(runId: string, nodeId: string): Promise<WorkflowNodeResult>;
  quality(runId: string): Promise<WorkflowQualityReport>;
  pause(runId: string): Promise<WorkflowRun>;
  resume(runId: string): Promise<WorkflowRun>;
  stop(runId: string): Promise<void>;

  // ===== 高层便利方法 =====
  runAgent(spec: AgentSpec, options?: RunAgentOptions): Promise<WorkflowResult>;
  runAgents(specs: AgentSpec[], options?: RunAgentsOptions): Promise<Map<string, WorkflowResult>>;
  waitForAll(runId: string): Promise<WorkflowRun>;

  // ===== 脚本变量存储 =====
  setVar(key: string, value: unknown): void;
  getVar(key: string): unknown;
  hasVar(key: string): boolean;

  // ===== 暂停/恢复 =====
  callSupervisor(question: string, context?: Record<string, unknown>): Promise<string>;

  // ===== 条件判断 =====
  evaluateGates(run: WorkflowRun): WorkflowEvaluation;
  hasGaps(run: WorkflowRun): boolean;
  hasConflicts(run: WorkflowRun): boolean;
  allAccepted(run: WorkflowRun): boolean;
  countStatus(run: WorkflowRun, status: string): number;
}
```
