# Federation Console — 管理前端设计

状态：**v1 管理通道已实现**
用户：平台管理员、应用开发者、联邦运维人员  
首要问题：**整个平台如何工作；当前注册了哪些应用，每个应用有哪些站点，联邦通道是否正常。**

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
│     ├─ Overview                       自动接入的成员站点
│     ├─ Versions                       当前联邦版本与各站点分发状态
│     ├─ Evaluations                    每轮各站点的联邦前后效果
│     ├─ Timeline                       联邦过程的可读时间线
│     └─ Logs                           平台活动与站点上传日志
```

左侧“应用”只展开已注册应用，不再嵌套功能菜单；选中具体应用后，以上应用级导航显示在内容区顶部。
站点和活动不作为平台级入口，避免把不同应用的数据混在一起。

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

Research Agent                         v1.4.0   Agent: Idle
com.acme.research

SITE             APPLICATION VERSION  STATUS    LAST UPLOAD
site-hk-01       1.4.0                online    24s ago
site-sg-01       1.3.2                online    2m ago

内容区横向菜单：概览 / 版本 / 效果 / 时间线 / 日志
```

### Overview

- 只展示已成功上传并自动加入本应用域的站点；
- 应用版本来自站点上传的 `X-App-Version`；
- 展示连接状态与最后上传时间，不显示内部权限字段。

### Logs

合并平台操作、站点事件和 Artifact 上传记录，按时间倒序展示；不渲染工件正文。

### Versions

版本页是版本管理工作台：左侧逐站点显示本轮是否有新提交并触发联邦生成，右侧选择不可变
Release 下发，下方显示站点实际上报的当前使用版本。

```text
pending → staged → active
                  └→ rolled_back
任意阶段可进入 failed，重试生成新的操作记录，不覆盖历史。
```

“下发”只创建 `release.stage` 命令，不代表站点启用。站点是否使用由站点自己决定，平台只把它
下一次上传携带的 `X-Federation-Version` 作为当前使用版本。

---

## 5. Federation

每个 Application 只有一个 Federation，因此不提供独立 Federation 页面，也不提供新建域或配置成员按钮。
部署流程签发应用站点 Key；站点第一次成功上传后自动出现在 Overview。

---

## 6. Sites（概览内）

Sites 位于具体应用下，展示该应用唯一 Federation 的成员站点，不在站点层 union 数据。

```text
SITE             APPLICATION VERSION  STATUS    LAST UPLOAD
site-hk-01       1.4.0                online    24s ago
lab-b            1.3.2                offline   2h ago
```

当前 Site List 展示站点部署的应用版本、连接状态和最近上传时间。

---

## 7. Logs

Logs 是当前应用按时间倒序的事件流：Federation、Site、对象类型、动作和结果。
时间线过滤出站点事件与发布里程碑；日志保留该应用最近 100 条平台操作和站点上传记录。

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
GET /admin/v1/activity?app_id={app_id}
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
3. Application Overview（含站点）；
4. Application Versions；
5. Application Evaluations；
6. Application Timeline；
7. Application Logs（含上传记录）。

验收标准：管理员能在三次点击内从 Application 找到任意 Site；能看到应用版本、最近上传时间和
Agent/Delivery 异常；任何页面都不会混合不同 Application 的联邦内容。
