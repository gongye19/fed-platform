# Federation Console — 管理前端设计

状态：**v1 提案**  
用户：平台管理员、应用开发者、联邦运维人员  
首要问题：**当前注册了哪些应用，每个应用有哪些 Federation 和站点，联邦通道现在是否正常。**

---

## 1. 前端在平台里的位置

```text
Browser
  │
  │ /console/*       HTML / CSS / 少量 JavaScript
  │ /admin/v1/*      查询与管理动作
  ▼
FastAPI Control API
  ├─ Console 页面
  ├─ Admin API
  ├─ Registry / Release / Delivery
  └─ PostgreSQL / Object Storage
```

v1 不单独部署 Next.js，也不增加 BFF、GraphQL 或 WebSocket 服务。控制台由 FastAPI
服务端渲染，使用 Jinja2、原生 CSS 和少量 JavaScript；页面和 API 同域，复用管理员认证。
`/admin/v1` 保持独立契约，以后确实需要复杂交互时可以替换前端，不影响联邦协议。

控制台只管理平台，不进入各应用自己的业务页面。

---

## 2. 信息架构

```text
Federation Console
├─ Applications                         默认首页
│  └─ Application Detail
│     ├─ Overview                       Agent、Manifest、联邦拓扑
│     ├─ Artifacts                      Submission 与 Artifact
│     ├─ Releases                       Release、各站点 Delivery
│     └─ Settings                       Manifest 与插件绑定
├─ Sites                                跨应用站点目录
│  └─ Site Detail                       该站点加入的应用与 Federation
└─ Activity                             管理操作、任务失败、投递异常
```

v1 不做独立的“插件市场”和“AI Dashboard”。插件只在 Application/Federation 的设置中绑定；
首页只回答注册关系和运行状态，不堆没有行动价值的 KPI 卡片。

---

## 3. 默认首页：Applications

```text
┌──────────────────┬────────────────────────────────────────────────────────┐
│ FEDERATION       │ Applications                              [注册应用]   │
│                  │ 8 applications · 21 sites                              │
│ ● Applications   │                                                        │
│   Sites          │ [搜索 app_id / 名称] [状态] [刷新]                     │
│   Activity       │                                                        │
│                  │ APPLICATION       AGENT     FEDERATIONS  SITES  ATTENTION│
│                  │ Research Agent    Idle      2            5      —       │
│                  │ com.acme.research manual    main + 1                    │
│                  │                                                        │
│                  │ Model Trainer     Running   1            3      1 failed│
│                  │ com.acme.trainer  fedavg     main                        │
└──────────────────┴────────────────────────────────────────────────────────┘
```

每行显示：

- 应用名称、`app_id`、注册版本；
- AppFederationAgent 状态和当前 Agent Core；
- Federation 数量、去重后的成员站点数量；
- 最近一次联邦活动；
- 失败的 Job/Delivery 数量。只有异常才强调颜色。

点击整行进入应用详情。筛选和分页由服务端完成，URL 保留查询条件，页面可复制和刷新。

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

[Overview] [Artifacts] [Releases] [Settings]
```

Overview 先展示一棵真实关系树，而不是地理地图：

`Application → AppFederationAgent → Federation → Membership/Site`

同一个 Site 可出现在多个 Federation；界面必须按 Membership 分别展示权限，不能把站点在线等同于
它有提交、接收或执行任务的权限。

### Overview

- Federation 拓扑和成员权限；
- Agent Core、最近 Job、失败原因；
- 最近 Submission、Release 和 Delivery 异常；
- Manifest 中声明的 ArtifactType 与 TaskType。

### Artifacts

按 Federation、ArtifactType、来源站点和时间筛选。表格只显示 digest、类型、大小、来源、状态、
创建时间和引用关系。默认不渲染工件正文；有权限的管理员需显式点击下载。

### Releases

每个 Release 展示不可变版本、包含的 Artifact、目标站点及 Delivery 状态：

```text
pending → staged → active
                  └→ rolled_back
任意阶段可进入 failed，重试生成新的操作记录，不覆盖历史。
```

管理员可在此创建 manual release、stage、activate 和 rollback。破坏性或批量动作先展示目标站点，
要求二次确认，并显示操作结果。

### Settings

- 当前 FedApp Manifest revision；
- Agent Core Plugin 绑定；
- 各 Federation 的 Algorithm Plugin；
- 各 ArtifactType 的 Handler Plugin；
- 配置 revision、修改人和修改时间。

插件配置由后端根据 plugin schema 生成表单并校验；前端不解释插件业务语义。

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

Site Detail 展示：

- Federation Node 版本、最近心跳和凭据轮换状态；
- 它加入的 Application/Federation 及各自 Membership 权限；
- 待拉取 Command、最近 Delivery 和失败重试；
- 审计记录。

这里的跨应用视图只展示注册和健康信息；点击业务对象后必须回到相应 `app_id/federation_id` 上下文。

---

## 7. Activity

Activity 是统一的可筛选事件流：时间、级别、Application、Federation、Site、对象类型、动作和结果。
默认突出失败的 AgentJob、Task 和 Delivery，同时保留管理员注册、改权限、改插件、发布与回滚记录。

不把原始 prompt、工件正文或站点私有数据写入活动流。

---

## 8. 控制台专用查询

写操作复用 `DESIGN.md` 中的 Admin API。为避免首页逐行请求，增加少量只读聚合接口：

```text
GET /admin/v1/apps
GET /admin/v1/apps/{app_id}
GET /admin/v1/apps/{app_id}/topology
GET /admin/v1/apps/{app_id}/artifacts
GET /admin/v1/apps/{app_id}/releases
GET /admin/v1/apps/{app_id}/federations/{federation_id}
GET /admin/v1/sites
GET /admin/v1/sites/{site_id}
GET /admin/v1/activity
```

所有列表统一使用 `cursor / limit / q / status`；后端返回展示所需的计数和派生状态，前端不自行拼接权限、
健康度或 Delivery 状态。v1 在页面可见时每 15 秒轮询状态，支持手动刷新；有明确实时需求后再加 SSE。

---

## 9. 视觉与交互原则

- 方向：浅色“协议控制台”，不是深色赛博大屏；信息密度高，但不拥挤。
- 主色：墨色文字 `#172528`、雾灰背景 `#F3F6F6`、白色面板、青绿色动作色 `#087C75`。
- 状态色：琥珀表示等待/延迟，红色表示失败；正常状态不过度铺绿色。
- 字体：`IBM Plex Sans / PingFang SC`；ID、digest、版本使用 `IBM Plex Mono`。
- 形状：6px 圆角、细边框、无渐变；拓扑连接线是界面的识别元素。
- 桌面优先，最小支持 1024px；窄屏将侧栏折叠，表格允许横向滚动。
- 键盘可操作、焦点可见、颜色对比满足 WCAG AA；状态不能只通过颜色表达。
- 时间同时提供相对时间和完整时间 tooltip；ID 可一键复制。

---

## 10. v1 页面与验收

v1 只交付 7 个页面：

1. Application List；
2. Application Overview；
3. Application Artifacts；
4. Application Releases；
5. Federation Detail；
6. Site List / Detail；
7. Activity。

注册应用、建 Federation、添加 Site/Membership、手工 Release 和 rollback 使用同页表单或对话框，
不为每个动作单建页面。

验收标准：管理员能在三次点击内从 Application 找到任意 Federation/Site；能看到权限、最近在线时间、
Agent/Delivery 异常；能完成注册和手工发布全流程；任何页面都不会混合不同 Application 的联邦内容。
