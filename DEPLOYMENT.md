# FedAgent Platform — 托管部署与可迁移设计

状态：**v1 提案**  
平台能力核对日期：2026-08-28

目标：Mac 上只写和运行代码；开发数据先放 Railway；以后迁到自己的服务器时不改业务代码和数据库结构。

---

## 1. 当前选择

开发和 pilot 先使用 Railway：

```text
Mac
└─ frontend / backend 源码与本地进程
        │ TLS
        ▼
Railway development environment
├─ fed-console
├─ fed-api / fed-worker
├─ PostgreSQL 18
└─ Private S3-compatible Bucket

Railway production environment（需要线上联调后再建）
├─ fed-api
├─ fed-worker
├─ fed-console
├─ PostgreSQL 18
└─ Private S3-compatible Bucket
```

Mac 不安装 PostgreSQL、MinIO、Redis、Kafka。开发环境没有真实大模型权重时，本地磁盘只出现上传过程中的
短期临时文件，完成或失败后立即删除；正式 Artifact 直接进入远端 Bucket。

Railway 当前提供可通过 `DATABASE_URL` 连接的 PostgreSQL 服务、外部 TCP 连接，以及私有、S3-compatible
Storage Buckets。Bucket 支持 presigned URL，并且不同 Railway environment 使用隔离的 bucket 实例：

- [Railway PostgreSQL](https://docs.railway.com/databases/postgresql)
- [Railway Storage Buckets](https://docs.railway.com/storage-buckets)
- [Railway Environments](https://docs.railway.com/environments)

Northflank 也可以使用同一架构。它提供带 TLS、备份和 HA 选项的 PostgreSQL addon，并提供托管的
S3-compatible object storage；迁往 Northflank 只需替换连接配置：

- [Northflank PostgreSQL](https://northflank.com/docs/v1/application/databases-and-persistence/deploy-databases-on-northflank/deploy-postgresql-on-northflank)
- [Northflank Backup/Restore](https://northflank.com/docs/v1/application/databases-and-persistence/backup-restore-and-import-data)
- [Northflank Managed Object Storage](https://northflank.com/changelog/may-and-june-2026)

---

## 2. 可迁移边界

业务代码只认识两个标准服务：

```text
PostgreSQL 16+
S3-compatible Object Storage
```

禁止把下列 Railway/Northflank 概念写入领域模型：project ID、service ID、volume path、内部域名、
provider deployment ID。它们只存在于环境变量和部署配置中。

数据库只使用 PostgreSQL 自带能力：transaction、JSONB、复合外键、partial index、`SKIP LOCKED`。
v1 不依赖 pgvector、TimescaleDB 或供应商扩展。

对象存储只使用通用 S3 操作：

```text
PutObject / MultipartUpload
GetObject / HeadObject
DeleteObject（只供 GC）
Presigned GET/PUT
```

不使用某个平台私有的文件 API。Railway Bucket、Northflank Object Storage、AWS S3、Cloudflare R2、
以及自建 S3-compatible storage 都可以接入同一实现。

---

## 3. 唯一配置契约

应用只读取以下变量：

```text
FEDPLAT_DATABASE_URL=postgresql://...
FEDPLAT_ADMIN_TOKEN=至少24字符
FEDPLAT_ADMIN_AUTH_DISABLED=false        # development 当前设为 true，production 必须为 false
FEDPLAT_CORS_ORIGINS=https://fed-console.example

FEDPLAT_S3_ENDPOINT=https://...
FEDPLAT_S3_BUCKET=...
FEDPLAT_S3_REGION=...
FEDPLAT_S3_ACCESS_KEY_ID=...
FEDPLAT_S3_SECRET_ACCESS_KEY=...
FEDPLAT_S3_URL_STYLE=virtual        # 或 path

VITE_API_URL=https://fed-api.example
```

Railway/Northflank 提供的变量通过平台变量引用映射到这些名字。代码不判断自己运行在 Railway、
Northflank 还是自有服务器。

`FEDPLAT_S3_URL_STYLE` 必须保留：Railway 新 Bucket 使用 virtual-hosted style，而部分自建 S3 服务使用
path style。其余差异由 S3 client 处理。

本地密钥放在不提交 Git 的 `.env.local`；Railway production 使用平台 secrets。生产数据库保持私网，
只有 development 数据库为了本地开发开放 TLS 公网连接。

---

## 4. 本地开发方式

推荐流程：

```text
1. 在 Railway 创建 development environment
2. 创建一个 PostgreSQL 和一个 Bucket
3. 只给 development PostgreSQL 开 Public Access
4. 下载/映射 development 凭据到 .env.local
5. Mac 运行 FastAPI 与 Vite，直接连接远端 development 数据库和 Bucket
6. git push 后把同一镜像部署到 Railway，再将 FEDPLAT_DATABASE_URL 映射到私网连接
```

开发和 production 使用不同数据库、不同 Bucket、不同凭据，禁止本地代码直连 production。

新正式 schema 不使用 SQLite 模拟 PostgreSQL。SQLite 无法正确覆盖 JSONB、`SKIP LOCKED`、partial index
和复合约束。测试分两层：

- 无数据库的协议/状态机单元测试可直接在 Mac 运行；
- 数据库集成测试由 CI 启动临时 PostgreSQL，或手工连接 Railway development 环境。

旧 SQLite spike 已删除；正式中心数据库开发和集成测试均使用 PostgreSQL。

---

## 5. Railway 上的实际服务

首版只有五个资源：

| 资源 | 作用 | 是否持久化 |
|---|---|---|
| `fed-console` | React 管理控制台 | 否 |
| `fed-api` | FastAPI Site/Admin API | 否 |
| `fed-worker` | AgentJob、算法和 Delivery 后台处理 | 否 |
| `postgres` | 所有元数据、状态与审计 | Railway 数据库 volume |
| `artifacts` | Artifact bytes | Railway S3-compatible Bucket |

API 与 Worker 使用 `backend/` 的同一个 Docker image，只设置不同启动命令；Console 使用 `frontend/`
的独立镜像。不增加 Redis 或消息队列。

### Monorepo 独立发布

```text
fed-api      Root Directory /backend   Watch /backend/**
fed-worker   Root Directory /backend   Watch /backend/**
fed-console  Root Directory /frontend  Watch /frontend/**
```

Railway 的 Root Directory 让各服务只拿到对应目录作为构建上下文；Watch Paths 保证只改前端不会重建
API/Worker，只改后端也不会重建 Console。Dockerfile、健康检查、migration 和启动命令均按服务配置。
Railway 旧 Config as Code 已进入弃用期，因此仓库不再使用 `railway.json`；整个项目由
`.railway/railway.ts` 描述，并通过 `railway config plan/apply` 管理：
[Infrastructure as Code](https://docs.railway.com/infrastructure-as-code)、[Monorepo](https://docs.railway.com/deployments/monorepo)。

API/Worker 容器文件系统不保存有效数据，只允许使用有大小上限的 `/tmp`。Artifact 采用流式上传；大文件成熟后
再启用 multipart/presigned upload，接口仍然是同一个 S3 client。

Artifact 不放普通 Railway Volume：Bucket 是 S3-compatible、可独立迁移，而且不会让 API 服务绑定单机
volume。Railway Volume 当前不能由多个副本同时挂载，带 volume 的服务部署也有停机限制，更适合其
PostgreSQL 服务的数据盘，不适合我们的 Artifact 通道：

- [Railway Volumes](https://docs.railway.com/volumes/reference)

---

## 6. Schema migration

数据库 schema 使用仓库中的编号 SQL migration：

```text
migrations/
├─ 0001_registry_channel.sql
└─ 0002_release_delivery.sql
```

数据库维护 `schema_migrations(version, applied_at, checksum)`。同一 migration 内容发布后不可修改，
只能新增下一号 migration。

Railway 部署顺序：

```text
build image
→ 运行 fed-migrate
→ migration 成功才启动新 fed-api / fed-worker
```

Railway 的 Pre-deploy Command 正是为数据库 migration 提供的；命令失败时不会继续部署：
[Railway Pre-deploy Command](https://docs.railway.com/deployments/pre-deploy-command)。

破坏性 schema 变更使用 expand/contract：先加兼容字段，部署兼容代码，回填，再在之后的版本删除旧字段。

---

## 7. 备份

Railway PostgreSQL 数据在 volume 上，可配置自动 volume backup，也支持 PITR。Volume backup 主要用于
原环境恢复；真正可迁移的备份仍然是标准 `pg_dump`：

- [Railway Volume Backups](https://docs.railway.com/volumes/backups)
- [Railway Point-in-Time Recovery](https://docs.railway.com/volumes/point-in-time-recovery)
- [Railway PostgreSQL backup/restore](https://docs.railway.com/guides/postgres-backups-restores)

阶段策略：

```text
development   按需 volume backup；数据允许重建
pilot         每日 volume backup + 定期 pg_dump
production    PITR + 定期 pg_dump 到独立 S3-compatible bucket + 恢复演练
```

Artifact Bucket 由 digest 校验完整性。重要环境定期向第二个 S3-compatible bucket 做增量复制，并保存
PostgreSQL dump；只备份数据库、不备份 Artifact bytes，恢复后会产生大量失效引用。

---

## 8. 以后迁到自己的服务器

目标环境仍然只部署：

```text
fed-console（独立镜像）
fed-api / fed-worker（同一后端镜像）
PostgreSQL 16+
任一 S3-compatible Object Storage
```

最小迁移流程：

```text
1. 在自有服务器建 PostgreSQL 和 S3-compatible Bucket
2. 先做一次在线 Bucket 全量复制
3. 平台进入 maintenance，停止新写入和 Worker
4. Federation Node 暂存请求到本地 outbox，不丢数据
5. 做最后一次 Bucket 增量复制
6. Railway PostgreSQL 执行 pg_dump --format=custom
7. 自有 PostgreSQL 执行 pg_restore
8. 检查 schema version、记录数和 Artifact Head/digest
9. 将同一容器的 FEDPLAT_* 变量改到新服务并启动
10. 退出 maintenance；各站点自动续传 outbox
```

这个阶段允许一次短暂停机，利用 Federation Node 已有的离线重试能力，比提前建设双写或逻辑复制可靠。
以后真实数据量导致停机窗口不可接受时，再采用 PostgreSQL logical replication 和 S3 增量同步。

迁移不需要改表、改 Artifact key 或写 Railway 数据转换器。

---

## 9. 当前明确不做

- 不在 Mac 安装完整数据库栈。
- 不把生产 Artifact 放 API 容器磁盘或普通 volume。
- 不用 SQLite 作为 PostgreSQL 的生产兼容层。
- 不同时支持多个数据库产品；只支持 PostgreSQL。
- 不建设跨云双写、自动故障转移或 Kubernetes Operator。
- 不因未来可能自建而现在先买服务器和维护数据库。

当前已实现 psycopg 3、S3 client、编号 SQL migration 和上述环境变量契约；部署服务只需注入配置。
