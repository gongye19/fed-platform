# FedAgent Platform — 完整方案

状态：**v1 架构提案，待契约评审**  
范围：先建成稳定的多应用、多站点联邦通道；不预设联邦的是 memory、skill 还是模型权重，也不先实现具体联邦算法。

---

## 1. 产品模型

```text
FedAgent Platform
├─ Application A
│  ├─ App Federation Agent A       应用级联邦协调者
│  ├─ Federation main             站点 1 / 2 / 3
│  └─ Federation private-group    站点 4 / 5
│
└─ Application B
   ├─ App Federation Agent B
   └─ Federation main             站点 2 / 6 / 7
```

固定规则：

1. 注册一个 Application，平台就创建一个逻辑的 `AppFederationAgent`。
2. `AppFederationAgent` 只能看到本应用的站点、工件、任务和发布。
3. 真正的隔离/聚合 key 是 `(app_id, federation_id)`。
4. 不同应用的内容永远不 union。
5. 同一应用可以有多个 Federation，以支持不同站点组或不同联邦目标。
6. Agent 是逻辑 actor，不是每个应用常驻一个容器；Worker 按 `app_id` 加载它的状态和插件配置执行。

---

## 2. 整体部署

```text
站点 A（原始数据边界）
┌────────────────────────────────────────────────────┐
│ 按 FedApp 协议开发的应用                          │
│ │ 本地数据  │ 本地/远程模型  │ 工具  │ 轨迹      │
│ └─ FedApp Adapter                                      │
│                    ↕ private local HTTP               │
│ Federation Node：outbox/inbox、重试、缓存、校验、审计  │
└────────────────────────│───────────────────────────┘
                         │ 只主动出站 HTTPS
┌────────────────────────▼───────────────────────────┐
│ 中心平台                                               │
│ React Federation Console → FastAPI Control/Admin API      │
│ App Registry / Agent Registry / Federation Registry      │
│ Event & Command Channel / Release & Delivery              │
│ Plugin Runner / App Federation Agent Worker               │
│          │                                  │         │
│      PostgreSQL                         Object Storage     │
└────────────────────────────────────────────────────┘
```

首版不拆成微服务：

```text
fed-api       FastAPI API 进程
fed-worker    同一 Python 代码库的后台 Worker
fed-console   独立 React/Vite 管理控制台
postgres      元数据、事件、任务、Agent 状态、发布
object-store  工件 bytes；有大工件时再接 S3/MinIO
```

---

## 3. 内核实体

| 实体 | 含义 |
|---|---|
| `Application` | 一个按 FedApp 协议开发的产品 |
| `Site` | 一个部署站点/机构 |
| `Membership` | 某 Site 是否可参加某 Federation，可提交/接收/执行任务 |
| `AppFederationAgent` | 每个 Application 一个的逻辑联邦协调者 |
| `Federation` | 一组站点的独立联邦空间 |
| `ArtifactType` | 应用自定义的工件类型、purpose、schema 与处理器绑定 |
| `Artifact` | 不可变、内容寻址的联邦对象；可以是 JSON 或 blob |
| `Submission` | 站点向 Federation 提交的 Artifact 引用及元数据 |
| `Task` | Agent/算法请求站点本地执行的受 schema 约束任务 |
| `Release` | Agent 决定可分发的一组 Artifact 快照 |
| `Delivery` | 某 Release 到某 Site 的 stage/activate/rollback/ack 状态 |
| `AgentJob` | AppFederationAgent 或插件的可重试后台任务 |
| `PluginBinding` | 指定 Agent/Federation/ArtifactType 使用哪个插件版本 |

这些实体是平台内核，不因联邦 skill 还是权重而变。

---

## 4. 应用与站点注册

### 4.1 FedApp Manifest

所有新应用都携带 `fedapp.yaml`。协议不规定它必须联邦什么，只要求它声明自己支持的类型和本地任务。

```yaml
schema_version: fedapp/v1
app_id: com.example.research-agent
app_version: 1.0.0
adapter_protocol: ">=1.0 <2.0"

artifact_types:
  - type: com.example.observation
    format_version: 1
    media_type: application/json
    purpose: contribution # contribution | release | evaluation
    schema_digest: sha256:...

task_types:
  - type: com.example.collect-observation
    version: 1
    input_schema_digest: sha256:...
    output_schema_digest: sha256:...
```

应用可以在后续版本新增 ArtifactType/TaskType，但不得原地改已发布 schema 的语义。

### 4.2 注册动作

```text
POST /admin/v1/apps
    验证 Manifest
    创建 Application namespace
    创建 AppFederationAgent
    绑定受限 DeepSeek Harness Agent Core

POST /admin/v1/apps/{app_id}/federations
    创建 federation_id
    选择成员站点与参与权限

POST /admin/v1/sites
    注册全局 Site
    签发可轮换站点凭据

PUT /admin/v1/apps/{app_id}/federations/{federation_id}/memberships/{site_id}
    创建或更新 Membership 与 submit/receive/execute_task 权限

PUT /admin/v1/apps/{app_id}/agent
    更新 Agent Core 插件与配置 revision

PUT /admin/v1/apps/{app_id}/federations/{federation_id}/plugins
    绑定 Artifact Handler / Federation Algorithm
```

没有联邦算法插件时，Application 仍可注册和接收 Submission。Agent Core 的结构化意图会被保存；管理员仍可创建 Release 并分发，这是当前最小可用通道。

---

## 5. 协议

### 5.1 通用信封

```json
{
  "protocol_version": "1",
  "message_id": "01K...",
  "kind": "submission.created",
  "app_id": "com.example.research-agent",
  "federation_id": "main",
  "app_version": "1.0.0",
  "occurred_at": "2026-08-28T00:00:00Z",
  "payload": {}
}
```

固定规则：

- `message_id` 是幂等键；同 ID 同内容返回已接收，同 ID 不同内容拒绝。
- `site_id` 从认证主体推导，不信任 body 自报值。
- Core Event/Command 的外层 schema 由平台冻结。
- `payload` 必须符合该 App/Federation 注册的 TaskType/ArtifactType/plugin schema，不是无约束 JSON。
- 批量上传按消息分别返回结果，一个坏消息不卡住整个 outbox。
- 错误固定形状：`code / message / retryable / field`。

### 5.2 Artifact Descriptor

内核不需要知道 Artifact 是 memory、skill 还是权重，但必须知道它的类型、版本、完整性和来源。

```json
{
  "artifact_id": "01K...",
  "type": "com.example.observation",
  "format_version": 1,
  "media_type": "application/json",
  "digest": "sha256:...",
  "size": 8120,
  "base_artifact_id": null,
  "metadata": {}
}
```

- bytes 按 digest 寻址；上传、下载、stage 前都校验。
- `base_artifact_id` 可表示 delta/patch 的基线，内核不解释 patch 语义。
- `metadata` 由 ArtifactType schema 约束，用于兼容性、模型架构、任务范围和匿名评测摘要等标记。
- 小 JSON 可 inline；大工件必须存对象存储，消息只传 Descriptor。
- 工件不可变；修改内容就创建新 artifact_id/digest。

### 5.3 Site 端 API

```text
POST /site/v1/artifacts
    上传小工件或初始化大工件上传

GET /site/v1/artifacts/{digest}
    下载站点被授权的工件

POST /site/v1/events:batch
    上行 Event，包括 Submission、Task Result、Delivery Ack、Outcome

GET /site/v1/commands?after=<cursor>&limit=<n>
    站点长轮询下行 Command/Release
```

所有站点连接均为主动出站 HTTPS；中心不需要连入站点网络。Command 带单调 cursor、command_id、过期时间和可选 lease。

Core Event：

- `submission.created`
- `submission.withdrawn`
- `task.completed`
- `release.staged`
- `release.applied`
- `release.rejected`
- `release.rolled_back`
- `outcome.reported`
- `command.completed`

Core Command：

- `task.execute`
- `release.stage`
- `release.activate`
- `release.rollback`
- `release.revoke`

### 5.4 应用与 Federation Node 的本地契约

```text
# 应用暴露给 Federation Node
GET  /.well-known/fedapp-manifest
POST /federation/v1/tasks:execute
POST /federation/v1/releases:stage
POST /federation/v1/releases:activate
POST /federation/v1/releases:rollback

# Federation Node 暴露给应用
POST /local/v1/artifacts
POST /local/v1/events:batch
```

应用可用任何语言实现。OpenAPI + JSON Schema 是规范源，SDK 只是便利层。每个新应用必须通过 conformance test runner。

---

## 6. 完整数据流

### 6.1 站点主动提交

```text
应用本地抽取/训练
  ↓ 生成 Artifact
Federation Node 写本地 outbox
  ↓ 上传 bytes，获得/confirm Descriptor
  ↓ 发 submission.created
Control API 鉴权 + schema + membership + 幂等检查
  ↓
PostgreSQL 写 Submission/Event，Object Store 保存 bytes
  ↓
为 AppFederationAgent 创建 AgentJob
```

平台不从应用拉原始数据。应用自己决定何时抽取、脱敏并产生已注册 Artifact。

### 6.2 Agent/Algorithm 主动发本地任务

```text
AppFederationAgent 返回 issue_task 意图
  ↓ Core 校验 membership/task schema
创建 task.execute Command
  ↓ Federation Node 拉取并交给应用
应用在本地执行（例如生成 memory、跑评测、训练 LoRA）
  ↓
返回 task.completed + Artifact Descriptor
  ↓
触发下一个 AgentJob
```

### 6.3 分发和使用

```text
Agent 或管理员提议 Release
  ↓ Core 创建不可变 Release 快照
为目标 Membership 创建 Delivery
  ↓ release.stage
Federation Node 下载并校验 Artifact
  ↓ 应用 stage：检查自己能否使用
  ↓ release.staged/rejected
  ↓ release.activate
应用原子切换 active artifact reference
  ↓ release.applied
应用可继续上报 outcome.reported
```

`stage` 不立即生效。应用必须保留上一个已知可用 Release，以支持 rollback。平台不解释“怎么用这个 Artifact”；语义由应用的 stage/activate 实现和 Artifact Handler 共同定义。

---

## 7. App Federation Agent

### 7.1 创建与执行

注册 Application 时，平台写入：

```text
agent_id
app_id
agent_core_plugin_id
agent_core_plugin_version
config_revision
state_revision
status
```

Agent 不直接订阅消息中间件。API 成功写入 Event/Submission 后，在同一数据库事务中写入 `AgentJob`。`fed-worker` 使用 Postgres lease 领取 Job，读取该 app 的状态快照，调用 Agent Core，然后把合法意图写回平台。

这样 1,000 个应用是 1,000 份逻辑 Agent 状态，不是 1,000 个常驻进程。

新应用默认使用 `deepseek-harness`。Worker 通过官方 Python SDK 启动一次性 Harness subprocess，使用完整的无工具 Cordis 组合：不挂载 shell、文件系统、skill、job 或站点凭据。Harness 只输出 `{new_state, intents, evidence}`；平台用 Pydantic 校验大小和类型后保存结果与新状态。平台数据库是 memory 的唯一持久层，`config_revision/state_revision` 防止并发覆盖。现有应用保留 `manual-channel`，管理员可通过版本化配置 API 切换。

### 7.2 Agent 可以返回的固定意图

```text
run_algorithm
issue_task
propose_release
distribute_release
wait
fail
```

Agent 不能直接写数据库、读站点凭据或发 HTTP 到站点。内核对意图再做 membership、schema、权限、配额和状态转移校验。

---

## 8. 插件设计

### 8.1 只预留三个插件位

| 插件 | 职责 | 例子 |
|---|---|---|
| `AgentCorePlugin` | 决定应用级 Agent 收到事件后怎么规划 | 确定性 workflow、LLM Agent、不同 Harness |
| `ArtifactHandlerPlugin` | 验证工件，提取标准元数据/兼容性 key | JSON Schema、Agent Skills、memory、SafeTensors/LoRA |
| `FederationAlgorithmPlugin` | 对某 Federation 的输入工件执行联邦计算 | union/filter、skill evolution、FedAvg、FedProx |

不再预留 EvaluatorPlugin、DistributionPlugin、StoragePlugin 等额外空插槽。当第二个真实实现证明现有契约不够时再拆。

### 8.2 插件契约

```text
AgentCorePlugin.handle(agent_snapshot, event) ->
    {new_agent_state, intents[], evidence}

ArtifactHandlerPlugin.inspect(artifact_descriptor, content_ref) ->
    {valid, normalized_metadata, compatibility_key, errors[]}

FederationAlgorithmPlugin.run(federation_snapshot, input_refs[], plugin_state) ->
    {new_plugin_state, output_artifacts[], task_intents[], evidence}
```

- memory/skill 算法返回新的语义 Artifact。
- FedAvg 算法读取权重 update refs，返回新全局模型 Artifact。
- 需要多轮交互的算法通过 `task_intents` 请求 Agent/Core 为站点创建 Task。
- 插件输出是候选工件/意图，不是已激活 Release。

### 8.3 Agent Core 的边界

- 应用内服务用户的 Agent Core 仍属于应用自身，不是平台插件。
- 这里的 `AgentCorePlugin` 只是中心 `AppFederationAgent` 的决策核心。
- 它可以是一段确定性 workflow，也可以是使用某个 Harness/LLM 的 Agent。
- 平台内核不是 Agent；身份、安全、状态、审计和发布激活不交给 LLM。

### 8.4 明确不插件化

- Application/Site/Federation/Membership 隔离
- 鉴权、授权、凭据和参与策略
- Event/Command 信封、幂等、cursor、lease 和重试
- Artifact digest、不可变性、谱系和存储引用
- Submission/Task/Release/Delivery 状态与合法转移
- 审计、限流、配额和安全底线
- 原始数据不出站的边界

### 8.5 插件如何运行

插件注册信息：

```yaml
api_version: fedplugin/v1
plugin_id: example-algorithm
plugin_version: 1.0.0
kind: federation-algorithm
supported_artifact_types: [com.example.observation]
config_schema_digest: sha256:...
runtime: builtin  # v1; container 有第一个外部插件时再开
```

v1 实现 `deepseek-harness` Agent Core 与 `manual-channel` 回退；Harness 组合固定为无工具安全边界，provider、model、超时、token 上限、应用指令与平台 memory 上限可配置。插件协议先冻结，不先做插件市场、动态下载或容器编排。

当第一个真实外部算法出现时，用独立、签名、按 image digest 锁定的容器运行，通过版本化 HTTP/JSON Worker API 通信。大工件只传 Descriptor；插件不拿数据库和站点凭据。

---

## 9. 存储

完整表结构、事务边界、Artifact 上传和站点 SQLite 设计见 [DATABASE.md](./DATABASE.md)。

### PostgreSQL

```text
applications
application_versions
sites
site_credentials
memberships
app_agents
federations
artifact_types
task_types
artifacts
artifact_lineage
submissions
tasks
releases
release_artifacts
deliveries
events
commands
agent_jobs
plugin_registry
plugin_bindings
plugin_states
audit_log
```

应用内容行都带 `app_id/federation_id`，由服务端根据认证上下文写入，不接受插件或站点任意指定。

### Object Storage

- 按 digest 存 Artifact bytes，元数据在 PostgreSQL。
- 下载链接短期且限定 Site/App/Federation。
- 未被 Submission、Release、lineage 或 plugin state 引用的上传可在宽限期后 GC。

### Federation Node 本地 SQLite

- outbox/inbox
- command cursor
- Artifact 下载缓存与 digest
- active/previous Release 引用
- 本地操作审计

---

## 10. 安全与隐私

- 原始对话、病历、实验数据、评测样本和样本 ID 默认不出站；`evaluation` Artifact 只上传应用声明的汇总指标。
- 应用是出站内容的第一责任方；Federation Node 再按 ArtifactType allowlist、schema、大小和策略检查。
- 每个 Membership 独立控制 `submit / receive / execute_task`。
- pilot 可用可轮换 API key + TLS；生产可换 mTLS/workload identity，不改 payload schema。
- `app_id/federation_id/site_id` 从认证和 Membership 推导/校验，不信任消息自报。
- 插件返回意图，不直接穿越权限和发布底线。
- 含可执行脚本的 Artifact 视为代码发布，需额外签名和审批；v1 可直接禁止。
- 模型权重联邦中，普通 FedAvg 不等于 secure aggregation。需要安全聚合时必须有专门协议/插件，不用 `secure: true` 伪装。

---

## 11. 技术选型

| 部分 | v1 |
|---|---|
| Control API | Python 3.12+ / FastAPI / Pydantic v2 |
| 管理前端 | React 19 / Vite；独立 `frontend/` 服务 |
| Worker & Agent | Python 3.12+ |
| 元数据 | PostgreSQL；本地开发连接隔离的 Railway development 数据库 |
| 工件 | S3-compatible Object Storage；小 JSON 与大工件同一通道 |
| Federation Node | Python daemon + SQLite + 私有 HTTP API |
| 协议源 | OpenAPI + JSON Schema 2020-12 |
| 可观测性 | OpenTelemetry，默认不记录 prompt/output 正文 |
| 应用语言 | 任意；通过 conformance test 即可 |

不先加 Redis、Celery、Kafka、Temporal、向量数据库、K8s Operator 或插件市场。后台 Job 先用 PostgreSQL lease/状态字段实现。

---

## 12. v1 交付

### 做

1. 冻结 FedApp Manifest、Envelope、Artifact、Event/Command、Release/Delivery schema。
2. 实现 Application/Site/Federation/Membership 注册与隔离。
3. 实现 Federation Node outbox/inbox、上下行、断网重试和 Artifact 校验。
4. 实现 Artifact 存储、Submission、Task、Release、Delivery 通道。
5. 注册应用时自动创建 AppFederationAgent，默认使用受限 `deepseek-harness` Core。
6. 冻结三个插件 manifest/调用契约，只实现内置 JSON/opaque handler。
7. 提供 conformance test runner 和一个从零按协议开发的参考应用。
8. 提供 Federation Console，查看 Application/Federation/Site、通道状态并完成手工发布。

### 不做

- 不实现 memory/skill/FedAvg 等真实联邦算法。
- 不自动执行尚未实现的联邦算法意图；当前只校验并保存 Agent 决策。
- 不实现外部插件动态安装、市场和容器编排。
- 不为未遵循 FedApp 契约的历史应用做兼容层。
- 不管应用镜像升级和站点 K8s/VM 运维。

---

## 13. v1 验收

1. 注册两个新应用后，自动出现两个相互隔离的 AppFederationAgent。
2. Application A 的站点 1/2/3 能提交、存储、查看和分发 A 的工件，Application B 永远不可见。
3. 平台关闭时业务应用照常工作；Federation Node 在恢复后不丢不重地上传。
4. 小 JSON 和大 blob 都可通过 Descriptor 上传、存储和下载，digest 错误必须拒绝。
5. 管理员可从某 Federation 的 Submission 创建 Release，目标站点可 stage、activate、ack 和 rollback。
6. 不合法 Membership、schema、ArtifactType、app/federation 跨界访问均被拒绝并审计。
7. 参考应用通过 conformance test；其实现语言不是协议的一部分。
8. 插件契约可用一个小型假算法验证：读两个 Artifact ref，产生一个新 Artifact 候选，不直接改数据库或分发。

---

## 14. 当前实现

旧 FastAPI/SQLite spike 已被正式 PostgreSQL/S3 基础替换。当前实现覆盖 Application、Agent、Site、
Federation、Membership、ArtifactType、Artifact、Submission、Event、AgentJob、Release、Delivery、
Command/Ack、受限 DeepSeek Harness/manual-channel Worker、版本化 Agent 配置与状态，以及独立 Federation Console。

下一阶段选择第一个真实应用，冻结 Federation Node 契约；不恢复旧 `Update/Digest/Plugin` 接口。
