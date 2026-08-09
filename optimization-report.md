# pi-agents-flow 优化基线与渐进路线

> 适用范围：本报告服务于 `pi-agents-flow` 作为通用 Pi 插件的持续演进。它覆盖普通 subagent 调度、`/coding`、通用 workflow 与 Deep Research，而不是只为某一次研究任务设计。
>
> 基线：`main` 的 `7da2836`。本文将已核验事实、需要测量的假设、以及已决定的工程策略分开写，避免把静态阅读中的推测当作已发生的性能问题。

## 一页结论

这个项目当前最值得优先治理的不是一次性拆目录，也不是预先做性能优化，而是三个会影响所有使用场景的运行语义问题：

1. **结果与证据契约必须在节点完成时就验证**。声明为 `text/*` 的输出不能接受 JSON 对象，`concat-text` 只能连接 text 端口。否则错误会被延迟到下游节点，表现为无法解释的重试或连锁失败。
2. **质量策略必须与实际证据模式匹配**。本地代码库、网页研究和混合任务不能共享“必须有 URL”的完成条件。默认应提供质量告警，只有调用方明确要求时才启用严格证据门禁。
3. **失败、替代与完成必须有单一且可操作的语义**。可原地重试、必须 replacement、已被 replacement 接管、accepted 审计记录、以及最终可完成，必须在 Controller、repair guidance、活动面板和 transcript card 中使用一致口径。

当前代码已经完成一部分治理：本地证据验证、持久化失败分类、模型继承与 fallback、结果 media type 校验、`auto/advisory` 证据质量模式，以及 superseded 节点统计修复。下一阶段应先把这些已出现的复杂度沉淀成稳定边界和测试，再决定是否拆分大文件。

**不建议当前进行全仓目录迁移或“大拆大建”。** `src/runs/foreground/subagent-executor.ts`、`src/agents/agents.ts`、`src/shared/types.ts` 的体积确实值得关注，但行数只能说明阅读与变更风险，不能单独证明职责边界应该怎样切。先用行为测试和依赖图确定切点，再做小批迁移。

## 已核验的代码事实

以下数据来自当前工作树，而非估算。

| 项目 | 当前事实 | 含义 |
| --- | --- | --- |
| TypeScript 源文件 | `194` 个 `src/**/*.ts` 文件 | 系统已经具备多个明确子域，不需要先建立一层新的总目录才能模块化。 |
| 单测文件 | `167` 个 `test/unit/*.test.ts` 文件 | 测试并不稀少；缺口在关键跨模块行为的覆盖和执行时长，不是简单增加文件数量。 |
| `src/runs/foreground/subagent-executor.ts` | `4,644` 行 | 首要候选拆分对象，但应先按前景执行、恢复、嵌套控制、结果投递建立特征测试。 |
| `src/shared/types.ts` | `1,931` 行 | 类型域集中，适合渐进提取领域类型并保持 re-export 兼容。 |
| `src/agents/agents.ts` | `1,880` 行 | Agent 发现、配置解析、覆盖合并和 package 解析存在不同变更节奏。 |
| `src/workflows/controller.ts` | `1,194` 行 | Controller 同时承担生命周期、恢复、调度入口、质量/完成判断和持久化协调。 |
| `src/extension/index.ts` | `704` 行 | 是装配入口，不是 1,500 行级别的“必须立刻重写”的文件。应提取可独立测试的装配块，而不是引入新的全局注册框架。 |
| workflow 质量与策略 | `quality.ts` 412 行，`policy.ts` 246 行，`guidance.ts` 356 行 | 已形成较好的纯函数候选域，适合先稳定接口并做行为测试。 |

已确认的运行路径包括：

```text
index.ts
  -> extension/index.ts
      -> workflow controller + delegation adapter + tools
      -> foreground/background runners
      -> activity projection / TUI
```

`workflow_assets`、Agent/skill 发现和组合管理会执行同步文件系统读取。这个事实说明启动和交互路径存在可测量的 I/O 成本，但**尚未证明它是用户可感知瓶颈**。是否缓存、何处懒加载，必须先用基准数据决定。

## 当前已修复的通用问题

这部分不是某次 Deep Research 的特例，所有动态 workflow 都会受益。

### 1. 输出契约在源头校验

已落地：

- `text/*` 输出端口的 value 必须是字符串。
- `concat-text` 只能绑定声明为 `text/*` 的上游端口。
- 结构化结果或 context pack 的契约错误分类为 `invalid_result`，不再伪装成 provider transport failure。

这避免了“研究节点提交对象、writer 启动时才发现不能拼文本、随后无意义重试”的延迟失败链。

相关实现：

- `src/workflows/result-contract.ts`
- `src/workflows/data-contract.ts`
- `src/workflows/context-pack.ts`
- `src/runs/shared/model-fallback.ts`

### 2. 证据模式与质量门禁解耦

策略增加：

```ts
policy.evidenceMode = "auto" | "web" | "local" | "mixed"
policy.qualityEnforcement = "advisory" | "strict"
```

默认 `auto + advisory`。系统根据 accepted evidence、`artifactPath`、`file://` 与已记录 fetch 行为推断实际证据模式，并将 citation、fetch、writer claim support 等指标呈现为质量告警。

只有调用方显式指定 `strict` 时，才按所选模式把相应指标变为 blocker：

| 模式 | 严格模式要求 |
| --- | --- |
| `web` | HTTP(S) 证据、fetch provenance、网页引用质量 |
| `local` | 可验证的本地 artifact 或 `file://` 证据，不要求 URL |
| `mixed` | 两类证据各自可追溯 |
| `auto` | 根据 accepted evidence 推断上述模式 |

这使插件可以同时支持源码审计、内部决策备忘录、网页研究与混合交付，而不会让 URL 密度统计否决 Reviewer 已批准的本地交付物。

### 3. 失败与 replacement 的状态语义

已落地的失败分类包括 provider quota/auth/rate limit/stream/transport、process termination、turn/tool budget、timeout、invalid result、output registration 与 preflight failure。

关键约束：

- 可重试失败只能显式重试原节点。
- 不可重试失败要先检查 retained output，再创建同 kind replacement。
- 节点模型是不可变的。更换模型或 provider 必须使用 replacement。
- `accepted` 节点是审计历史，不能成为 `replaces` 目标。
- accepted Reviewer 指出文档问题时，应追加新的 editor revision，再追加新的 reviewer；不能替换 accepted reviewer。
- `complete` 只应在 `evaluate.readyToComplete === true` 时执行。

这套规则必须同时出现在 reducer、Controller 报错、repair guidance、tool prompt 和活动视图中。只在其中一处正确，会导致 Supervisor 看到了正确状态却采取错误动作。

### 4. UI 统计以有效执行单元为准

已修复：

- 只要同一任务下仍有 `running` 节点，父任务显示 running，不被历史 failed sibling 覆盖。
- `superseded` 节点不再计入“待开始”。
- 失败节点详情会说明下一步是原地 retry、replacement、reopen，还是已有 replacement 正在接管。

历史 transcript 是持久化渲染记录，不能倒改；新产生的状态卡和活动投影使用新口径。

## 面向全部插件场景的设计原则

### 1. 状态机优先于提示词

Prompt 可以减少错误，但不能承担正确性。以下规则必须由 reducer/Controller 强制：

- 工作流状态转换是否合法。
- `replaces` 的目标是否可替代。
- 最终 Editor 与 Reviewer 是否处于同一 revision 链。
- completion source 是否为 accepted artifact。
- 节点结果是否符合 data contract。

提示词和 skill 文档的职责是告诉 Supervisor 如何选择下一步，不是补偿状态机的漏洞。

### 2. 质量报告、完成门禁、Reviewer 判断分层

三者不能混为一个“quality gate”。

| 层级 | 责任 | 默认是否阻断完成 |
| --- | --- | --- |
| 结构门禁 | 必要节点、有效依赖、accepted artifact、最终 Reviewer release | 是 |
| 证据质量报告 | citation、fetch、trace、claim support、source diversity | 否，默认 advisory |
| Reviewer 判断 | 文档是否适合当前用户目的，剩余风险是否可接受 | 是，Reviewer release 决定语义放行 |

如果用户明确要求可审计的网页研究或合规报告，再把证据质量策略改为 `strict`。这应由任务/政策声明，不应由框架猜测。

### 3. 先记录行为，再优化性能

项目已有 `npm run benchmark:workflow`。下一阶段应先扩展它，而不是预设“同步 I/O 一定导致 P99 很高”。每次优化都记录：

- 冷启动至扩展可用的耗时。
- `workflow_assets` 首次与重复调用耗时。
- Agent/skill discovery 的文件数与耗时。
- 同时运行 1、4、8 个 workflow node 时的队列等待、执行时长与错误率。
- context pack 的字节数、估算 token 与物化耗时。
- recovery、retry、replacement 的事件数量和完成路径。

将基准输出写入可比较的 JSON，而不是只在终端打印。没有基线的缓存、懒加载和并发控制都是猜测。

### 4. 边界按变更原因切，不按目录美观切

建议的拆分顺序不是新建 `core/` 后迁移所有文件，而是从高频一起变更、同时可被特征测试覆盖的区域开始。

| 候选边界 | 推荐的第一步 | 不做什么 |
| --- | --- | --- |
| Foreground executor | 从 `subagent-executor.ts` 提取纯结果归一化、恢复判定和嵌套控制 helper | 不同时重写 foreground/async 协议 |
| Agent discovery | 将文件系统发现与 override/config merge 分为内部模块，保留当前 export facade | 不改变用户 Agent 文件格式 |
| Workflow Controller | 提取状态查询、completion validation、recovery reconciliation 等纯 helper | 不改变 workflow event schema |
| Shared types | 先建立领域 re-export，再逐个移动低耦合类型 | 不一次性修改所有 import |
| Extension 装配 | 提取 workflow setup 与 lifecycle cleanup factory | 不引入新的全局 service locator |

每个拆分必须满足：公开 import 兼容、行为测试先行、单次 PR 只迁移一条调用链、全量 unit tests 通过。

## 优先级与验收标准

### P0：运行语义与诊断稳定化

目标：让任何使用方式都能解释“为什么失败、下一步是什么、能否完成”。

待做：

1. 将 `WorkflowFailureClass`、retryability、suggested action 投影到所有状态卡与 Fleet 详情，而不仅是 Controller 文本。
2. 为 `workflow.evaluate` 输出一个紧凑的 machine-readable repair decision，避免 Supervisor 重新从自然语言解析下一步。
3. 给 `evidenceMode` 与 `qualityEnforcement` 增加用户可见的质量报告说明和最小示例。
4. 对 `strict + web/local/mixed` 分别补一条端到端 fixture。

验收：失败节点无需读取 manifest 就能知道 retry/replacement/reopen 的选择；`complete` 被拒绝时返回可执行的唯一下一步或明确的有限选项。

### P1：基准与观测

目标：用数据决定性能优化，不凭目录扫描或同步 API 的存在做判断。

待做：

1. 扩展 `scripts/workflow-benchmark.ts`，输出 JSON 基线和人类摘要。
2. 为 discovery、context pack、scheduler queue 与 lifecycle recovery 增加轻量耗时计数。
3. 在 CI 或发布前比较基线，设定回归阈值但先从 warning 开始。

验收：能够回答“哪个路径变慢、变慢多少、优化是否有效”，并可复现。

### P2：安全的内部拆分

目标：降低 4 个大文件的单次改动半径。

顺序：

1. `subagent-executor.ts` 提取无副作用 helper 和恢复逻辑。
2. `agents.ts` 分离 discovery 与 override merge。
3. `controller.ts` 分离 completion/quality/recovery 的纯决策逻辑。
4. `shared/types.ts` 通过兼容 re-export 渐进拆领域类型。

验收：每一步都有迁移前后测试，公共导出不变，避免全仓机械 import 迁移。

### P3：开发者接口与文档

目标：让用户知道何时选 subagent、workflow、`/coding`、Deep Research，以及失败后该做什么。

待做：

1. 在 README 添加“选择入口”表和三份完整最小示例：普通并行任务、代码交付、local-codebase research。
2. 为 workflow policy 增加 typed JSON 示例，涵盖 advisory 和 strict evidence contract。
3. 若创建 CLI，先提供 `validate` 和 `benchmark`；不要先做大量模板生成命令。

验收：新用户无需阅读 Controller 源码即可创建、验证和恢复一个 workflow。

## 不在当前路线中的事项

以下方向在缺少数据或明确需求前不进入实施：

- 以“启动可能慢”为理由立即引入全局缓存、懒加载或新的并发库。
- 将整个 `src/` 重排为新 `core/execution/platform` 目录。
- 为了统一风格重写现有 public API。
- 让质量分数自动覆盖 Reviewer 的语义判断。
- 使用 AI 自动修改持久化 workflow manifest 或 events。

这些改动要么缺乏量化收益，要么会显著扩大兼容性风险。

## 维护检查表

每次涉及 workflow、调度、质量或 TUI 状态的改动，至少检查：

- 结果是否在产生处就按 declared media type 验证。
- 失败分类是否明确 retryability 与 suggested action。
- replacement 是否只针对可替代的非 accepted 节点。
- `evaluate.nextAction`、repair guidance、Controller 错误和活动面板是否一致。
- local/web/mixed 证据是否被正确识别；strict 是否仅在任务明确要求时启用。
- `npm run test:unit` 与相关定向测试是否通过。
- 若改动影响性能路径，是否更新或运行 benchmark 并保留结果。

## 结论

pi-agents-flow 的下一轮优化应围绕“把复杂的运行语义做成可验证的产品能力”展开。它要服务的不只是 Deep Research，也包括普通 subagent 调度、代码交付、内部源码审计和需要严格外部证据的研究任务。

最可靠的路线是：先稳定契约、状态和诊断；再建立性能基线；最后以兼容 facade 和行为测试为前提拆分真实耦合点。这样能持续降低维护成本，又不会为了架构整洁牺牲现有插件用户的运行稳定性。
