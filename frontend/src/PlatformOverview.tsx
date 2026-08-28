import { useState } from "react";
import {
  Background,
  BackgroundVariant,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";

const moduleDetails = {
  application: {
    category: "应用层",
    title: "联邦应用",
    summary: "平台可以注册多个应用。每个应用声明自己的工件、任务和协议版本，应用之间完全隔离。",
    scope: "app_id",
    inputs: ["应用清单"],
    outputs: ["独立联邦代理"],
  },
  agent: {
    category: "应用联邦代理层",
    title: "应用联邦代理",
    summary: "每注册一个应用，平台就为它配置一个独立联邦代理，只负责该应用内各站点的聚合与分发。",
    scope: "一个应用对应一个代理",
    inputs: ["站点提交", "联邦任务"],
    outputs: ["聚合结果", "发布版本"],
  },
  federation: {
    category: "联邦域层",
    title: "联邦域",
    summary: "联邦域是应用内部的站点协作边界。一个应用可以有多个联邦域，站点通过成员关系加入。",
    scope: "app_id + federation_id",
    inputs: ["成员关系", "站点权限"],
    outputs: ["可参与站点集合"],
  },
  site: {
    category: "站点层",
    title: "应用站点",
    summary: "每个站点只向所属应用提交数据。平台聚合的是同一应用、同一联邦域内不同站点的内容。",
    scope: "site_id + membership",
    inputs: ["发布指令", "工件地址"],
    outputs: ["工件", "事件", "确认回执"],
  },
  gateway: {
    category: "数据接入",
    title: "接入与校验",
    summary: "统一接收站点提交，并校验凭据、成员权限、类型、格式版本、大小和摘要。",
    scope: "站点到平台的信任边界",
    inputs: ["工件", "事件", "幂等键"],
    outputs: ["合法提交记录"],
  },
  storage: {
    category: "平台存储",
    title: "工件与状态存储",
    summary: "关系数据库保存关系、状态和审计；对象存储保存不可变工件内容，两者通过摘要关联。",
    scope: "按应用和联邦域隔离",
    inputs: ["元数据", "工件内容"],
    outputs: ["工件记录", "对象地址"],
  },
  strategy: {
    category: "插件位置",
    title: "联邦策略插件",
    summary: "应用联邦代理调用绑定的策略插件。记忆、技能、模型权重都可以使用不同策略实现。",
    scope: "按应用绑定",
    inputs: ["同一联邦域的工件集合"],
    outputs: ["联邦结果工件"],
  },
  delivery: {
    category: "结果分发",
    title: "发布与投递",
    summary: "把联邦结果组成不可变发布版本，为目标站点创建投递并跟踪暂存、启用、失败和回滚。",
    scope: "release_id + site_id",
    inputs: ["结果工件", "目标站点"],
    outputs: ["发布指令", "投递状态"],
  },
} as const;

type ModuleId = keyof typeof moduleDetails;
type DiagramNodeData = {
  title: string;
  subtitle: string;
  moduleId: ModuleId;
  kind: "application" | "agent" | "federation" | "site" | "service";
};
type LayerNodeData = { title: string; subtitle: string; tone: "plain" | "platform" | "sites" };
type PlatformNode = Node<DiagramNodeData, "platform">;
type LayerNode = Node<LayerNodeData, "layer">;
type DiagramNode = PlatformNode | LayerNode;

function PlatformDiagramNode({ data, selected }: NodeProps<PlatformNode>) {
  return (
    <div className={`flow-node flow-node--${data.kind}${selected ? " selected" : ""}`}>
      <Handle id="top" type="target" position={Position.Top} />
      <Handle id="left" type="target" position={Position.Left} />
      <span className="flow-node__mark" aria-hidden="true" />
      <span className="flow-node__copy"><strong>{data.title}</strong><small>{data.subtitle}</small></span>
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="right" type="source" position={Position.Right} />
    </div>
  );
}

function DiagramLayerNode({ data }: NodeProps<LayerNode>) {
  return (
    <div className={`flow-layer flow-layer--${data.tone}`}>
      <strong>{data.title}</strong>
      <span>{data.subtitle}</span>
    </div>
  );
}

const nodeTypes: NodeTypes = { platform: PlatformDiagramNode, layer: DiagramLayerNode };
const marker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#747b88" } as const;
const activeMarker = { ...marker, color: "#7c86ea" } as const;

function verticalEdge(id: string, source: string, target: string, label?: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "bottom",
    targetHandle: "top",
    type: "smoothstep",
    label,
    markerEnd: marker,
    style: { stroke: "#747b88", strokeWidth: 1.2 },
  };
}

function horizontalEdge(id: string, source: string, target: string, label?: string, dashed = false): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "right",
    targetHandle: "left",
    type: "smoothstep",
    label,
    animated: !dashed,
    markerEnd: activeMarker,
    style: { stroke: "#7c86ea", strokeWidth: 1.35, strokeDasharray: dashed ? "5 5" : undefined },
  };
}

const hierarchyNodes: DiagramNode[] = [
  { id: "layer-app", type: "layer", position: { x: 0, y: 0 }, data: { title: "01  应用层", subtitle: "平台上注册多个独立应用", tone: "plain" }, style: { width: 1200, height: 116 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-agent", type: "layer", position: { x: 0, y: 136 }, data: { title: "02  应用联邦代理层", subtitle: "每个应用一对一配置独立代理", tone: "platform" }, style: { width: 1200, height: 126 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-federation", type: "layer", position: { x: 0, y: 282 }, data: { title: "03  联邦域层", subtitle: "代理管理本应用的一个或多个联邦域", tone: "platform" }, style: { width: 1200, height: 126 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-sites", type: "layer", position: { x: 0, y: 428 }, data: { title: "04  站点层", subtitle: "不同站点通过成员关系加入所属应用", tone: "sites" }, style: { width: 1200, height: 176 }, selectable: false, focusable: false, draggable: false },

  ...(["A", "B", "N"] as const).map((suffix, index): PlatformNode => ({
    id: `app-${suffix}`,
    type: "platform",
    parentId: "layer-app",
    extent: "parent",
    position: { x: 150 + index * 340, y: 40 },
    data: { title: `应用 ${suffix}`, subtitle: "声明该应用的联邦契约", moduleId: "application", kind: "application" },
    style: { width: 220, height: 58 },
    ariaLabel: `应用 ${suffix}`,
  })),
  ...(["A", "B", "N"] as const).map((suffix, index): PlatformNode => ({
    id: `agent-${suffix}`,
    type: "platform",
    parentId: "layer-agent",
    extent: "parent",
    position: { x: 150 + index * 340, y: 44 },
    data: { title: `应用联邦代理 ${suffix}`, subtitle: `仅服务应用 ${suffix}`, moduleId: "agent", kind: "agent" },
    style: { width: 220, height: 58 },
    ariaLabel: `应用 ${suffix} 的联邦代理`,
  })),
  ...(["A", "B", "N"] as const).map((suffix, index): PlatformNode => ({
    id: `federation-${suffix}`,
    type: "platform",
    parentId: "layer-federation",
    extent: "parent",
    position: { x: 150 + index * 340, y: 44 },
    data: { title: `联邦域 ${suffix}`, subtitle: `隔离应用 ${suffix} 的站点数据`, moduleId: "federation", kind: "federation" },
    style: { width: 220, height: 58 },
    ariaLabel: `应用 ${suffix} 的联邦域`,
  })),
  ...(["A", "B", "N"] as const).flatMap((app, appIndex) =>
    [1, 2, 3].map((site, siteIndex): PlatformNode => ({
      id: `site-${app}-${site}`,
      type: "platform",
      parentId: "layer-sites",
      extent: "parent",
      position: { x: 112 + appIndex * 340 + siteIndex * 104, y: 70 },
      data: { title: `站点 ${app}-${site}`, subtitle: `属于应用 ${app}`, moduleId: "site", kind: "site" },
      style: { width: 96, height: 58 },
      ariaLabel: `应用 ${app} 的站点 ${site}`,
    })),
  ),
];

const hierarchyEdges: Edge[] = (["A", "B", "N"] as const).flatMap((suffix) => [
  verticalEdge(`app-agent-${suffix}`, `app-${suffix}`, `agent-${suffix}`, "一对一创建"),
  verticalEdge(`agent-federation-${suffix}`, `agent-${suffix}`, `federation-${suffix}`, "管理"),
  ...[1, 2, 3].map((site) => verticalEdge(`federation-site-${suffix}-${site}`, `federation-${suffix}`, `site-${suffix}-${site}`, site === 2 ? "一对多" : undefined)),
]);

const flowNodes: DiagramNode[] = [
  { id: "flow-source", type: "layer", position: { x: 0, y: 0 }, data: { title: "站点提交", subtitle: "同一应用的多个站点", tone: "sites" }, style: { width: 230, height: 500 }, selectable: false, focusable: false, draggable: false },
  { id: "flow-platform", type: "layer", position: { x: 250, y: 0 }, data: { title: "联邦平台控制面", subtitle: "按应用和联邦域隔离处理", tone: "platform" }, style: { width: 700, height: 500 }, selectable: false, focusable: false, draggable: false },
  { id: "flow-target", type: "layer", position: { x: 970, y: 0 }, data: { title: "站点接收", subtitle: "目标站点拉取并确认", tone: "sites" }, style: { width: 230, height: 500 }, selectable: false, focusable: false, draggable: false },

  ...[1, 2, 3].map((site, index): PlatformNode => ({
    id: `submit-site-${site}`,
    type: "platform",
    parentId: "flow-source",
    extent: "parent",
    position: { x: 52, y: 92 + index * 116 },
    data: { title: `站点 A-${site}`, subtitle: "提交本地工件", moduleId: "site", kind: "site" },
    style: { width: 126, height: 58 },
    ariaLabel: `提交数据的站点 A-${site}`,
  })),
  { id: "gateway", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 38, y: 194 }, data: { title: "接入与校验", subtitle: "权限、格式、摘要", moduleId: "gateway", kind: "service" }, style: { width: 138, height: 66 }, ariaLabel: "接入与校验" },
  { id: "storage", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 202, y: 194 }, data: { title: "工件与状态存储", subtitle: "数据库 + 对象存储", moduleId: "storage", kind: "service" }, style: { width: 142, height: 66 }, ariaLabel: "工件与状态存储" },
  { id: "flow-agent", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 370, y: 194 }, data: { title: "应用联邦代理", subtitle: "聚合本应用站点数据", moduleId: "agent", kind: "agent" }, style: { width: 142, height: 66 }, ariaLabel: "应用联邦代理" },
  { id: "delivery", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 538, y: 194 }, data: { title: "发布与投递", subtitle: "生成版本并分发", moduleId: "delivery", kind: "service" }, style: { width: 126, height: 66 }, ariaLabel: "发布与投递" },
  { id: "strategy", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 370, y: 324 }, data: { title: "联邦策略插件", subtitle: "可替换算法与处理器", moduleId: "strategy", kind: "service" }, style: { width: 142, height: 62 }, ariaLabel: "联邦策略插件" },
  ...[1, 2, 3].map((site, index): PlatformNode => ({
    id: `receive-site-${site}`,
    type: "platform",
    parentId: "flow-target",
    extent: "parent",
    position: { x: 52, y: 92 + index * 116 },
    data: { title: `站点 A-${site}`, subtitle: "拉取版本并确认", moduleId: "site", kind: "site" },
    style: { width: 126, height: 58 },
    ariaLabel: `接收结果的站点 A-${site}`,
  })),
];

const flowEdges: Edge[] = [
  ...[1, 2, 3].map((site) => horizontalEdge(`submit-gateway-${site}`, `submit-site-${site}`, "gateway", site === 2 ? "提交" : undefined)),
  horizontalEdge("gateway-storage", "gateway", "storage", "入库"),
  horizontalEdge("storage-agent", "storage", "flow-agent", "聚合"),
  horizontalEdge("agent-delivery", "flow-agent", "delivery", "生成结果"),
  horizontalEdge("agent-strategy", "flow-agent", "strategy", "调用策略", true),
  ...[1, 2, 3].map((site) => horizontalEdge(`delivery-site-${site}`, "delivery", `receive-site-${site}`, site === 2 ? "分发" : undefined)),
];

function FixedDiagram({ kind, nodes, edges, onSelect }: {
  kind: "hierarchy" | "flow";
  nodes: DiagramNode[];
  edges: Edge[];
  onSelect: (id: ModuleId) => void;
}) {
  const onNodeClick: NodeMouseHandler<DiagramNode> = (_event, node) => {
    if (node.type === "platform") onSelect(node.data.moduleId);
  };

  return (
    <div className="fixed-diagram-scroll">
      <div className={`react-flow-canvas react-flow-canvas--${kind}`}>
        <ReactFlow<DiagramNode, Edge>
          defaultNodes={nodes}
          defaultEdges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          fitViewOptions={{ padding: 0.04 }}
          minZoom={0.2}
          maxZoom={1}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          nodesDraggable={false}
          nodesConnectable={false}
          edgesReconnectable={false}
          edgesFocusable={false}
          deleteKeyCode={null}
          colorMode="dark"
          proOptions={{ hideAttribution: true }}
          ariaLabelConfig={{ "node.a11yDescription.default": "按回车选择节点，使用方向键在节点间移动" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="rgba(255,255,255,.045)" />
        </ReactFlow>
      </div>
    </div>
  );
}

function ArchitectureInspector({ selected }: { selected: ModuleId }) {
  const detail = moduleDetails[selected];
  return (
    <section className="architecture-inspector" aria-live="polite" aria-atomic="true">
      <div className="architecture-inspector__summary" key={selected}><span>{detail.category}</span><h2>{detail.title}</h2><p>{detail.summary}</p></div>
      <dl>
        <div><dt>作用范围</dt><dd><code>{detail.scope}</code></dd></div>
        <div><dt>接收</dt><dd>{detail.inputs.map((value) => <span key={value}>{value}</span>)}</dd></div>
        <div><dt>产出</dt><dd>{detail.outputs.map((value) => <span key={value}>{value}</span>)}</dd></div>
      </dl>
    </section>
  );
}

export default function PlatformOverview() {
  const [hierarchySelected, setHierarchySelected] = useState<ModuleId>("agent");
  const [flowSelected, setFlowSelected] = useState<ModuleId>("gateway");

  return (
    <div className="landing">
      <header className="landing__header">
        <div><p className="eyebrow">平台概览</p><h1 id="platform-title">联邦平台架构</h1><p>应用彼此隔离；每个应用拥有独立联邦代理，只聚合该应用各站点的数据。</p></div>
      </header>

      <section className="architecture-workbench" id="platform-architecture" aria-labelledby="hierarchy-title">
        <div className="architecture-workbench__bar"><div><h2 id="hierarchy-title">组织层级</h2><span>应用、代理、联邦域与站点的归属关系</span></div><small>点击节点查看说明</small></div>
        <FixedDiagram kind="hierarchy" nodes={hierarchyNodes} edges={hierarchyEdges} onSelect={setHierarchySelected} />
        <ArchitectureInspector selected={hierarchySelected} />
      </section>

      <section className="architecture-workbench architecture-workbench--following" id="platform-data-flow" aria-labelledby="flow-title">
        <div className="architecture-workbench__bar"><div><h2 id="flow-title">数据流动</h2><span>同一应用内从站点提交到结果分发的完整通道</span></div><small>点击节点查看说明</small></div>
        <FixedDiagram kind="flow" nodes={flowNodes} edges={flowEdges} onSelect={setFlowSelected} />
        <ArchitectureInspector selected={flowSelected} />
      </section>
    </div>
  );
}
