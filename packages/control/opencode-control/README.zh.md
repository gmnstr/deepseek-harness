---
description: "面向 DeepSeek Harness 会话日志的控制平面执行与效果审计事件：可持久化、仅日志的记录，涵盖被命令的执行、相关的原生活动，以及请求／授权／拒绝／尝试／终态的效果生命周期，供编排控制面或调试效果权限的维护者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-opencode-control

[English](README.md) | 中文

## 摘要

`dsh-opencode-control` 向可合并扩展的 `SessionEventMap` 贡献一组小而互不重复的控制平面事件：可持久化、仅日志的记录，描述 opencode 风格的控制面命令了什么、原生活动如何关联到一次执行，以及每个被请求的效果如何经历授权／拒绝／尝试／终态状态。每个事件都是基于品牌化 id 的 `version: 1` payload，由类型化工厂函数构造，因此生产者不会偏离已合并的词汇。这些事件刻意仅用于日志 —— 它们从不进入 LLM 消息表面，因此 `Session.deriveMessages()` 和所有转录折叠都会忽略它们，而持久化、回放和恢复重建会无损地保留它们。

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

当控制面（自动化循环、钩子桥、代理命令运行器）必须记录它命令了什么以及 harness 如何授权和执行效果，并且要写进已经承载模型转录的同一个可持久化会话日志时，请使用此包。每个事件都通过普通的 `Session.append` 路径追加，因此持久化、回放、恢复以及失败关闭的读取路径都原样来自会话子系统。

### 它增加了什么

词汇表横跨三个作用域的十个事件：

- **`execution/*`** —— `execution/commanded` 记录一个执行单元被命令，带命令字符串和来源；`activity/correlated` 记录在一次执行下观察到的原生（非 harness）事件。
- **`effect/*` 生命周期** —— `effect/requested` 开启一个效果请求，指明操作、资源和权限类别；`effect/authorized` 与 `effect/denied` 记录权限决定；`effect/attempt-started` 开启一次尝试；`effect/succeeded`、`effect/failed` 与 `effect/commit-unknown` 关闭它；`effect/reconciled` 稍后将未知的尝试解析为确定结果。

每个 payload 都携带 `version` 字段和品牌化 id（`ExecutionId`、`ActionId`、`AttemptId`），因此由较新的生产者形态写入的日志在类型层面仍然可识别。

### 构造 payload

生产者从包根导入类型化工厂，并通过自己的 `Session` 追加结果：

```ts
import { Session } from '@deepseek-ai/dsh-session'
import { ExecutionId, effectRequested } from '@deepseek-ai/dsh-opencode-control'

const execution = ExecutionId('exec-1')
session.append('effect/requested', effectRequested({
  execution_id: execution,
  action_id: ActionId('act-1'),
  operation: 'write',
  resource: '/workspace/notes.md',
  effect_class: 'filesystem',
}))
```

工厂返回类型就是该事件类型的 `SessionEventMap` 数据，因此错误的字段形态在到达可持久化日志之前就会在编译期失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 —— 点击展开</summary>

可观察的契约在[使用此包](#use-this-package)中说明；本节解释合并、目录和读取路径如何协作。

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/types.ts`](src/types.ts) | 品牌化 id 与 `SessionEventMap` 声明合并的唯一所在 |
| [`src/index.ts`](src/index.ts) | 类型化 payload 工厂（`DshControlPayload` 以及每个 `effect*`／`execution*` 构造器） |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生：没有可观察的进程内关系（往返与生命周期测试负责这些检查） |

### 声明合并与生成器

这十个事件声明在 `declare module '@deepseek-ai/dsh-session/types'` 内部，与每个其他插件拥有的会话事件完全一致。`gen-persistence-catalog` 生成器扫描 `packages/*/*/src/**/*.ts` 中的 `SessionEventMap` 合并，要求每个成员携带完整 JSDoc，并重新生成 `KNOWN_SESSION_EVENT_TYPES` 与 `docs/persistence-catalog.md`；此包通过工作区通配符自动被该扫描纳入。

### 为什么仅用于日志

每个控制事件都命名一个原生控制面拥有、而 harness 之前没有记录的事实。因为其中没有一个属于 `SurfaceEventType` 成员，`Session.append` 接受它们时不需要 `SurfaceIntent` 选项元组，`deriveMessages()` 从不投影它们，并且 surface 折叠与从未挂载此包的会话完全一致。持久化像存储任何其他事件一样存储它们，而失败关闭的读取路径（`KNOWN_SESSION_EVENT_TYPES`）会拒绝包含此构建不认识类型的日志。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时，请阅读以下页面。

- [会话持久化事件目录](../../../docs/persistence-catalog.zh.md) —— 生成的词汇表：每个 `SessionEventMap` 成员及其 payload 与 surface 徽标。
- [会话子系统](../../../docs/subsystems/session.zh.md) —— surface 排序、`deriveMessages()` 与可持久化日志契约。
- [持久化子系统](../../../docs/subsystems/persistence.zh.md) —— 日志如何变得可持久化并回放。

-----

<a id="model-experience"></a>
## 模型体验

### 模型看到什么

什么都没有。每个控制事件都仅用于日志：它从不贡献给 `deriveMessages()`，因此无论是否挂载此包，模型的请求上下文都逐字节相同。这些事件的存在是为了让控制平面的决定可持久化、可回放，而不是改变对话。

### Token 与 KV 缓存影响

无。因为这些事件从不加入派生的消息历史，它们不会给模型请求增加 token，也不会增加 KV 缓存条目。

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延后工作

这些限制定义了此包何时不是好的选择。它们是当前的包约束，而不是任务积压。

- **仅词汇表 —— 无策略。** 此包记录事实；它不授权、不执行、也不对账效果。发出这些事件的控制面拥有这些转换，而 harness 核心将这些事件视为普通事件。
- **仓库外的消费者未注册。** 生成的 `KNOWN_SESSION_EVENT_TYPES` 只列出本仓库中声明的事件；声明自己事件类型的下游生产者包需要自己的注册表面，而会话子系统已将其延后。
- **没有版本迁移。** 每个 payload 在类型层面固定 `version: 1`；没有运行时迁移表，预发布的 `SESSION_FORMAT_VERSION` 不承诺兼容性。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

本开发者备注是维护者的工作上下文：未决定的问题与方向。它明确不具权威性 —— 已交付的行为、限制与已接受的理由位于上面的章节、包代码和生成的目录中。

#### 未来：消费表面

当前的合并只面向生产者：它使这些事件可追加、可持久化、可回放，但还没有消费者投影它们。未来的消费者（控制平面仪表盘、回放分析工具或策略评估器）将把 `execution/*` 与 `effect/*` 事件折叠进自己的投影，遵循 `todo/write` 与权限旋钮使用的 `session-projection` 模式。目前尚无设计。

</details>
