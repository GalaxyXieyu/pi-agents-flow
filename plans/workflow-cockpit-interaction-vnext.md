# Pi Swarm Workflow Cockpit 交互设计评审稿

> 状态：待用户 Review
>
> 范围：下一轮 pi-swarm 的交互入口、看板、视图切换、快捷键和页面间状态同步。
>
> 本文只定义交互和产品行为，不实现代码，不决定最终视觉主题。

---

## 1. 核心结论

Pi Swarm 的主交互不应该是让用户在输入框里记忆和输入大量 slash 命令。

Slash 命令应当保留，但定位为：

- 高级用户的快捷入口；
- 无 TUI 或远程终端场景的兜底入口；
- 调试和自动化入口；
- 文档、脚本和测试中可复现的操作接口。

普通用户的主路径应该是：

```text
打开 Workflow Cockpit
  -> 选择一个 Workflow
  -> 选择一个任务、节点或 Agent
  -> 按 Enter 进入详情
  -> 使用上下文相关快捷键执行操作
  -> Esc 返回上一级
```

建议的产品心智模型是：

```text
Cockpit = 工作台
Board   = 工作状态
Fleet   = Agent 执行现场
Detail  = 当前对象的完整上下文
Command = 隐藏在快捷键和按钮后的结构化动作
```

用户不需要知道 `workflow.evaluate`、`node.accepted`、`node.cancelled` 等内部概念，但系统必须把这些动作映射成清晰、可确认、可追溯的交互。

---

## 2. 交互原则

### 2.1 看板优先，命令兜底

用户首先看到的是可选择的状态，而不是命令列表。

推荐：

```text
按 Enter 查看
按 p 暂停
按 r 恢复
按 a 接受
按 x 取消
```

不推荐：

```text
请输入 /workflow accept <runId> <nodeId> ...
```

### 2.2 所有页面都是同一份状态的投影

Workflow Store 是事实源。Cockpit、Board、Fleet、Attention、Evidence 和 Budget 都从统一的 durable snapshot 投影出来。

```text
Workflow Store
      │
      ├── Overview projection
      ├── Board projection
      ├── Fleet projection
      ├── Attention projection
      ├── Evidence projection
      └── Budget projection
```

页面不能直接修改 `manifest.json` 或 `events.jsonl`，也不能把自己的本地状态当成 Workflow 状态。

### 2.3 快捷键必须上下文相关

同一个按键在不同页面可以有不同含义，但在同一个页面内不能漂移。

例如：

- `Enter` 永远表示进入当前选中项或确认当前操作；
- `Esc` 永远表示返回或取消；
- `q` 永远表示退出当前面板；
- `j/k` 或方向键永远用于移动选择；
- 危险操作不能和普通查看操作共用按键。

### 2.4 不可执行的动作不显示

底部 hint bar 只显示当前对象真正可执行的动作。

例如：

- 已完成的节点不显示 `p pause`；
- 没有运行中的 Agent 不显示 `s steer`；
- 没有可接受结果时不显示 `a accept`；
- 普通用户没有权限时不显示 destructive action。

当前 `src/tui/keymap.ts` 已经有这个方向：通过 `available(action)` 生成上下文相关 hint。下一轮应把这个原则扩展到整个 Cockpit，而不仅是 Fleet 和旧面板。

---

## 3. 入口设计

## 3.1 主入口：Activity Dock

Pi 主界面保留编辑器和对话区域，同时增加一个可折叠的 Activity Dock。

建议入口：

```text
Ctrl+O  打开/聚焦 Activity Dock
```

如果当前有活跃 Workflow，Dock 显示一条紧凑摘要：

```text
Workflow: 修复 issue #123
状态: Running · 2/5 completed · 1 Agent active
下一步: Review node 等待接受
[Enter] 打开 Cockpit
```

如果没有活跃 Workflow，Dock 显示最近 Workflow 和启动入口：

```text
No active workflow
[Enter] Browse workflows   [n] New workflow
```

这里不要求用户输入 slash 命令。

### 3.2 主入口：Cockpit 快捷键

建议新增一个 Cockpit 入口快捷键：

```text
Ctrl+Shift+W  打开 Workflow Cockpit
```

如果宿主键位冲突，应加入 pi-swarm 可配置 keymap，不在代码中硬编码。

也可以保留一个更容易记忆的单键入口，但只在编辑器没有输入焦点时生效：

```text
w  打开 Workflow Cockpit
```

默认建议先使用 `Ctrl+Shift+W`，因为单键 `w` 容易与输入和普通面板操作冲突。

### 3.3 Slash 入口

仍然保留：

```text
/workflow
/workflow run ...
/workflow status
/workflow quality
/workflow pause
/workflow resume
/workflow stop
/swarm
/deep-research
```

但这些命令不再是产品主路径。无参数时应打开原生选择器或 Cockpit，而不是打印一大段帮助：

```text
/workflow       -> 打开 Cockpit
/swarm          -> 打开新 Workflow 启动向导
/deep-research  -> 打开 Deep Research 启动向导
```

带参数时保留命令式行为，方便自动化和高级用户。

---

## 4. Cockpit 总体布局

Cockpit 是一个独立的全屏 TUI 页面，默认分成三块：

```text
┌─────────────────────────────────────────────────────────────┐
│ Pi Swarm Cockpit                                            │
│ Workflow: 修复 issue #123   Running   revision 42           │
├───────────────────────┬─────────────────────────────────────┤
│ 左侧：导航/对象列表    │ 右侧：当前对象详情                   │
│                       │                                     │
│ Overview              │ 当前状态                             │
│ Board                 │ 当前 Agent / Node / Gate             │
│ Agents                │ 最近输出                             │
│ Attention             │ Evidence / Budget / Attempts         │
│ Evidence              │                                     │
│ Budget                │                                     │
├───────────────────────┴─────────────────────────────────────┤
│ ↑↓ select · Enter open · Tab pane · Esc back · ? help · q close │
└─────────────────────────────────────────────────────────────┘
```

窄终端下切换为上下堆叠：

```text
┌─────────────────────────────┐
│ 当前列表                     │
├─────────────────────────────┤
│ 当前详情                     │
├─────────────────────────────┤
│ 快捷键提示                   │
└─────────────────────────────┘
```

不建议第一版加入任意拖拽。拖拽会把复杂的状态转换隐藏在视觉动作后面，容易绕过依赖、gate 和 lease 规则。

---

## 5. Cockpit 的一级视图

一级视图使用 Tab 或数字键切换。每个视图仍然消费同一个 Workflow snapshot。

```text
1 Overview
2 Board
3 Agents
4 Attention
5 Evidence
6 Budget
```

建议默认进入 `Overview`，如果用户从 Activity Dock 进入且有当前运行节点，则进入该节点对应的 `Board` 或 `Agents` 详情。

## 5.1 Overview

回答五个问题：

1. 当前目标是什么？
2. Workflow 处于什么状态？
3. 当前下一步是什么？
4. 是否需要用户判断？
5. 最近一次有效进展是什么？

示例：

```text
Goal
  修复 issue #123，并通过 parser 与 regression tests

State
  Running · revision 42 · 3 accepted / 1 running / 1 waiting

Next action
  Review node review-parser 等待接受

Attention
  需要确认：是否允许更新公开 PR 描述

Recent progress
  verification-parser accepted
  artifact: test-report.json
```

可执行操作：

```text
Enter 进入当前推荐动作
p     暂停 Workflow
r     恢复 Workflow
?     查看帮助
```

## 5.2 Board

Board 是用户最常用的工作视图。

建议泳道：

```text
PLANNED | READY | RUNNING | WAITING | REVIEW | BLOCKED | DONE
```

卡片只显示必要信息：

```text
┌─────────────────────────────┐
│ review-parser                │
│ REVIEW · waiting acceptance  │
│ Agent: reviewer              │
│ Attempt: 1 · 2m             │
│ Evidence: 3 receipts         │
│ [Enter] inspect              │
└─────────────────────────────┘
```

Board 交互：

- `j/k` 或方向键：移动卡片选择；
- `h/l` 或左右方向键：切换泳道；
- `Enter`：进入当前卡片详情；
- `Tab`：在 Board 列表和详情间切换焦点；
- `g/G`：跳到第一个/最后一个卡片；
- `f`：筛选当前状态；
- `r`：重新读取 durable state；
- `Esc`：返回上一级。

卡片不直接通过拖动改变状态。用户必须在详情页按明确动作键。

## 5.3 Agents

Agents 视图对应执行现场，而不是任务事实源。

显示：

```text
Agent          Node              State      Tool / output
worker         implement-parser  running    bash · npm test
reviewer       review-parser     waiting    waiting for acceptance
researcher     docs-search       completed  4 receipts
```

交互：

- `Enter`：打开 Agent Inspector；
- `s`：Steer，向运行中的 Agent 发送指导；
- `D`：停止 Agent；
- `f`：跟随实时输出；
- `x`：展开工具和输出详情；
- `o`：打开关联 artifact；
- `r`：刷新。

`D` 必须使用大写或显式组合键，避免和普通查看或展开操作混淆。停止操作必须弹确认框。

## 5.4 Attention

Attention 是控制面最重要的视图，聚合需要用户或 Supervisor 处理的事项。

项目包括：

```text
[USER GATE] 允许更新公开 PR 描述
[REVIEW]    review-parser 等待接受或拒绝
[BUDGET]    workflow 已使用 82% 预算
[LEASE]     implement-parser 的 lease 即将过期
[REPAIR]    上一次 child 返回了无效结构化结果
[STALL]     连续两轮没有 material progress
```

交互：

- `Enter`：打开 Attention 详情并进入推荐处理动作；
- `a`：接受当前推荐结果；
- `x`：拒绝/取消当前对象，具体文案由上下文决定；
- `p`：暂停相关 Workflow；
- `r`：重新计划或重试，必须经过二级确认；
- `d`：延后当前 Attention；
- `Esc`：返回。

每条 Attention 必须说明：

```text
发生了什么
为什么需要处理
不处理会怎样
建议动作是什么
执行后会修改哪些状态
```

禁止只显示“需要关注”“等待 owner”这类不可操作文案。

## 5.5 Evidence

Evidence 视图显示经过运行时记录的 receipt 和 artifact：

```text
Receipt                     Kind                  Source
receipt-123                 validation_passed     npm test
receipt-124                 artifact_written      test-report.json
receipt-125                 source_fetched        github.com/...
```

交互：

- `Enter`：打开 receipt/artifact 详情；
- `o`：打开 artifact 的只读预览；
- `c`：查看关联 claim；
- `a`：接受当前 claim；
- `x`：拒绝当前 claim；
- `j/k`：上下移动；
- `Esc`：返回。

Evidence 页面默认不显示完整原始 transcript。完整输出继续通过 Agent Inspector 查看，避免 Cockpit 被大段日志淹没。

## 5.6 Budget

Budget 视图显示预算账本，而不是单个 Agent 的 token 信息：

```text
Workflow budget
  Tokens       61% consumed · 12% reserved
  Cost         48% consumed
  Attempts     7 / 20
  Repair waves 1 / 3
  No progress  1 consecutive turn
```

交互：

- `Enter`：打开预算明细；
- `f`：按 node/agent/model 筛选；
- `r`：刷新；
- `Esc`：返回。

预算操作默认只读。增加预算、允许继续消耗或解除停止条件必须进入确认流程，不通过普通快捷键静默完成。

---

## 6. 详情页设计

按 Enter 进入详情，而不是跳回输入框。

## 6.1 Node Detail

```text
Node: review-parser
Status: waiting for acceptance
Task: Review implementation and tests
Agent: reviewer
Attempt: 1
Depends on: implement-parser, verification-parser
Lease: none

Summary
  ...

Findings
  ...

Evidence
  3 receipts · 1 artifact

Available actions
  [a] Accept   [x] Reject   [o] Artifact   [v] Attempts   [Esc] Back
```

动作含义：

- `a` 接受结果；
- `x` 拒绝结果；
- `o` 打开 artifact；
- `v` 查看 attempt 历史；
- `r` 请求有限 repair/retry；
- `Esc` 返回。

接受和拒绝都必须要求简短理由。理由可以使用 Pi 的小型编辑器，而不是让用户输入结构化命令。

## 6.2 Agent Inspector

Agent Inspector 复用当前 Fleet 的能力：

```text
Agent: reviewer
Node: review-parser
State: running
Current tool: npm test
Recent tools:
  rg parser
  npm test
Recent output:
  12 tests passed
```

操作：

- `s`：打开 steer 编辑器；
- `D`：确认后停止；
- `f`：跟随实时输出；
- `x`：切换工具详情；
- `r`：刷新；
- `Esc`：返回 Agents 视图。

Steer 不是直接发送一个隐藏字符串。按 `s` 后打开一个小型编辑器，用户输入自然语言指导，Enter 发送，Esc 取消。

## 6.3 Gate Detail

```text
User decision required

Question
  是否允许更新公开 PR 描述？

Scope
  public_claim · action · pr_description

Affected work
  publish-pr-description

If approved
  only this scope is unblocked

[Enter] Answer   [d] Defer   [Esc] Back
```

按 Enter 后打开选择器：

```text
Approve
Reject
Approve once
Approve for this workflow
Cancel
```

不能把“批准一次”和“长期批准”做成同一个按钮。两者必须有清晰的作用域和过期语义。

## 6.4 Workflow Detail

Workflow 详情页支持：

```text
p  Pause
r  Resume
D  Stop
v  Quality
b  Board
f  Agents
h  History
Esc Back
```

停止 Workflow 必须经过确认，并显示：

- 将停止哪些节点；
- 是否会取消运行中的 child；
- 是否保留 artifacts 和 attempts；
- 是否允许之后通过 repair plan 恢复。

---

## 7. 推荐快捷键总表

### 全局 Cockpit

| 快捷键 | 动作 |
|---|---|
| `Ctrl+Shift+W` | 打开/聚焦 Workflow Cockpit |
| `1` | Overview |
| `2` | Board |
| `3` | Agents |
| `4` | Attention |
| `5` | Evidence |
| `6` | Budget |
| `j/k`、`↑/↓` | 移动选择 |
| `Enter` | 进入/确认 |
| `Tab` | 切换列表与详情焦点 |
| `r` | 刷新 durable state |
| `?` | 打开当前页面帮助 |
| `Esc` | 返回上一级/关闭弹窗 |
| `q` | 关闭 Cockpit |

### Board

| 快捷键 | 动作 |
|---|---|
| `h/l`、`←/→` | 切换泳道 |
| `Enter` | 打开节点详情 |
| `f` | 筛选状态/泳道 |
| `g/G` | 首项/末项 |
| `r` | 刷新 |

### Node / Review

| 快捷键 | 动作 |
|---|---|
| `a` | 接受结果 |
| `x` | 拒绝结果或打开取消动作 |
| `r` | 请求 repair/retry |
| `o` | 打开 artifact |
| `v` | 查看 attempt 历史 |

### Agent

| 快捷键 | 动作 |
|---|---|
| `s` | Steer |
| `D` | 停止 Agent |
| `f` | 跟随输出 |
| `x` | 展开工具详情 |
| `o` | 打开 artifact |

### Workflow

| 快捷键 | 动作 |
|---|---|
| `p` | 暂停 |
| `r` | 恢复 |
| `D` | 停止 Workflow |
| `v` | Quality |
| `b` | Board |
| `f` | Agents |
| `h` | History |

### 冲突和优先级

- `q` 统一关闭当前面板；
- `Esc` 优先取消弹窗，其次返回上一级；
- `Enter` 在选择态进入详情，在确认态提交；
- `D` 只用于 destructive stop，并且必须二次确认；
- `x` 在 Node 详情中表示 reject，在 Agent 面板中表示展开工具，在 Workflow Board 中表示打开上下文动作，必须由底部 hint bar 明确显示；
- 如果同一个页面同时存在多个含义，应该改键，而不是依赖用户猜测。

当前 `src/tui/keymap.ts` 已统一了 `q`、`x`、`D`、`j/k`、`Tab`、`Enter`、`Esc` 等基础行为。下一轮应继续扩展 action 类型和可用性判断，而不是在各个组件里重新写 `data === "x"` 之类的硬编码。

---

## 8. 操作确认原则

### 不需要确认

- 打开详情；
- 切换视图；
- 刷新；
- 查看 artifact；
- 查看 attempt；
- 跟随输出；
- 进入 Cockpit。

### 需要轻量确认

- 接受或拒绝 Agent 结果；
- 发送 steer；
- 请求 retry/repair；
- 回答普通 user gate。

轻量确认可以是小型输入框、选择器或要求填写一句理由。

### 必须确认

- 停止 Agent；
- 停止整个 Workflow；
- 允许 protected write；
- 增加 Workflow 预算；
- 解除 hard stop；
- 将结果发布到外部系统；
- 重新绑定 goal 或扩大 scope。

确认内容必须写清楚影响范围，不能只显示：

```text
Are you sure?
```

应该显示：

```text
Stop workflow "修复 issue #123"?
This will cancel 2 running agents and leave 3 completed artifacts preserved.
The workflow can only resume through an explicit repair plan.
```

---

## 9. 多页面和多窗口交互

### 9.1 同一 Pi 进程

同一 Pi 进程内的多个视图通过同一个 Activity snapshot 和事件通知刷新：

```text
Workflow Store
  -> Controller state change
  -> pi.events
  -> Cockpit / Board / Fleet / Attention refresh
```

用户在 Board 接受一个节点后：

- Board 更新节点状态；
- Overview 更新下一动作；
- Attention 移除对应 review；
- Budget 更新一次 accepted transition；
- Fleet 保留 child 的执行历史。

### 9.2 多个 Pi 窗口或外部页面

多窗口场景必须使用：

```text
snapshot + revision + command id + event sequence
```

页面只提交结构化 command，不直接写状态：

```ts
{
  commandId,
  workflowId,
  expectedRevision,
  action: "accept_result",
  payload: { nodeId, rationale }
}
```

如果两个窗口同时操作同一个节点：

```text
窗口 A revision 25 -> 成功 -> revision 26
窗口 B revision 25 -> Revision Conflict -> 自动刷新
```

窗口 B 显示：

```text
This result was already handled in another window.
```

用户不应该看到 JSON 错误、事件 ID 或内部 revision 细节，除非打开诊断模式。

---

## 10. 页面之间的跳转关系

推荐统一使用“打开对象”而不是“打开命令”：

```text
Overview
  ├─ Enter on next action -> Node Detail / Gate Detail
  ├─ b -> Board
  ├─ f -> Agents
  └─ Esc -> Activity Dock

Board
  ├─ Enter -> Node Detail
  ├─ Tab -> Detail pane
  ├─ f -> filter
  └─ Esc -> Overview

Node Detail
  ├─ Enter on Agent -> Agent Inspector
  ├─ o -> Evidence / Artifact
  ├─ v -> Attempt History
  └─ Esc -> Board

Agent Inspector
  ├─ s -> Steer editor
  ├─ D -> Stop confirmation
  ├─ o -> Artifact
  └─ Esc -> Agents

Attention
  ├─ Enter -> recommended action
  ├─ d -> defer
  └─ Esc -> Overview
```

任何页面都不应该把用户弹回输入框，让用户重新输入一串命令才能继续当前操作。

---

## 11. Slash 命令的最终定位

### 日常用户

```text
Ctrl+Shift+W
Enter
j/k
Enter
按上下文快捷键
Esc 返回
```

### 高级用户

```text
/workflow status
/workflow pause
/workflow quality
```

### 自动化和调试

```text
workflow({ action: "status" })
workflow({ action: "accept", ... })
subagent({ action: "status" })
```

### 无 TUI 环境

保留完整 CLI/Slash 路径，确保所有 Cockpit 能力都有文字兜底：

```text
status
board
agents
attention
accept
reject
pause
resume
stop
```

关键要求是：

> UI 快捷键、slash 命令、模型工具调用最终都映射到同一个 Controller command，而不是各自实现一套业务逻辑。

---

## 12. 第一版实现范围建议

第一版不要一次实现所有页面。建议先做最小可用 Cockpit：

### V1 必须有

- `Ctrl+Shift+W` 打开 Cockpit；
- Overview；
- Board；
- Node Detail；
- Agent Inspector；
- `j/k`、方向键、`Enter`、`Tab`、`Esc`、`q`；
- `p` pause、`r` resume、`D` stop；
- `a` accept、`x` reject；
- `s` steer、`f` follow、`o` artifact；
- 上下文相关 hint bar；
- 所有 destructive action 有确认；
- 所有页面复用 Workflow Store 和现有 Fleet projection。

### V1.1

- Attention；
- Evidence；
- Budget；
- Attempt History；
- 多窗口 revision conflict 提示；
- 当前页面帮助弹窗。

### V2

- 外部浏览器 Dashboard；
- loopback Coordinator；
- Local A2A adapter；
- 多 Pi session 的跨进程实时订阅。

---

## 13. 评审问题

请重点 review 以下产品决策：

1. 主入口是否采用 `Ctrl+Shift+W`，还是希望使用更简单的单键入口？
2. 一级视图是否采用 `Overview / Board / Agents / Attention / Evidence / Budget`？
3. `D` 作为停止键、`a` 接受、`x` 拒绝是否符合预期？
4. Board 是否明确不支持第一版拖拽？
5. Overview 是否应该默认进入，还是打开 Cockpit 后直接进入 Board？
6. 普通 Gate 是否按 Enter 进入选择器，还是直接进入小型编辑器？
7. 是否需要在 V1 就加入 Attention，还是先只做 Overview + Board + Agent Inspector？
8. Cockpit 是独立全屏页面，还是应该作为 Activity Dock 的可展开面板？
9. 是否需要保留 `/workflow board` 作为显式命令，还是无参数 `/workflow` 统一打开 Cockpit？

---

## 14. 推荐默认答案

如果没有额外产品约束，本文建议的默认方案是：

```text
主入口：Ctrl+Shift+W
默认页面：Overview
核心工作页：Board
Enter：进入详情
Esc：返回
q：关闭 Cockpit
j/k：选择
Tab：列表/详情焦点
D：停止并确认
p/r：暂停/恢复
V1：Overview + Board + Node Detail + Agent Inspector
V1.1：Attention + Evidence + Budget
V2：浏览器页面和 Local A2A
Slash：保留为高级/兜底入口，不作为主路径
```

这套方案的目标不是增加更多页面，而是让用户始终围绕一个明确对象工作：

```text
我现在选中了什么？
它目前是什么状态？
我按 Enter 会看到什么？
当前有哪些合法动作？
这个动作会影响什么？
```

如果这五个问题在每个页面都能被回答，pi-swarm 的多页面交互就不会退化成“记命令的控制台”。
