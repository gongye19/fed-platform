# FedAgent Platform 产品意图

## 一句话

建设一个面向今后所有自研 Agent 应用的多站点联邦通道：每个应用在平台上有一个独立的 AppFederationAgent，负责该应用各站点之间的收集、联邦、发布和回滚。

## 固定产品模型

- 我们先定义 FedApp 协议，今后的新应用从第一天遵循。
- 一个 Application 可以分发到若干 Site。
- 只在同一 app_id 和 federation_id 内联邦，不同应用永远不 union。
- 注册 Application 时，平台自动创建一个逻辑 AppFederationAgent。
- Agent 可以为不同 Federation 绑定不同 Artifact Handler 和 Federation Algorithm。
- 平台不预设联邦对象：它可以是 memory、skill、经验卡、LoRA 更新或模型权重。

## 现在先做什么

1. 应用、站点、Federation 和 Membership 注册与隔离。
2. 站点产生按 schema 声明的 Artifact，断网可重试地上传 Submission。
3. 平台按 digest 存工件，按 app/federation 存元数据。
4. AppFederationAgent 接收事件，v1 默认只做确定性 manual-channel workflow。
5. 管理员或未来插件创建 Release，分发到成员站点。
6. 应用 stage、activate、ack，失败时 rollback。
7. 提供 conformance test，使新应用按同一契约开发。

## 只预留三个插件位

- AgentCorePlugin：中心 AppFederationAgent 如何理解事件和规划下一步。
- ArtifactHandlerPlugin：某种 Artifact 如何验证、提取元数据和判断兼容性。
- FederationAlgorithmPlugin：某个 Federation 的工件怎么 union、filter、aggregate 或 evolve。

插件只返回候选工件和操作意图；不直连数据库，不持有站点凭据，不直接发布。

## 绝不插件化

应用/站点隔离、Membership、鉴权、幂等、Event/Command、Artifact digest、Submission/Task/Release/Delivery 状态、审计和安全底线都是确定性平台内核。

## v1 成功标准

两个全新应用通过 FedApp conformance test 接入。每个应用有独立 Agent 和站点组；工件能不丢不重地上传、存储、分发、stage、activate 和 rollback；彼此内容不可见。

当第一个真实 memory/skill/权重插件出现时，只新增插件和绑定，不修改通道与内核实体，这时才证明平台设计成立。
