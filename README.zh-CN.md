# Pi Agents Flow

> 英文详版见 [README.md](./README.md) · 架构与技术概述见 [docs/pi-agents-flow-overview.zh-CN.md](./docs/pi-agents-flow-overview.zh-CN.md) · 源码导览见 [TEACHING.md](./TEACHING.md)

`pi-agents-flow` 是运行在 Pi 内部的多 Agent 编排扩展。它把根 Pi 变成一个**主管（Supervisor）**：负责拆解任务、安排执行顺序、验收结果；子 Agent 各自完成一段有边界的工作。任务可以并行，也可以按依赖推进，整个过程持久化、可观察、可中断恢复。

本学习分支维护在 [`GalaxyXieyu/pi`](https://github.com/GalaxyXieyu/pi)，基于 [`nicobailon/pi-subagents`](https://github.com/nicobailon/pi-subagents)，沿用其 MIT 许可与变更历史。

---

## 它解决什么问题

单个 Agent 的上下文有上限，但真实长任务会突破这个上限。`pi-agents-flow` 把「一个无所不能的大上下文」拆成「一个主管 + 一堆有边界的小上下文」，工程化地处理四类痛点：

1. **上下文爆炸**：长任务全挤在主上下文里 → 漂移、漏步、记不住验收标准。解法是把结构和中间状态从主上下文**移出**，放进持久任务图；根 Pi 只保留判断，不保留细节。
2. **角色/技能/工具越堆越多**：几十个 Agent 全量暴露 → 选择累、容易叫错人、白烧 token。解法是**渐进式披露**：默认收窄，按需暴露。
3. **手写编排难复用**：每次加角色都要重复定义它读什么、用什么工具、多少预算。解法是 saved chains + 托管的类型化工作流，结构和依赖由图决定，不靠模型记流程。
4. **无验证就交付 / 中断无法恢复**：解法是验收闭环（accept/reject/repair）+ 事件溯源断点恢复。

一句话定位：

> **在「模型自由发挥」和「硬编码脚本」之间，找到一个兼顾确定性、可观察性、可恢复性与灵活性的中间点。**

---

## 与 goal 工具的区别

如果你已经在用目标/目标管理类扩展（例如 `pi-goal-x`），两者在纸面上有重叠——都会持久化进度、跟踪任务、用独立检查把关完成。但核心问题不同：

| 维度 | Goal 工具（如 `pi-goal-x`） | `pi-agents-flow` |
|---|---|---|
| **解决的核心问题** | 一个长期目标如何跨会话被持续推进、跟踪、验收？ | 一个大任务如何拆给多个有边界的 Agent、并保持彼此隔离？ |
| **执行者数量** | 1 个主 Agent 干活 + 1 个独立 auditor 验收 | 1 个主管 + N 个有边界的子 Agent（15 个内置角色）编排执行 |
| **任务分解** | 一张主 Agent 自己走完的任务树 | 一张按序 / 并行 / fork 编排的子 Agent 依赖图 |
| **上下文隔离** | 主 Agent 在单个上下文里推进 | 每个子 Agent 独立的 `fork`/`fresh` 上下文、工具白名单、模型、预算 |
| **完成把关** | Auditor 核对目标与验证契约 | 主管 evaluate 每个结构化结果，独立 reviewer 可把关 writer 产出 |
| **最适合** | 用单个 Agent 持续啃一个目标（研究、调试、实现） | 大到值得拆分、需要并行 / 隔离 / 可恢复的流水线任务 |

两者**不互斥**。常见组合：用 goal 工具管理长期目标与进度审计，当某个阶段大到一个上下文装不下时，用 `pi-agents-flow` 把它拆给多个子 Agent。

---

## 功能能力总览

| 能力域 | 它能给你什么 | 详见 |
|---|---|---|
| **多 Agent 编排** | `single` / `parallel` / `chain` / 后台（`async`）四种执行模式；可组合顺序、静态/动态并行扇出、保存工作流 | [执行模式](#发生了什么) |
| **Supervisor 托管的持久工作流** | 由 scheduler 驱动的类型化依赖图；根 Pi 决定下一步、把关验收，仅在显式质量门禁通过后完成；事件溯源可中断恢复 | [工作流](#工作流) |
| **3 个现成工作流引擎** | `/coding`（确定性 plan→build→verify）、`/workflow run`（通用 DAG）、`/deep-research`（源溯源研究，并行研究线 + 独立复核） | [三个引擎](#三个工作流引擎) |
| **15 个内置角色 Agent** | `scout`、`researcher`、`planner`、`worker`、`reviewer`、`context-builder`、`oracle`、`delegate` + deep-research 专用角色 | [内置角色](#内置角色-agent) |
| **per-agent 上下文策略** | 每个子 Agent 独立 `fork`（分支父会话、继承讨论）或 `fresh`（干净会话），可用 `forkPreamble` 定制 fork 引导；一个 chain 里可混用 | [上下文策略](#上下文策略fork-与-fresh) |
| **渐进式披露** | 默认收窄 Agent 目录与 skill/工具面，按需通过 `visibility`、`invocation`、惰性加载 skill、工具白名单暴露；省 token、减少选错 | 见「使用建议」 |
| **能力上限** | 限制每个节点的模型、上下文、工具、turn/工具预算、子 Agent 深度，防止失控子 Agent 越界 | 见「Agent frontmatter」 |
| **验收与修复闭环** | 主管 evaluate 每个结构化结果并接受 / 拒绝 / 加修复节点；独立 review 可把关 writer 产出 | 见「工作流」 |
| **可观测性** | Tasks、Agents、Fleet、Activity Dock 视图 + `events.jsonl` 事件溯源；查看计划、实时执行、每 Agent 的模型/工具/系统提示/transcript、成本（`/subagent-cost`） | 见「核心概念」 |
| **程序化 API** | 4 个导出扩展 API：delegation、后台工作 provider、能力上限、preflight（fork 就绪、模型解析） | 英文详版「Extension delegation API」 |

---

## 快速上手

不需要先建 Agent、写配置或记命令。装完后直接用自然语言让 Pi 委派：

```text
用 reviewer 评审这个 diff。
```

```text
让 oracle 对我当前计划给个第二意见。
```

```text
用 scout 基于我们的讨论理解这段代码，然后问我澄清问题。
```

```text
并行跑两个 reviewer：一个看正确性，一个看测试，一个看不必要的复杂度。
```

这样就能开始了。更复杂时再逐步使用 saved chain 和 supervisor workflow。

---

## 安装

克隆父仓库，然后直接安装这个 checkout 出的 Extension：

```bash
git clone https://github.com/GalaxyXieyu/pi.git
cd pi
pi install ./learning/pi-harness/extensions/pi-agents-flow
```

安装 tagged Alpha 版本：`pi install npm:pi-agents-flow@0.1.0-alpha.1`。（注意：名称相近的 npm 包 `pi-agent-flow` 与本项目无关。）

支持：Node.js 22.19+、Pi packages 0.81.x、Linux / macOS / Windows。CI 覆盖 Node 22.19/24（Linux/Windows）及 tarball 安装。参见 [SUPPORT.md](./SUPPORT.md)、[SECURITY.md](./SECURITY.md)、[CONTRIBUTING.md](./CONTRIBUTING.md)。

---

## 核心概念

### 发生了什么

Pi 是父会话。子 Agent 是一个专注的 Pi 子会话，带着自己的任务。当你要求一个子 Agent，Pi 启动它、交给任务、取回结果。前台运行在对话中实时流出；后台运行继续工作，之后可查看。

### 内置角色 Agent

| Agent | 什么时候用它 |
|---|---|
| `scout` | 快速本地代码侦察：相关文件、入口、数据流、风险，以及另一个 Agent 该从哪里开始 |
| `researcher` | 带出处的网页/文档研究：官方文档、规范、基准、近期变化，产出简洁研究简报 |
| `planner` | 从现有上下文产出一个可落地的实现计划。只读与规划，不改代码 |
| `worker` | 实现工作，包括经批准的 oracle 交接。会改文件、验证，未批准的决策升级而非猜测 |
| `reviewer` | 代码评审与小幅修复。对照任务/计划、测试、边界与简洁性检查实现 |
| `context-builder` | 规划前更强的上下文搭建：收集代码上下文，产出 `context.md`、`meta-prompt.md` 等交接材料 |
| `oracle` | 行动前的第二意见。挑战假设、捕捉漂移、建议最安全下一步，不改代码 |
| `delegate` | 轻量通用委派，行为最接近父会话 |

简单经验：先 `scout` 理解代码 → `researcher` 信任外部事实 → `planner` 做大改动 → `worker` 实现 → `reviewer` 检查 → `oracle` 在决策本身有风险时兜底。

### 上下文策略：fork 与 fresh

- **`fresh`（默认）**：全新会话，不继承父会话历史，物理隔离。适合独立客观的角色（scout / reviewer / researcher）。
- **`fork`**：分支父会话，继承讨论结论，跨轮延续。内置 `planner`、`worker`、`oracle`、`advisor` 默认 fork。
- **`forkPreamble`**：可选 frontmatter 字段，为每个 fork 子 Agent 定制注入的引导前导，替代统一的默认前导。

一个 chain/parallel 运行里可以混用两种上下文——fresh 默认的 scout 可以和一个 fork 默认的 worker 并排运行。

### Agent frontmatter

Agent 是带 YAML frontmatter 的 Markdown 文件。核心字段：

```yaml
---
name: code-analysis.scout
description: 快速本地代码侦察
defaultContext: fresh      # 或 fork
forkPreamble: 你是从父会话分支的委派子 Agent，把继承的对话仅作参考上下文……
model: deepseek-v4-flash
visibility: default        # 或 hidden
invocation: both           # both / model / user / disabled
skills: [skill-a, skill-b]
tools: [read, bash]
maxSubagentDepth: 2
toolBudget: { hard: 40 }
---
```

### 工作流

Supervisor 托管的持久工作流把多步工作固化成类型化依赖图，事件写入 `events.jsonl`。终端退出、Pi reload 或暂停后，Controller 可根据记录恢复状态。Activity Board、Tasks、`manifest.json` 都是运行记录生成的视图。

### 三个工作流引擎

| 入口 | 策略 | 用它做什么 |
|---|---|---|
| `/coding <plan\|build\|verify\|full> [--lang auto\|zh\|en] <goal>` | 确定性编码工作流预设，隐藏实现 Agent + 显式 WorkflowDataContract V1 绑定 | 可复现的规划、经批准的实现、验证，或完整 plan→verify 生命周期 |
| `/workflow run [--lang auto\|zh\|en] <goal>` | 通用动态工作流，Supervisor 可混合研究、本地检查、实现、写作、复核节点 | 灵活的多步工作，最终交付与门禁取决于问题本身 |
| `/deep-research [--lang auto\|zh\|en] <question>` | Deep Research 策略，等同 `/workflow run --mode deep-research`，带持久化研究简报、经批准的详细大纲、源溯源研究线、并行 Section Writer、Lead Editor、独立 Reviewer | 需要深度、结构、引用与冲突消解作为发布门禁的长篇研究报告 |

---

## 直接命令

| 命令 | 说明 |
|---|---|
| `/run <agent> [task]` | 运行单个 Agent；省略任务用于自包含 Agent |
| `/chain agent1 "任务1" -> agent2 "任务2"` | 顺序运行多个 Agent |
| `/chain scout "扫描" -> (reviewer "A" \| reviewer "B") -> writer "修复"` | 带静态并行组的 chain |
| `/parallel agent1 "任务1" -> agent2 "任务2"` | 并行运行多个 Agent |
| `/run-chain <chainName> -- <task>` | 启动保存的 `.chain.md` 或 `.chain.json` 工作流 |
| `/composition [list\|show\|save\|run] ...` | 列出、查看、保存或重放保存的工作流节点图 |
| `/subagent-cost` | 显示本会话父 + 子 Agent 的 token 用量与成本 |

---

## 使用建议

先从自然语言委派开始（零配置）→ 重复的形状用 saved chain → 有依赖和验收 gate 的长任务再用 supervisor workflow。

判断是否该用它：任务会长到主上下文爆吗？流程有需要固化、恢复的依赖和验收标准吗？会重复用同一套角色编排吗？只要有一个「是」，它就值得。

---

*许可证：MIT。衍生自 `nicobailon/pi-subagents`，保留其许可证与变更历史。完整英文文档见 [README.md](./README.md)。*
