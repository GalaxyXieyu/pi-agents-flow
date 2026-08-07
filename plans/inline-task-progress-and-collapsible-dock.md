# 内联任务进度卡片 + 可折叠 Activity Dock 设计方案

状态：已 review 定稿，待实现
作者：设计草案
日期：2026-08

> 全局约定：**禁止使用 emoji**。所有状态/图标一律用单色 Unicode 符号
> （`○ ● ✓ ✔ ✕ ✗ → ★ ☆ ■ □ ◆ ◇ ◎ ◉ ▶ ▲ ▷ ◌ ⊘ ⏸`），
> 走主题配色（绿=完成、红=失败、dim/accent=其余），与 `visual-language.ts` 现有 badge 一致。

---

## 1. 目标

把"正在跑任务"的实时观感做成 **pi 官方工具调用那种内联卡片**（进行中 spinner → 完成变绿 → 失败变红，可展开），但**按「任务(Task)」而不是按「read」组织**。同时把输入框**下方**的 Activity Dock **默认折叠成一行**，按键展开，彻底解决垂直高度占用问题。

一句话分工：

| 面 | 位置 | 生命周期 | 职责 |
|---|---|---|---|
| **A. 内联任务进度卡片** | transcript 内（随对话滚动，永久留档） | 每个 `run_ready` 波次一张 | 按任务展示波次进度：spinner/绿/红，可展开看 work unit 明细 |
| **B. 折叠式 Activity Dock** | 输入框下方常驻 | 常驻，默认 1 行 | 折叠态=一行摘要；`↓`/`Tab` 展开成完整任务树；`Esc` 收起 |

理由：细节由上方 transcript 内联卡片承担，所以下方 Dock 不需要一直占 4~6 行，压成一行即可。

---

## 2. 现状（调研结论）

### 2.1 workflow 工具当前是"哑渲染"
`src/workflows/tool.ts` 的 `registerWorkflowTool`：
- `renderCall()` → 返回空 `Text("")`
- `renderResult()` → 非展开态返回空 `Text("")`（注释写明"状态交给下方 cockpit/dock 表达"）
- `execute()` 拿到了 `onUpdate` 参数但**当前忽略**（`_onUpdate`）

也就是说：**内联位置现在是空的，正好用来放任务进度卡片，不与现有 UI 冲突。**

### 2.2 `run_ready` 天然是"长时间进行中"的调用（关键）
`src/workflows/controller.ts:793`：
```ts
next = await scheduler.runReady(run.id, { ... });
```
`run_ready` **会 await 整个波次直到节点 settle**，期间：
```ts
onTransition: (transitioned) => { persistBinding(transitioned); projectRun(ctx, transitioned, ...); }
```
每次节点状态变化都会刷新投影。这意味着 workflow 工具调用**本身就是一个长驻的 in-progress 调用**——正好匹配"官方 subagent 卡片：进行中→绿/红定格"的模型。其它动作（`apply_plan`/`accept`/`reject`/`complete`）是瞬时调用。

### 2.3 官方 subagent 内联卡片已经很成熟（视觉语言可复用）
`src/tui/render.ts:renderSubagentResult`：单个/并行/链、`compact`/`expanded`、spinner `frame`、进度 label（`step x/total`、`done/size`）齐全。我们的任务卡片**复用同一套视觉语言**（spinner 帧、绿 `●`/红 `✕`/进行中 `◐`、`ctrl+o` 展开），保证和原生工具一致。

### 2.4 数据源已就绪
`src/activity/projection.ts:buildActivitySnapshot(state, run)` 已经产出 `TaskActivity` 树（Task > WorkUnit > Execution，含 state/duration/usage/recent）。内联卡片和 Dock **共用这份快照**，不新造数据模型。

### 2.5 Dock 现状
`src/tui/activity-dock.ts:renderActivityDock`：无论 `active` 与否都渲染「header + 4~6 行」。折叠只需改成：`!active` 时只渲染 1 行摘要。交互键已在 `handleKey` 内（`↓` 激活、`v` 切视图、`x` 展开、`Enter` 进 Fleet、`Esc` 退出）。

---

## 3. Surface A：内联任务进度卡片

### 3.1 触发与驱动
- 仅对 `workflow` 工具的 **`run_ready`** 动作渲染完整卡片；其它动作维持空渲染（避免刷屏）。
- **进行中驱动**：`execute()` 启用 `onUpdate`。把 scheduler 的 `onTransition` 桥接到 `onUpdate`，每次节点 transition 推送一份"波次快照"作为 partial details；`renderResult(result, {isPartial}, ...)` 据此绘制。这样无需自建动画定时器读全局快照，符合官方工具的 `isPartial` 流式模型。
- spinner 帧：复用宿主给工具结果的动画帧机制（与 `renderSubagentResult` 的 `frame` 同源）。

### 3.2 卡片内容：按任务分组
数据来自本波次涉及的 Task/WorkUnit（从 `details.run` + 投影构造）。分组层级：**Task → WorkUnit（其当前 read 执行的活动/步骤）**。不以 read 为一级。

状态符号（与 `visual-language.ts` 一致）：`◐` 进行中(带 spinner) · `●` 完成/已接受(绿) · `✕` 失败(红) · `◌` 等待 · `○` 未开始 · `⊘` 取消/被替代。

### 3.3 TUI 样子

**进行中（折叠态，默认）：**
```
▸ workflow run_ready · 研究阶段 ─────────────────── 00:42 · 12k tok
  ◐ 任务: 证据采集              2/3
    ● researcher · 完成                              18s
    ◐ researcher · grep "verifyToken"               00:22
    ◌ verifier   · 等待依赖
  ○ 任务: 汇总与初稿            0/2
                                          ctrl+o 展开 · 3 running
```

**全部完成（绿，定格留档）：**
```
▸ workflow run_ready · 研究阶段 ✔ ──────────────── 01:10 · 21k tok
  ● 任务: 证据采集              3/3   完成
  ● 任务: 汇总与初稿            2/2   完成
                                              ctrl+o 展开明细
```

**有失败（红）：**
```
▸ workflow run_ready · 研究阶段 ✕ ──────────────── 00:55 · 9k tok
  ● 任务: 证据采集              2/3
    ✕ verifier · 超时 (timeout 600s)   ← 显示 error 首行
  ○ 任务: 汇总与初稿            0/2   被阻塞
                                     ctrl+o 看完整 transcript
```

**展开态（`ctrl+o`）**：在每个 WorkUnit 下追加最近 N 行（默认 8）活动尾巴（复用 `recent`/`streamTail`），并把失败节点的完整错误显示出来。行数超上限 → `… +N`。展开态受宿主 `app.tools.expand` 切换控制（和其它工具一致）。

### 3.4 标题里的"当前步骤"
标题右侧的阶段名取自 Task label（如"研究阶段/汇总"），或 workflow 的 phase；WorkUnit 行右侧/后缀显示"当前工具+精简参数"（复用 projection 已有的 `activity`/`current`）。

### 3.5 `complete` 交付完成卡（方案 B，已定）

工作流最后一次 `complete` 额外渲染一张结构化「交付完成」绿卡，永久留档；成品路径/质量分/引用覆盖率/任务计数聚合到一处，`ctrl+o` 展开质量报告明细。全部用单色 Unicode 符号，无 emoji：

```
▸ workflow  ✔ 交付完成 ───────────────────────── 总耗时 08:32 · 156k tok
  ●  成品     delivery/final.md   (3,240 字 · 18 段)
  ✔  质量分   92/100 · release-ready
  ◆  引用     37 处 · 覆盖率 96%
  ■  任务     6/6 完成 · 0 失败
                                              ctrl+o 看质量报告
```

### 3.6 独立 subagent 调用不变

非 workflow 的 `subagent` 调用**保持现有官方渲染**（`renderSubagentResult`）。"按任务"只适用于 workflow（有 Task 结构）；并行 subagent 无 Task 概念，维持"按 read/step"原样。

---

## 4. Surface B：折叠式 Activity Dock

### 4.1 行为
- **折叠态（默认，1 行）**：只显示一行聚合摘要 + 展开提示。
- **`↓`（编辑器为空时）或 `Tab`**：展开为现有完整任务树（Task/WorkUnit 行、`v` 切 Tasks/reads、`x` 展开活动、`Enter` 进 Fleet）。
- **`Esc`**：收回折叠态。
- 无任何运行/无 workflow 时：整体隐藏（现状已如此）。

### 4.2 TUI 样子

**折叠态（默认）：**
```
◐ 工作流 · 3 运行 · 1 完成 · 0 失败              ↓ 展开
```
无 workflow、仅独立 read 时：
```
◐ 2 个 read 运行中 · 1 完成                      ↓ 展开
```

**展开态（现有样子，不变）：**
```
[任务]  reads                          v 视图 · ↑↓/jk · x · 回车 · Esc
◐ 证据采集                                            2/3 · 21s · 12k tok
    ● researcher · 完成                                    18s · 6k tok
    ◐ researcher · grep verifyToken                        00:22
○ 汇总与初稿                                          0/2
                                                          … +2
```

### 4.3 与内联卡片的关系
折叠 Dock 只做"全局一眼摘要 + 入口"；细节和历史看上方 transcript 内联卡片，或展开 Dock/进 Fleet。两者共用 `buildActivitySnapshot`，不重复实现。

---

## 5. 代码改动点（最小新增，复用为主）

| 文件 | 改动 |
|---|---|
| `src/workflows/tool.ts` | 给 `workflow` 工具实现 `renderResult` 的 `run_ready` 分支（按任务卡片）；`execute` 启用 `onUpdate`，把波次进度作为 partial 推送。其它动作维持空渲染。 |
| `src/tui/`（新增 `workflow-inline-card.ts`） | 内联卡片渲染器：输入=波次快照(Task/WorkUnit/state/usage)，输出=紧凑/展开两态；复用 `visual-language.ts` 的 badge/spinner 与 `render-helpers.ts`。 |
| `src/workflows/controller.ts` | `run_ready` 的 `onTransition` 额外回调一个 `onProgress`，把快照喂给工具 `onUpdate`（桥接层）。 |
| `src/activity/projection.ts` | 可选：新增 `streamTail`（上限可配，默认 8），供内联卡片展开态与 Dock 复用；不动现有 `recent`。 |
| `src/tui/activity-dock.ts` | `renderActivityDock`：`!active` 时只渲染 1 行摘要（聚合运行/完成/失败计数 + `↓ 展开`）；`active` 时维持现状。新增 `Tab` 作为展开别名。 |
| `src/tui/keymap.ts` | 复用 `expandTools: ["x","ctrl+o"]` 作为内联卡片展开键；Dock 展开用 `↓`/`tab`，收起 `escape`（已存在，补 tab）。 |

---

## 6. 已考虑的边界与坑

1. **高度**：内联卡片折叠态 ≤ ~8 行，展开才更多；Dock 默认 1 行。矮终端下内联卡片再降级（每任务 1 行、隐藏尾巴）。
2. **闪烁/重绘**：`onUpdate` 按 transition 触发（非高频定时全绘）；行内容做 diff，全部走 `truncateToWidth`/`visibleWidth`（中文宽字符/ANSI 安全）。
3. **多波次**：一次 workflow 有多次 `run_ready`，每次一张卡片，历史里能看到"研究阶段""写作阶段"等分段留档——这是特性不是 bug。
4. **瞬时动作**：`accept`/`reject`/`apply_plan`/`complete` 维持空渲染，避免每次转移都刷一张卡。（可选：`complete` 输出一张"最终交付"绿卡，待定，见开放问题。）
5. **失败可达性**：红态显示 `error` 首行，`ctrl+o` 展开看完整错误，或提示进 Fleet 看完整 transcript。
6. **headless / 无 TUI**：`ctx.hasUI` 为假时内联渲染退化为纯文本摘要；Dock 本就 no-op。
7. **并行/嵌套 fanout**：WorkUnit 行有硬上限 + `… +N`；嵌套子 read 不在内联卡片一级展开，进 Fleet 看。
8. **焦点/输入抢占**：Dock 键仅在 `editorHasFocus()` 且编辑器为空时生效（沿用现有 `handleKey` 守卫）；不吞正常输入。
9. **取消/停止**：`/workflow stop` 或 `cancel_node` 后，进行中卡片应收敛到 `⊘` 而非一直转。

---

## 7. 配置项（新增，均可选，带默认）

```jsonc
{
  "subagents": {
    "workflowInlineCard": {
      "enabled": true,          // 关掉则回到当前空渲染
      "maxTailLines": 8,        // 展开态每 work unit 尾巴行数
      "settledStyle": "green-red" // 完成/失败配色
    },
    "activityDock": {
      "collapsedByDefault": true, // 默认折叠成一行
      "expandKey": "tab"          // 展开别名键
    }
  }
}
```

---

## 8. 开放问题（已全部定稿）

1. 内联卡片展开键 → **`ctrl+o`**（与官方工具一致）。✅
2. `complete` → **方案 B：输出一张“交付完成”绿卡**（见 3.5），**无 emoji，单色 Unicode 符号**。✅
3. Dock 展开键 → `↓`（编辑器空时）**加 `Tab` 别名**。✅
4. 完成后的内联卡片（含交付卡）**永久留在 transcript**。✅
5. 折叠摘要/卡片文案随 `snapshot.language` **中/英自动切换**。✅
6. 全局：**禁用 emoji**，统一用单色 Unicode 符号（见顶部约定）。✅

---

## 9. 实施阶段（review 通过后）

- **P0**：Dock 折叠成 1 行 + `Tab`/`↓` 展开、`Esc` 收起（改动小、先验证高度体验）。
- **P1**：workflow 工具 `run_ready` 内联任务卡片（进行中/绿/红 + 折叠态），`onUpdate` 桥接。
- **P2**：内联卡片展开态（尾巴 N 行 + 失败详情）、`streamTail`、配置项、headless 降级。
- 每阶段配单测（渲染快照 + 折叠/展开状态机 + 宽字符截断）。
