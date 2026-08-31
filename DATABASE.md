# FedAgent Platform — 数据库与数据保存设计

状态：**v1 提案**  
原则：PostgreSQL 保存关系与状态；Object Storage 保存 Artifact 内容；站点 SQLite 保存可靠传输状态。

本地开发、Railway/Northflank 托管和迁回自有服务器的部署方案见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

---

## 1. 哪些数据保存在哪里

```text
应用自己的数据库
└─ 原始对话、样本、病历、训练集、业务状态
   默认不进入联邦平台

站点 Federation Node / SQLite
├─ 待发送 Event 与 Artifact 引用
├─ 已接收 Command、cursor、重试状态
├─ Artifact 本地缓存
└─ active / previous Release

中心 PostgreSQL
├─ Application / Site / Federation / Membership
├─ Artifact 描述与谱系
├─ Submission / Task / Release / Delivery
├─ Event / Command / AgentJob
├─ Plugin 配置与小型状态
└─ 审计、凭据 hash、版本记录

中心 Object Storage
└─ 所有 Artifact bytes：JSON、skill 包、memory 快照、LoRA、模型权重等
```

即使 Artifact 是小 JSON，内容也走同一套对象存储；PostgreSQL 只保留 digest、大小、类型、
schema 约束后的可检索 metadata 和 storage key。这样 JSON 与大模型权重使用完全相同的通道。

---

## 2. 数据关系

```text
Application ──1:1── AppFederationAgent
     │
     ├──1:N── Federation ──N:M── Site
     │                         via Membership
     │
     ├──1:N── ArtifactType / TaskType
     │
     └── Federation
          ├── Artifact ◀── Submission ── Site
          ├── Task ───────────────────── Site
          ├── Release ── ReleaseArtifact ── Artifact
          │      └── Delivery ─────────── Site
          ├── Event / Command / AgentJob
          └── PluginBinding / PluginState
```

所有联邦内容都以 `(app_id, federation_id)` 为数据库作用域。`federation_id = main` 可以在多个
Application 中重复，但它们在主键、外键、查询和对象存储路径上都不会相交。

---

## 3. 标识和通用字段

- `app_id / federation_id / site_id / type_name`：协议中的稳定字符串 ID，注册后不可改名。
- `artifact_digest`：`sha256:<64 hex>`，内容改变就产生新 Artifact。
- Submission、Task、Release、Delivery、Event、Command、Job：服务端生成 UUID v4。
- Command cursor：PostgreSQL `BIGINT GENERATED ALWAYS AS IDENTITY`，只要求单调，不要求连续。
- 时间统一使用 `TIMESTAMPTZ` 和 UTC；前端负责按用户时区展示。
- 状态使用 `TEXT + CHECK`，不用难迁移的 PostgreSQL ENUM。
- 可修改的配置保存 `revision`；更新时带旧 revision，避免两个管理员互相覆盖。

不在所有表机械添加 `deleted_at`。Application、Site、Federation 和 Membership 使用明确的
`disabled_at / ended_at`；Artifact、Release、Event 和 Audit 属于不可变记录。

---

## 4. PostgreSQL 表

### 注册与权限

| 表 | 保存内容 | 关键约束 |
|---|---|---|
| `applications` | app_id、名称、当前版本、状态 | `app_id` 主键 |
| `application_versions` | 不可变 FedApp Manifest 与 digest | `(app_id, app_version)` 唯一 |
| `app_agents` | 每个应用一个 Agent、状态、配置 revision | `app_id` 主键 |
| `sites` | 全局 Site、Node 版本、last_seen_at、状态 | `site_id` 主键 |
| `site_credentials` | token prefix、SHA-256 hash、到期/撤销时间 | 不保存明文 token |
| `federations` | 应用内 Federation、名称、状态 | `(app_id, federation_id)` 主键 |
| `memberships` | Site 加入 Federation 及三个权限 | `(app_id, federation_id, site_id)` 主键 |
| `artifact_types` | 类型、purpose、format version、schema、media type | 旧版本不可原地修改 |
| `task_types` | Task 类型和输入/输出 schema | 旧版本不可原地修改 |

### 联邦通道

| 表 | 保存内容 | 关键约束 |
|---|---|---|
| `artifacts` | digest、type、size、metadata、storage_key | `(app_id, federation_id, digest)` 主键；不可变 |
| `artifact_lineage` | 新 Artifact 由哪些输入 Artifact 产生 | 父子必须在同一 app/federation |
| `submissions` | 哪个 Site 在何时提交了哪个 Artifact | 按 Site 的 idempotency key 唯一 |
| `tasks` | Task 类型、目标 Site、输入引用、当前状态 | 必须关联有效 Membership |
| `releases` | 不可变发布头、创建者、创建时间 | 属于一个 app/federation |
| `release_artifacts` | Release 包含的 Artifact 快照 | 只允许同作用域 Artifact |
| `deliveries` | Release 到每个目标 Site 的当前状态 | `(release_id, site_id)` 唯一 |
| `events` | 上行事件和状态迁移历史 | append-only、event_id 幂等 |
| `commands` | 下行 Task/Release 命令及 cursor/ack | 按 Site + cursor 拉取 |
| `agent_jobs` | PostgreSQL 后台队列、重试与 lease | Worker 用 `SKIP LOCKED` 领取 |

`deliveries` 保存便于查询的当前状态，完整过程追加到 `events`。状态变化不覆盖历史事件。

### 插件与运维

| 表 | 保存内容 | 关键约束 |
|---|---|---|
| `plugin_registry` | plugin_id、version、kind、manifest | `(plugin_id, version)` 唯一 |
| `plugin_bindings` | Agent/Federation/ArtifactType 的插件版本与配置 revision | 每个 slot 只有一个 active binding |
| `plugin_states` | 小型 JSON 状态、revision、最近 Job | 大状态必须保存为 Artifact |
| `audit_log` | 管理员、动作、目标、结果、时间 | append-only；不放 Artifact 正文 |

插件配置里的密码、访问 token 不写 JSONB，只写 Secret Manager 的引用。

---

## 5. 数据库怎样保证不串应用

核心内容表和关联表都携带 `app_id, federation_id`，外键也使用完整复合键。例如：

```sql
CREATE TABLE federations (
  app_id       text NOT NULL REFERENCES applications(app_id),
  federation_id text NOT NULL,
  display_name text NOT NULL,
  disabled_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, federation_id)
);

CREATE TABLE memberships (
  app_id          text NOT NULL,
  federation_id   text NOT NULL,
  site_id         text NOT NULL REFERENCES sites(site_id),
  can_submit      boolean NOT NULL DEFAULT false,
  can_receive     boolean NOT NULL DEFAULT false,
  can_execute_task boolean NOT NULL DEFAULT false,
  ended_at        timestamptz,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, federation_id, site_id),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);

CREATE TABLE artifacts (
  app_id          text NOT NULL,
  federation_id   text NOT NULL,
  digest          text NOT NULL,
  type_name       text NOT NULL,
  format_version  integer NOT NULL,
  media_type      text NOT NULL,
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  metadata        jsonb NOT NULL DEFAULT '{}',
  storage_key     text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, federation_id, digest),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);
```

`release_artifacts`、`submissions` 和 `artifact_lineage` 都使用
`(app_id, federation_id, digest)` 复合外键，因此数据库本身会拒绝把 Application A 的 Artifact
挂到 Application B 的 Release 上。

站点 API 的每条 SQL 仍必须同时带认证得到的 `site_id` 和 Membership 作用域；外部用户永远不能直连数据库。
v1 不先增加复杂 RLS，先用复合约束、单一数据访问层和跨作用域拒绝测试守住边界；如果未来开放租户 SQL
或拆分多团队服务，再加 PostgreSQL RLS。

---

## 6. Artifact 内容如何保存

对象 key 使用作用域加 digest：

```text
artifacts/{app_id}/{federation_id}/sha256/{前2位}/{完整hash}
```

v1 只在同一个 `(app_id, federation_id)` 内去重，不做跨 Application 物理去重。这样删除、授权、
备份和泄漏边界都更清楚，代价只是相同 bytes 在不同应用中可能重复保存。

上传过程：

```text
1. API 从认证信息得到 app/federation/site，检查 Membership 和 ArtifactType
2. 流式写入临时对象，同时计算 SHA-256 和大小，不把整个文件读进内存
3. digest/大小/schema 校验失败：删除临时对象，返回错误
4. 将对象写到最终 digest key；已有相同对象则复用
5. 一个 PostgreSQL 事务写 Artifact、Submission、Event、AgentJob、Audit
6. 提交成功后清理临时对象
```

对象存储与 PostgreSQL 无法共用事务，所以顺序必须是“对象先存在，数据库后引用”。崩溃最多留下没有
数据库引用的孤儿对象，不会留下指向不存在内容的有效 Artifact。定时 GC 只删除超过宽限期且数据库中
没有引用的对象。

对象只能通过平台鉴权后的短期 signed URL 下载；客户端不能列 bucket。Object Storage 开启服务端加密，
最终 digest key 禁止覆盖。

---

## 7. 几个关键写入事务

### 注册 Application

同一事务写入：

```text
applications
application_versions
app_agents（manual-channel）
audit_log
```

任何一步失败全部回滚，不出现“有 Application、没有 Agent”的半注册状态。

### 接收 Submission

Artifact bytes 已验证存在后，同一事务写入：

```text
artifacts              INSERT；digest 已存在则比对不可变描述
submissions            idempotency key 防重复
events                 submission.accepted
agent_jobs              唤醒对应 AppFederationAgent
```

已有 digest 的 type、format version、media type、size 或 metadata 不一致时必须拒绝；只有描述完全一致
才视为同一个 Artifact。Submission 幂等冲突时返回原记录，不再新增 Event 或 AgentJob。

唯一约束建议为：

```text
(app_id, federation_id, site_id, idempotency_key)
```

相同请求重试返回原来的 Submission，不重复触发 Job。

### 创建 Release

同一事务写入不可变 `releases`、`release_artifacts`，为每个有 `can_receive` 的目标 Site 创建
`deliveries` 和 `commands`。任何目标越权或 Artifact 跨作用域，整个 Release 创建失败。

### Delivery 状态变化

使用带旧状态条件的更新避免并发乱序：

```sql
UPDATE deliveries
SET state = 'staged', updated_at = now()
WHERE delivery_id = $1 AND state = 'pending'
RETURNING delivery_id;
```

更新成功后在同一事务追加 `delivery.staged` Event。状态已变化时按幂等结果返回，不强行覆盖。

### Worker 领取 Job

Worker 使用 PostgreSQL 的 `FOR UPDATE SKIP LOCKED` 批量领取到期 Job，写入 `leased_by / leased_until`。
Worker 崩溃后 lease 到期即可重试，不需要 v1 先部署 Redis、Celery 或 Kafka。

---

## 8. JSONB 用在哪里

适合 JSONB：

- FedApp Manifest 与 JSON Schema；
- Artifact 的少量、schema-bound metadata；
- Event/Command 的版本化 payload；
- 插件配置和小型 checkpoint；
- Audit 的非敏感变更摘要。

必须使用普通列：

- app/federation/site/digest 等作用域键；
- 权限、状态、cursor、时间、大小、版本；
- 任何需要外键、唯一约束、排序和高频筛选的字段。

禁止放 JSONB：Artifact 正文、模型权重、大型 memory、日志全文、密钥。大型插件状态保存成 Artifact，
`plugin_states` 只记录其 digest。

---

## 9. Federation Node 的 SQLite

站点侧只需要 6 张表：

| 表 | 用途 |
|---|---|
| `node_config` | site_id、中心地址、非明文凭据引用、当前 cursor |
| `outbox_events` | 等待上传的 Event、idempotency key、重试时间 |
| `inbox_commands` | 已接收 Command，`command_id` 唯一 |
| `artifact_cache` | digest、本地路径、大小、校验时间、LRU 时间 |
| `release_state` | 每个 app/federation 的 active/previous Release |
| `local_audit` | stage/activate/rollback 调用结果 |

SQLite 开启 WAL。应用生成 Artifact 后，Node 在一个本地事务中登记 Artifact 和 outbox；中心确认后再标记
已发送。Command 先以 `command_id` 去重写入 inbox，再推进 cursor，避免进程崩溃导致命令丢失。

本地缓存可清理，但 active/previous Release 引用和未确认 outbox 不可按 LRU 删除。

---

## 10. 索引、保留与备份

v1 只建实际查询需要的索引：

```text
memberships(site_id, ended_at)
artifacts(app_id, federation_id, type_name, created_at DESC)
submissions(app_id, federation_id, created_at DESC)
deliveries(site_id, state, updated_at)
commands(site_id, command_cursor)
agent_jobs(status, available_at) WHERE status IN ('pending', 'retry')
events(app_id, federation_id, received_at DESC)
audit_log(created_at DESC)
```

不先分表、分库或建物化视图。单表规模和查询延迟证明需要后，再按时间分区 Event/Command/Audit。

保留规则：

- Application、Manifest、Release、Delivery 历史和 Audit 默认保留；注销先 disable，不直接删除。
- Artifact 只在没有 Submission、Release、lineage、plugin state 引用且超过宽限期后 GC。
- Event/Command 在 pilot 先全量保留；有真实容量数据后再确定归档周期。
- PostgreSQL 使用自动备份与 PITR；Object Storage 使用版本控制/生命周期；两边都按同一环境加密。

定期做两种完整性检查：数据库 Artifact 指向的对象必须存在；对象存储中的无引用对象进入 GC 候选。

---

## 11. v1 技术选择

- PostgreSQL 16+；正式中心数据库的集成测试也使用 PostgreSQL，不用 SQLite 模拟。
- Python 使用 psycopg 3 和明确 SQL，不先增加 ORM；复合键、`SKIP LOCKED` 和幂等写入直接用 SQL 更清楚。
- Schema 使用编号 SQL migration，由独立 migrate 命令执行，不在每个 API 进程启动时自动改表。
- 旧 spike 的 `apps/sites/items/digests` 已删除，不迁移；正式 schema 从编号 migration 开始。

v1 先实现这些固定表和状态约束；不会为 memory、skill、经验、LoRA、模型权重分别增加业务表。
