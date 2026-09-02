# FedAgent Platform

我们自研 Agent 应用的多站点联邦通道。每个应用有一个独立联邦域，域内有独立 Federation Agent；平台统一收集、存储、任务、发布和回滚，不预设联邦的是 memory、skill 还是模型权重。

平台契约面向今后从零开发的新应用；未遵循契约的历史应用不是兼容目标。

- 产品意图：[INTENT.md](./INTENT.md)
- v1 架构与契约提案：[DESIGN.md](./DESIGN.md)
- 管理前端设计：[CONSOLE.md](./CONSOLE.md)
- 数据库与数据保存：[DATABASE.md](./DATABASE.md)
- Railway 托管部署与迁移：[DEPLOYMENT.md](./DEPLOYMENT.md)

## 代码状态

正式 v1 的管理与发布通道已经实现：

- FedApp Manifest、Application、Federation Agent 与算法绑定注册；
- 每个 Application 自动创建一个 Federation；
- Application-scoped Site API Key 与首次成功上传自动入域；
- 站点上传必带应用版本和实际使用的联邦版本，平台分别保存；
- PostgreSQL 编号 migration 与复合隔离约束；
- Railway/S3-compatible Artifact 存储；
- Artifact digest、大小、media type 和 metadata schema 校验；
- Artifact purpose（contribution / release / evaluation）与站点评测结果查询；
- 联邦算法使用的受保护 Artifact 读取与聚合结果写回接口；
- Submission、Event、AgentJob 同事务写入及幂等；
- 不可变 Release、站点 Delivery、stage/activate/rollback Command 与 Ack；
- PostgreSQL `SKIP LOCKED` Agent Worker；
- 新应用默认绑定 DeepSeek Harness Agent Core，配置与平台 memory 均带 revision；
- Harness 使用无 shell、无文件系统、无 skill/job 工具的 Cordis 组合，只能返回受校验意图；
- Application、拓扑、工件、发布、站点和应用级活动管理 API；
- 可独立部署的 React 管理控制台，应用内横向展示概览、版本、效果、时间线和日志。

旧 SQLite `Update / Digest / Plugin` spike 已删除，不提供兼容接口。DeepSeek Harness Agent Core 与 `manual` 回退已实现；Worker 可按域调用已安装、已版本化的联邦算法插件，输出仍是应用自定义 Artifact。

## 仓库结构

```text
backend/    FastAPI、Worker、migration、协议与测试
frontend/   React/Vite 管理控制台
```

Railway 的 `fed-api`、`fed-worker` 都监听 `/backend/**`，`fed-console` 只监听 `/frontend/**`；两个目录可以独立构建和更新。

## 本地运行

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e "./backend[dev]"

set -a
source .env.local
set +a

fed-migrate
uvicorn fedplat.app:app --reload
pytest backend/tests

cd frontend
npm install
npm run dev
```

配置模板见 [backend/.env.example](./backend/.env.example) 和 [frontend/.env.example](./frontend/.env.example)。正式中心数据库只支持 PostgreSQL，Artifact 内容只使用 S3-compatible storage。

## 当前 API

```text
GET  /health
GET  /ready

POST /admin/v1/apps
GET  /admin/v1/apps
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/agent
PUT  /admin/v1/apps/{app_id}/federations/{federation_id}/agent
PUT  /admin/v1/apps/{app_id}/federations/{federation_id}/agent/algorithm
POST /admin/v1/apps/{app_id}/federations/{federation_id}/agent/generations
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/agent/jobs/{job_id}
GET  /admin/v1/apps/{app_id}/topology
GET  /admin/v1/sites
GET  /admin/v1/activity
POST /admin/v1/apps/{app_id}/site-keys
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/submissions
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/evaluations
POST /admin/v1/apps/{app_id}/federations/{federation_id}/artifacts
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/artifacts/{digest}
POST /admin/v1/apps/{app_id}/federations/{federation_id}/releases
POST /admin/v1/apps/{app_id}/federations/{federation_id}/releases/generate
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/releases
GET  /admin/v1/apps/{app_id}/federations/{federation_id}/releases/{release_id}
POST /admin/v1/apps/{app_id}/federations/{federation_id}/releases/{release_id}/{stage|activate|rollback}

POST /site/v1/apps/{app_id}/artifacts  # Authorization + Idempotency-Key + X-App-Version
PUT  /site/v1/apps/{app_id}/status     # 独立上报应用版本和当前采用的联邦版本
GET  /site/v1/apps/{app_id}/commands
POST /site/v1/apps/{app_id}/commands/{command_id}/ack
```
