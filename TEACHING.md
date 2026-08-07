# Pi Agents Flow 教学与源码导览

## 1. 这个 Extension 解决什么问题

普通 SubAgent 只能回答“怎样把一个任务交给另一个 Agent”。Pi Agents Flow 继续处理更难的问题：

1. 主 Agent 如何先调查，再决定工作图，而不是一次猜完计划；
2. 怎样为每个临时 Agent 定义角色、目标、工具、Skill、模型和预算；
3. 哪些节点可以并行，哪些节点必须等待依赖；
4. 子 Agent 返回以后，谁判断接受、拒绝、重试或补查；
5. 进程退出后，工作流怎样恢复；
6. 人怎样观察、暂停、干预和追溯一次执行；
7. 最终答案怎样经过证据、冲突、Writer 和 Reviewer 收敛。

Pi Agents Flow 的答案是 supervisor-led swarm：当前根 Pi Agent 是唯一 Supervisor，Extension 提供持久化工作图、调度器、临时 AgentSpec、结果协议、质量门禁和 TUI。子 Agent 只执行一个受限节点，不拥有整个工作流。

## 2. 一个贯穿全程的例子

在仓库根目录启动 Pi，然后运行：

```text
/deep-research Kimi Agent Swarm 如何创建 subagent、并行执行、负反馈补查并收敛结果？
```

主 Agent 会执行下面的闭环：

```text
用户问题
  -> 创建 Workflow Run
  -> 调查并生成 typed DAG
  -> 并行启动多个 Researcher
  -> 显式接受或拒绝结果
  -> 对 gap/conflict 创建 Verifier
  -> 生成 accepted-claims.json 和 writer-context.md
  -> Writer 只使用已接受材料写作
  -> Reviewer 独立审核
  -> Quality Gate
  -> delivery/final.md
```

这个流程不是固定脚本。Supervisor 可以在看到第一轮结果后追加节点，也可以因为来源不足、冲突、失败或用户反馈重新规划。

## 3. 安装和运行

从个人仓库拉取教学分支：

```bash
git clone -b codex/galaxyxieyu-sync https://github.com/GalaxyXieyu/pi.git
cd pi
npm install --ignore-scripts
pi install ./learning/pi-harness/extensions/pi-agents-flow
```

不要安装 npm 上的第三方同名包。这个教学版本的真相源就是当前仓库目录。

常用入口：

| 命令 | 用途 |
| --- | --- |
| `/swarm <目标>` | 通用 Supervisor 请求入口 |
| `/workflow run <目标>` | 通用动态工作流 |
| `/deep-research <问题>` | 证据驱动的研究工作流 |
| `/workflow status` | 查看持久化状态和下一步 |
| `/workflow board` | 打开节点、依赖、attempt、质量和 artifact 视图 |
| `/workflow quality` | 查看结构化质量报告 |
| `/workflow pause` | 停止启动新节点 |
| `/workflow resume` | 恢复并主动调度 ready 节点 |
| `/workflow stop` | 停止整个 workflow |

## 4. 源码地图

### 4.1 Extension 装配

- `index.ts`：Pi Package 入口。
- `src/extension/index.ts`：注册工具、命令、TUI、恢复逻辑和 delegation adapter。
- `src/workflows/commands.ts`：`/workflow`、`/deep-research` 等用户入口。
- `src/workflows/tool.ts`：Supervisor 可见的结构化 `workflow` 工具。

学习问题：一个 TypeScript interface 为什么不会自动产生运行时行为？沿着 `index.ts -> register -> controller.execute` 追踪真实对象和事件注册。

### 4.2 状态与 Graph

- `src/workflows/types.ts`：WorkflowRun、WorkflowNode、Attempt、AgentSpec 和 ResultEnvelope。
- `src/workflows/store.ts`：append-only event log 与原子 manifest 投影。
- `src/workflows/reducer.ts`：事件如何变成当前工作流状态。
- `src/workflows/gates.ts`：节点依赖、接受状态、gap/conflict 和完成条件。
- `src/workflows/branch-binding.ts`：session、cwd、Git branch 与 workflow 的绑定。

可以把它类比成 Python：

```python
new_state = reduce(old_state, event)
```

`events.jsonl` 是恢复真相，`manifest.json` 是为了快速读取的当前投影。

### 4.3 Supervisor 与调度

- `src/workflows/controller.ts`：Supervisor 的状态转换入口。
- `src/workflows/scheduler.ts`：选择 ready 节点、限制并发、记录 immutable attempt。
- `src/workflows/runtime.ts`：启动、reload、resume 后的主动续跑。
- `src/workflows/delegation-adapter.ts`：把 AgentSpec 转换成现有 subagent delegation v2 请求。
- `src/workflows/query-strategy.ts`：Research lane 的 query 和 source portfolio。

这里最重要的边界是：Extension 调度节点，模型决定策略；模型不能直接编辑 Workflow Store。

### 4.4 临时 Agent Factory

- `skills/dynamic-workflow/references/agent-factory.md`：AgentSpec 设计方法。
- `agents/researcher.md`：宽范围证据获取。
- `agents/research-verifier.md`：只验证指定 gap/conflict。
- `agents/research-writer.md`：默认不能自由搜索，只消费 accepted bundle。
- `agents/research-reviewer.md`：独立检查最终稿和已注册证据。

AgentSpec 可以缩小能力，但不能凭空增加工具。真正的工具集合仍由 persistent base Agent 定义。

### 4.5 结果质量与负反馈

- `src/workflows/evidence.ts`：引用、URL 归一化、证据排序和 claim 去重。
- `src/workflows/benchmark.ts`：研究搜索质量指标。
- `src/workflows/quality.ts`：发布质量报告和 blockers。
- `src/workflows/guidance.ts`：根据 gap/conflict/状态生成下一步建议。
- `src/workflows/context-bundle.ts`：把 accepted claims 变成 Writer 上下文。
- `src/workflows/policy.ts`：把硬编码 gate 变成可配置策略。

负反馈不是一句“再搜索一下”。它必须变成可追踪动作：reject、retry、record decision、spawn verifier 或 append research lane。

### 4.6 恢复、HITL 与停止

- waiting child 保留同一个 attempt 和 childRunId；
- orphaned running attempt 在重启后变成 retryable failure；
- pause 只阻止新调度，不删除结果；
- cancel_node 只终止一个 child，不影响兄弟节点；
- stop 终止整个 run，但保留 artifact 和 attempt history；
- `contact_supervisor` 与 `pi-intercom` 承担长任务中的决策升级。

对应实现主要位于 `controller.ts`、`scheduler.ts`、`runtime.ts` 和 `src/intercom/`。

### 4.7 可观察性

- `src/workflows/board.ts`：Workflow Board TUI。
- `src/workflows/view.ts`：从 run 投影出可显示的 graph/attempt/child 信息。
- `src/workflows/todo-projection.ts`：把 phase 和 node 投影到现有 Todo。
- `src/workflows/todo-adapter.ts`：通过版本化事件桥接 `rpiv-todo`。

Workflow Store 是真相源。Todo 和 Board 都是投影，不能反过来推断执行状态。

## 5. 推荐学习顺序

1. 运行一次 `/deep-research`，只观察 Board、Todo 和落盘文件；
2. 阅读 `types.ts`、`store.ts`、`reducer.ts`，理解 event-sourced graph；
3. 阅读 `tool.ts`、`controller.ts`，跟踪一次 Supervisor action；
4. 阅读 `scheduler.ts` 和 delegation adapter，跟踪一次 child launch；
5. 阅读 evidence、quality、guidance，理解负反馈如何产生新节点；
6. 用进程退出、provider 失败、节点取消和冲突证据做恢复实验；
7. 最后再修改 AgentSpec、Policy 或新的 workflow strategy。

## 6. 验证命令

在 Extension 目录执行：

```bash
npm install --ignore-scripts
npm run test:unit
npm run test:integration
npm run check:rpiv-todo-bridge
```

Deep Research benchmark：

```bash
npm run benchmark:workflow -- --variant runtime-planned <workflow-run-dir> [...]
```

重点观察 claim support、unsupported claim、source diversity、fetch coverage、跨 lane duplicate rate 和多次运行标准差。

## 7. 上游与维护边界

Pi Agents Flow 基于 `nicobailon/pi-subagents`，保留其 SubAgent 执行、agent discovery、Fleet、intercom 和 async runtime。当前仓库新增并维护 Supervisor-owned Dynamic Workflow、Deep Research、质量门禁、恢复和 Workflow Board。

同步上游时应先比较 delegation/public API，再合并新功能；不要把 `src/workflows/` 直接覆盖。运行状态写入 `.pi-agents-flow/`，不应提交到 Git。
