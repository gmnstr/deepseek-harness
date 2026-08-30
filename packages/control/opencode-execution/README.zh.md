---
description: "面向 DeepSeek Harness 会话日志的派生投影执行运行时：将权威 DSH 日志（原生 + 控制事件）折叠为执行／活动／权限／效果的读模型，并通过带栅栏的 DSH 持久化以权威方式写入控制事实，供编排执行运行时或调试效果权限的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-opencode-execution

[English](README.md) | 中文

## 摘要

`dsh-opencode-execution` 是取代旧 `ExecutionLedger` 权威的派生投影运行时。它将一个 DSH 会话视为代理执行状态的唯一权威来源：运行时通过 `ctx.sessionPersistence.appendFenced` 使用 A1 控制事件工厂，将控制事实以权威方式写入真实的 DSH 持久化，并将权威 DSH 日志（原生 + 控制事件）折叠为派生读模型——执行、活动、权限与效果。每个派生写入都仅由 DSH 事件派生，绝不来自执行器或参与者的内存。此包不拥有任何独立的权威写入 API。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

当控制面（自动化循环、钩子桥、代理命令运行器）必须运行串行化的执行生命周期，并且其持久事实位于 DSH 会话日志（已经承载模型转录的同一日志）中、具备真实的陈旧写入方栅栏时，请使用此包。

### 它增加了什么

- **`ExecutionRuntime`** —— 串行化会话参与者。`beginExecution`、`correlateActivity`、`requestEffect` / `authorizeEffect` / `denyEffect` / `startAttempt` / `succeedEffect` / `failEffect` / `commitUnknown` / `reconcileEffect` 各自通过 `appendFenced` 追加对应的 A1 控制事件。`migrateOwnership(from, to, worker)` 以原子 CAS（`advanceOwnershipEpoch`）推进持久的所有权纪元，绝不追加 `OwnershipMigrated` 事件——栅栏是持久化元数据，不是事件。
- **`EffectExecutor`** —— 在真实 DSH 底座上的内核门控效果安全：结构验证 → 类型化能力授权 → 权威 `effect/requested` + `effect/authorized`／`effect/denied` → 派生 outbox 工作视图 → 带重试的作用域 worker（每次重试追加一个不同的 `effect/attempt-started`）→ 权威结果。`commit-unknown` 打破循环（绝不盲目重试 IRREVERSIBLE）；专用的 `reconcile()` 仅解决 `commit-unknown` 动作，使用独立的 `${action_id}:reconcile:1` 尝试 id 并传递 `reconcile: true`。
- **`foldProjection`** —— 纯确定性折叠：相同的 DSH 事件总是产生相同的 `DerivedSessionState`，其 sha256 摘要会在任何事件的类型、序号或数据变化时改变。派生状态只是 DSH 日志的函数。
- **`CapabilityKernel`** —— 类型化权限边界：带正向、作用域的、带外铸造的能力；缺失即拒绝；文本永远不能授予权限。

### 构造运行时

```ts
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionPersistenceSqlite from '@deepseek-ai/dsh-session-persistence-sqlite'
import { ExecutionId } from '@deepseek-ai/dsh-opencode-control'
import { ExecutionRuntime } from '@deepseek-ai/dsh-opencode-execution'

const ctx = new Context()
await ctx.plugin(SessionStore)
await ctx.plugin(SessionPersistenceSqlite, { path: '/tmp/sessions.db' })
const sessionId = SessionId('run-1')
await ctx.sessionPersistence.create({ version: 0, id: sessionId, createdAt: Date.now(), cwd: '/workspace' })

const runtime = new ExecutionRuntime({
  persistence: ctx.sessionPersistence as InstanceType<typeof SessionPersistenceSqlite>,
  session_id: sessionId,
  writer: { worker_id: `worker-${process.pid}`, ownership_epoch: 0 },
})
await runtime.beginExecution(ExecutionId('exec-1'), 'git status', 'surface')
```

运行时只通过 `appendFenced` 写入；纪元不再匹配已存会话的写入方会在任何事件行提交前被拒绝（`SessionOwnershipFencedError`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

可观察的契约在[使用此包](#use-this-package)中说明；本节解释权威写入路径、派生折叠与被降级的账本如何协作。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/types.ts`](src/types.ts) | 仅类型的派生读模型（`DerivedSessionState`、`DerivedExecution`、`DerivedActivity`、`DerivedAuthority`、`DerivedEffect`、`DerivedEffectOutcome`、`ProjectionWriter`） |
| [`src/projection.ts`](src/projection.ts) | 纯确定性折叠（`foldProjection`），带权威事实上的 sha256 摘要 |
| [`src/ledger-deriver.ts`](src/ledger-deriver.ts) | `readFromDsh` / `deriveAll` —— 被降级写入路径的审计面 |
| [`src/capability.ts`](src/capability.ts) | 类型化 `CapabilityKernel`：正向权限，缺失即拒绝，文本永不授予权限 |
| [`src/execution-runtime.ts`](src/execution-runtime.ts) | 串行化会话参与者；唯一的权威写入入口（`appendControl` → `appendFenced`） |
| [`src/effect-executor.ts`](src/effect-executor.ts) | 内核门控的效果调度、重试、`commit-unknown` → `reconcile()`、`ERR_EFFECT_REENTRY` 守卫 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生：没有可观察的进程内关系（投影与运行时测试负责这些检查） |
| [`A3-MUTATION-AUDIT.md`](A3-MUTATION-AUDIT.md) | 旧 `ExecutionLedger` 的每个变更入口 → 其 DSH 权威对应物与处置 |

### 为什么投影不是第二权威

旧原型的 `ExecutionLedger` 声称是"控制平面事实的权威持久家园"——正是主理人指出的矛盾。在此包中，权威控制事实存在于 DSH 会话日志；`foldProjection` 仅从该日志派生读模型。折叠从不写入，运行时也绝不从内存持久化派生状态。崩溃后，新运行时加载已持久化的 DSH 日志并重建投影；删除重建独立性证明位于 `tests/projection.spec.ts`。

### 栅栏与迁移

运行时从会话的持久纪元（`ownershipEpochOf`）加上自己的 worker id 获得写入令牌。`appendFenced` 携带 A2 的事务内纪元断言：陈旧写入方会在任何事件行提交前被拒绝。`migrateOwnership` 使用 `advanceOwnershipEpoch` CAS——存储的原子 `UPDATE ... WHERE ownership_epoch = ?`——因此两个竞争认领会话的进程不可能同时获胜。迁移事实刻意不记录为事件。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读以下页面。

- [会话持久化事件目录](../../../docs/persistence-catalog.zh.md) —— 生成的词汇表：每个 `SessionEventMap` 成员及其 payload 与 surface 徽标。
- [持久化子系统](../../../docs/subsystems/persistence.zh.md) —— 日志如何变得可持久化、带栅栏并回放。
- [会话子系统](../../../docs/subsystems/session.zh.md) —— surface 排序、`deriveMessages()` 与可持久化日志契约。

-----

<a id="model-experience"></a>
## 模型体验

### 控制平面投影

#### 模型看到什么

什么都没有。此包消费仅用于日志的控制事件，从不贡献给 `deriveMessages()`，因此无论是否挂载此包，模型的请求上下文都逐字节相同。运行时只是让控制平面决定可持久化、可回放；它从不改变对话。

#### Token 影响

无。此包从不组装模型请求，因此不会给模型请求增加 token。

#### KV 缓存影响

无。此包从不构造提供方请求，因此不会增加 KV 缓存条目。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

这些限制定义了此包何时不是好的选择。它们是当前的包约束，而不是任务积压。

- **派生投影，不是第二权威。** 此包概念上取代的 SQLite 投影是可丢弃的：删除它并从 DSH 日志重建。DSH 日志是唯一持久的真相；在此包范围内，运行时本身不写任何 SQLite 行。
- **真实外部效果的对账协议延后（P4+）。** `reconcile()` 通过带 `reconcile: true` 的 worker 解决先前的 `commit-unknown`；生产级对账协议（外部状态检查、幂等键、saga 补偿）不在此范围内。
- **派生的 outbox 是工作视图，不是持久的。** `EffectExecutor.outbox()` 在调用时折叠 DSH 日志；它是调度恢复点，绝不是真相来源。
- **没有超出 A1 词汇的生命周期事件。** `execution/commanded` 的结算被 DERIVED（当其命令流结束时，折叠将该执行标记为已结算）；词汇中没有 `execution/settled` 事件。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

本开发者备注是维护者的工作上下文：未决定的问题与方向。它明确不具权威性 —— 已交付的行为、限制与已接受的理由位于上面的章节、包代码和生成的目录中。

#### 未来：进程边界的删除重建证明

`tests/projection.spec.ts` 在包内证明投影不变性：通过真实的 `SessionPersistenceSqlite` 在临时 DB 文件上构建 DSH 日志，折叠，关闭并删除派生的 SQLite，重新打开，从 DSH 重新加载，再次折叠，并断言两个状态相同。真正的进程边界版本（A4）将写入方与投影方分离到不同的进程中。

</details>
