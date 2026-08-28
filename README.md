# FedAgent Platform

我们自研 Agent 应用的多站点联邦通道。每个应用有独立 AppFederationAgent；平台统一收集、存储、任务、发布和回滚，不预设联邦的是 memory、skill 还是模型权重。

平台契约面向今后从零开发的新应用；未遵循契约的历史应用不是兼容目标。

- 产品意图：[INTENT.md](./INTENT.md)
- v1 架构与契约提案：[DESIGN.md](./DESIGN.md)
- 管理前端设计：[CONSOLE.md](./CONSOLE.md)
- 数据库与数据保存：[DATABASE.md](./DATABASE.md)
- Railway 托管部署与迁移：[DEPLOYMENT.md](./DEPLOYMENT.md)

## 代码状态

正式 v1 的第一个纵向切片已经实现：

- FedApp Manifest、Application、AppFederationAgent 注册；
- Site、Federation、Membership 和 Bearer credential；
- PostgreSQL 编号 migration 与复合隔离约束；
- Railway/S3-compatible Artifact 存储；
- Artifact digest、大小、media type 和 metadata schema 校验；
- Submission、Event、AgentJob 同事务写入及幂等；
- Application 列表、拓扑和 Submission 查询 API。

旧 SQLite `Update / Digest / Plugin` spike 已删除，不提供兼容接口。Release/Delivery、Worker、插件运行和管理前端尚未实现。

## 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

set -a
source .env.local
set +a

fed-migrate
uvicorn fedplat.app:app --reload
pytest
```

配置模板见 [.env.example](./.env.example)。正式中心数据库只支持 PostgreSQL，Artifact 内容只使用 S3-compatible storage。

## 当前 API

```text
GET  /health
GET  /ready

POST /admin/v1/apps
GET  /admin/v1/apps
GET  /admin/v1/apps/{app_id}/topology
POST /admin/v1/sites
POST /admin/v1/apps/{app_id}/federations
PUT  /admin/v1/apps/{app_id}/federations/{federation_id}/memberships/{site_id}
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/submissions

POST /site/v1/apps/{app_id}/federations/{federation_id}/artifacts
```
