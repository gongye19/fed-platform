# Federation Console — 管理前端设计

状态：**v1 管理通道已实现**
用户：平台管理员、应用开发者、联邦运维人员  
首要问题：**整个平台如何工作；当前注册了哪些应用，每个应用有哪些 Federation 和站点，联邦通道是否正常。**

---

## 1. 前端在平台里的位置

```text
Browser
  │
  │ HTTPS
  ▼
fed-console（frontend/，React + Vite）
  │ /admin/v1/*      查询与管理动作
  ▼
fed-api（backend/，FastAPI）
  ├─ Admin / Site API
  ├─ Registry / Release / Delivery
  └─ PostgreSQL / Object Storage
```

控制台和后端分别位于 `frontend/`、`backend/`，在 Railway 是两个可独立监控、构建和发布的服务。
前端使用 React + Vite，直接调用稳定的 `/admin/v1` 契约；不增加 Next.js、BFF、GraphQL、组件库或
WebSocket。development 通过 `FEDPLAT_ADMIN_AUTH_DISABLED=true` 免登录；production 必须关闭该开关并恢复管理员认证。

控制台只管理平台，不进入各应用自己的业务页面。

---

## 2. 信息架构

```text
Federation Console
├─ Platform Overview                    默认首页；平台架构与端到端联邦流程
├─ Applications
│  └─ Application Detail
│     ├─ Overview                       Agent、Manifest、联邦拓扑
│     ├─ Artifacts                      Submission 与 Artifact
│     ├─ Releases                       Release、各站点 Delivery
│     └─ Contract                       Manifest 与声明能力
├─ Sites                                跨应用站点目录
└─ Activity                             管理操作、任务失败、投递异常
```

v1 不做独立的“插件市场”和“AI Dashboard”。插件配置等插件契约冻结后再进入应用设置；
概览页解释稳定的平台边界与数据流，不展示虚构 KPI。

---

## 3. 默认首页：平台概览

```text
联邦平台（统一协议与应用注册）
  ├──────────────┬──────────────┐
应用 A             应用 B             应用 N
  │                  │                  │
联邦域 A            联邦域 B            联邦域 N
[Agent A]           [Agent B]           [Agent N]
  ↕  ↕  ↕             ↕  ↕                ↕  ↕
站点 A-1/2/3         站点 B-1/2/3        站点 N-1/2/3
```

概览页是一个可交互的架构工作台，回答三个问题：

- 归属关系：平台注册多个应用；应用的联邦 Agent 运行在所属联邦域内部，并连接该域的站点；
- 聚合边界：只聚合同一 `app_id + federation_id` 内不同站点的内容；
- 数据通道：站点提交 → 检查 → 保存 → 应用联邦 Agent / 处理插件 → 结果分发 → 站点确认。

页面在同一页依次展示“组织层级”和“数据流动”：组织关系在上，端到端数据通道在下。两个图使用固定画布，
不提供平移、缩放或节点拖拽；两者使用一致的动态流线，节点仍可点击，下方只展示面向非专业用户的通俗说明。

概览不请求业务数据，也不混入实时运行指标。应用目录位于 `/apps`，负责查询、注册及进入应用详情。

---

## 4. Application Detail

```text
Applications / Research Agent

Research Agent                         v1.4.0   Agent: Idle   [管理]
com.acme.research

┌─ Federation topology ─────────────────────────────────────────────────────┐
│ App Federation Agent: manual-channel                                     │
│                                                                          │
│ ├─ main                 Artifact: observation, skill                     │
│ │  ├─ site-hk-01        online   submit / receive / execute              │
│ │  ├─ site-sg-01        online   submit / receive                        │
│ │  └─ site-tokyo-01     delayed  receive                                 │
│ └─ private-lab          Artifact: model-lora                             │
│    ├─ lab-a             online   submit / receive                        │
│    └─ lab-b             offline  submit / receive                        │
└──────────────────────────────────────────────────────────────────────────┘

[Topology] [Artifacts] [Releases] [Contract]
```

Overview 先展示一棵真实关系树，而不是地理地图：

`Application → AppFederationAgent → Federation → Membership/Site`

同一个 Site 可出现在多个 Federation；界面必须按 Membership 分别展示权限，不能把站点在线等同于
它有提交、接收或执行任务的权限。

### Overview

- Federation 拓扑和成员权限；
- Agent Core 与运行状态；
- Federation/Site 关系和 submit/receive/execute 权限。

### Artifacts

按 Federation 展示 Submission。表格只显示 digest、类型、大小、来源、状态和创建时间，
默认不渲染工件正文。

### Releases

每个 Release 展示不可变版本、包含的 Artifact、目标站点及 Delivery 状态：

```text
pending → staged → active
                  └→ rolled_back
任意阶段可进入 failed，重试生成新的操作记录，不覆盖历史。
```

管理员可在此创建 manual release、stage、activate 和 rollback。破坏性或批量动作先展示目标站点，
要求二次确认，并显示操作结果。

### Contract

- 当前 FedApp Manifest；
- Adapter protocol；
- ArtifactType 与 TaskType 声明；
- 原始只读 JSON。

插件配置 UI 暂不生成；等第一个真实插件确定 schema 后再加入，不提前设计一套空表单框架。

---

## 5. Federation Detail

从拓扑中的 Federation 进入，页面只关注一个 `(app_id, federation_id)`：

| 区域 | 内容 |
|---|---|
| Memberships | Site、submit/receive/execute_task、加入时间、凭据状态 |
| Channel | 最近 Submission、Task、Release、Delivery |
| Plugins | Algorithm 与 Artifact Handler 的实际绑定版本 |
| Activity | 此 Federation 的 Job、错误和审计事件 |

成员权限用文本和可访问的勾选状态表示，不能只靠颜色。新增/移除成员是显式管理动作；移除成员不删除
历史 Artifact、Release 或审计记录。

---

## 6. Sites

Sites 是跨应用目录，用于回答“这个站点参与了什么”，但不在站点层 union 数据。

```text
SITE             NODE       APPLICATIONS  MEMBERSHIPS  LAST SEEN   ATTENTION
site-hk-01       online     3             4            24s ago     —
lab-b            offline    1             1            2h ago      2 pending
```

当前 Site List 展示 Federation Node 最近连接时间、应用数、Membership 数和待拉取 Command 数。
跨应用视图只展示注册和健康信息，不 union 业务数据。

---

## 7. Activity

Activity 是按时间倒序的统一事件流：Application、Federation、Site、对象类型、动作和结果。
它合并管理员注册、权限、发布操作与站点 Delivery 事件。

不把原始 prompt、工件正文或站点私有数据写入活动流。

---

## 8. 控制台专用查询

写操作复用 `DESIGN.md` 中的 Admin API。为避免首页逐行请求，增加少量只读聚合接口：

```text
GET /admin/v1/apps
GET /admin/v1/apps/{app_id}/topology
GET /admin/v1/apps/{app_id}/federations/{federation_id}/submissions
GET /admin/v1/apps/{app_id}/federations/{federation_id}/releases
GET /admin/v1/sites
GET /admin/v1/activity
```

后端返回展示所需的计数和 Delivery 状态，前端提供手动刷新；有明确实时需求后再加轮询或 SSE。

---

## 9. 视觉与交互原则

- 方向：Linear 风格的深色协议控制台；克制、结构清晰、信息密度高。
- 主色：近黑背景 `#08090A`、分层深色面板、紫色动作色 `#5E6AD2`。
- 状态色：琥珀表示等待/延迟，红色表示失败；正常状态不过度铺绿色。
- 字体：自托管 Geist Sans；ID、digest、版本使用 Geist Mono。
- 形状：6/12px 圆角、细边框、轻量层次；拓扑和架构连接线是识别元素。
- 桌面优先，最小支持 1024px；窄屏将侧栏折叠，表格允许横向滚动。
- 键盘可操作、焦点可见、颜色对比满足 WCAG AA；状态不能只通过颜色表达。
- 时间同时提供相对时间和完整时间 tooltip；ID 可一键复制。

---

## 10. 设计与实现来源

- [ConardLi/garden-skills](https://github.com/ConardLi/garden-skills) 的 `web-design-engineer`：用于设计审查流程、Linear 视觉方向和交付检查；只作为开发方法，不是运行时依赖。
- [Vercel Geist](https://vercel.com/font)：控制台的 Sans/Mono 字体；通过 Fontsource 包随前端构建，自托管、不依赖外部字体 CDN。
- [Grafana Node Graph](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/)：参考可预测的分层节点布局及点击节点显示上下文信息。
- [Datadog Service Map](https://docs.datadoghq.com/tracing/services/services_map/)：参考选中依赖节点后聚焦检查的交互方式。
- [Backstage Catalog Graph](https://backstage.io/docs/features/software-catalog/creating-the-catalog-graph/)：参考以实体与关系表达平台心智模型。
- [React Flow](https://reactflow.dev/)：运行时节点图库，用于分层容器、父子节点、连线、节点选择、平移与缩放；布局和节点内容由本项目定义。
- React + Vite：延续仓库既有前端栈；其余界面继续使用语义化 React 与项目 CSS。

---

## 11. v1 页面与验收

v1 管理通道交付以下视图：

1. Platform Overview；
2. Application List；
3. Application Overview；
4. Application Artifacts；
5. Application Releases；
6. Application Contract；
7. Site List；
8. Activity。

注册应用、建 Federation、添加 Site/Membership、手工 Release 和 rollback 使用同页表单或对话框，
不为每个动作单建页面。

验收标准：管理员能在三次点击内从 Application 找到任意 Federation/Site；能看到权限、最近在线时间、
Agent/Delivery 异常；能完成注册和手工发布全流程；任何页面都不会混合不同 Application 的联邦内容。
