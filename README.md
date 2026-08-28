# FedAgent Platform

我们自研 Agent 应用的多站点联邦通道。每个应用有独立 AppFederationAgent；平台统一收集、存储、任务、发布和回滚，不预设联邦的是 memory、skill 还是模型权重。

平台契约面向今后从零开发的新应用；未遵循契约的历史应用不是兼容目标。

- 产品意图：[INTENT.md](./INTENT.md)
- v1 架构与契约提案：[DESIGN.md](./DESIGN.md)
- 管理前端设计：[CONSOLE.md](./CONSOLE.md)
- 数据库与数据保存：[DATABASE.md](./DATABASE.md)
- Railway 托管部署与迁移：[DEPLOYMENT.md](./DEPLOYMENT.md)

## 代码状态

当前 Python 代码是一个连通性 spike，已验证：

- 应用/站点注册
- Bearer key 认证
- 上行幂等
- 按应用与类型分仓

其 `Update / Digest / Plugin` 接口不是已冻结的 v1 协议。新契约完成技术评审后再替换实现，不在 spike 上继续叠加兼容层。

## 运行 spike

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
FEDPLAT_DB=fedplat.db uvicorn fedplat.app:app --reload
pytest
```
