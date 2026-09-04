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
  platform: {
    title: "联邦平台",
    summary: "联邦平台提供所有应用共同遵守的协议，并负责注册和管理这些应用。每个应用都在这套协议上连接自己的站点。",
  },
  application: {
    title: "应用",
    summary: "应用按照联邦平台的协议开发并注册到平台。每个应用各自管理联邦域和站点，彼此不会混在一起。",
  },
  agent: {
    title: "应用联邦 Agent",
    summary: "应用的联邦 Agent 运行在所属联邦域内部。它收集域内各站点提交的内容，完成联邦处理，再把结果发回需要的站点。",
  },
  federation: {
    title: "联邦域",
    summary: "联邦域把同一个应用中需要协作的站点组织在一起。每个应用只有一个独立的联邦域。",
  },
  site: {
    title: "站点",
    summary: "站点是实际运行应用的地方。各站点提交自己的内容，并接收联邦处理后的结果。",
  },
  gateway: {
    title: "接收与检查",
    summary: "站点上传内容后，平台会先确认站点身份和使用权限，再检查内容格式是否正确、数据是否完整。",
  },
  storage: {
    title: "数据保存",
    summary: "通过检查的内容和处理进度会被保存，后续 Agent 可以继续使用，整个过程也可以追踪。",
  },
  strategy: {
    title: "联邦算法",
    summary: "联邦算法为 Agent 提供具体处理方式，例如汇总经验、同步 Skill 或合并模型权重，并且可以替换和扩展。",
  },
  delivery: {
    title: "结果分发",
    summary: "联邦完成后，平台把结果发给指定站点，并记录站点是否收到、启用或遇到问题。",
  },
} as const;

type ModuleId = keyof typeof moduleDetails;
type DiagramNodeData = {
  title: string;
  subtitle: string;
  moduleId: ModuleId;
};
type LayerNodeData = { title: string; subtitle: string; tone: "plain" | "platform" | "sites" };
type PlatformNode = Node<DiagramNodeData, "platform">;
type LayerNode = Node<LayerNodeData, "layer">;
type DiagramNode = PlatformNode | LayerNode;

function PlatformDiagramNode({ data, selected }: NodeProps<PlatformNode>) {
  return (
    <div className={`flow-node${selected ? " selected" : ""}`}>
      <Handle id="top" type="target" position={Position.Top} />
      <Handle id="top-source" type="source" position={Position.Top} />
      <Handle id="top-down" type="target" position={Position.Top} style={{ left: "44%" }} />
      <Handle id="top-up" type="source" position={Position.Top} style={{ left: "56%" }} />
      <Handle id="left" type="target" position={Position.Left} />
      <Handle id="left-top" type="target" position={Position.Left} style={{ top: "20%" }} />
      <Handle id="left-middle" type="target" position={Position.Left} style={{ top: "50%" }} />
      <Handle id="left-bottom" type="target" position={Position.Left} style={{ top: "80%" }} />
      <span className="flow-node__copy"><strong>{data.title}</strong><small>{data.subtitle}</small></span>
      <Handle id="bottom" type="source" position={Position.Bottom} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} />
      <Handle id="bottom-app-left" type="source" position={Position.Bottom} style={{ left: "15.91%" }} />
      <Handle id="bottom-app-center" type="source" position={Position.Bottom} style={{ left: "50%" }} />
      <Handle id="bottom-app-right" type="source" position={Position.Bottom} style={{ left: "84.09%" }} />
      <Handle id="bottom-site-left" type="source" position={Position.Bottom} style={{ left: "15.33%" }} />
      <Handle id="bottom-site-center" type="source" position={Position.Bottom} style={{ left: "48.67%" }} />
      <Handle id="bottom-site-right" type="source" position={Position.Bottom} style={{ left: "82%" }} />
      <Handle id="bottom-site-left-in" type="target" position={Position.Bottom} style={{ left: "19.19%" }} />
      <Handle id="bottom-site-center-in" type="target" position={Position.Bottom} style={{ left: "52.52%" }} />
      <Handle id="bottom-site-right-in" type="target" position={Position.Bottom} style={{ left: "85.86%" }} />
      <Handle id="right" type="source" position={Position.Right} />
      <Handle id="right-top" type="source" position={Position.Right} style={{ top: "20%" }} />
      <Handle id="right-middle" type="source" position={Position.Right} style={{ top: "50%" }} />
      <Handle id="right-bottom" type="source" position={Position.Right} style={{ top: "80%" }} />
    </div>
  );
}

function DiagramLayerNode({ data }: NodeProps<LayerNode>) {
  return (
    <div className={`flow-layer flow-layer--${data.tone}`}>
      <div className="flow-layer__header"><strong>{data.title}</strong><span>{data.subtitle}</span></div>
    </div>
  );
}

const nodeTypes: NodeTypes = { platform: PlatformDiagramNode, layer: DiagramLayerNode };
const activeMarker = { type: MarkerType.ArrowClosed, width: 14, height: 14, color: "#7c86ea" } as const;

function verticalEdge(id: string, source: string, target: string, sourceHandle = "bottom", targetHandle = "top"): Edge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: "straight",
    animated: true,
    markerEnd: activeMarker,
    style: { stroke: "#7c86ea", strokeWidth: 1.35 },
  };
}

function reverseVerticalEdge(id: string, source: string, target: string, targetHandle: string): Edge {
  return {
    id,
    source,
    target,
    sourceHandle: "top-up",
    targetHandle,
    type: "straight",
    animated: true,
    markerEnd: activeMarker,
    style: { stroke: "#7c86ea", strokeWidth: 1.35 },
  };
}

function horizontalEdge(id: string, source: string, target: string, sourceHandle = "right", targetHandle = "left"): Edge {
  return {
    id,
    source,
    target,
    sourceHandle,
    targetHandle,
    type: "smoothstep",
    animated: true,
    markerEnd: activeMarker,
    style: { stroke: "#7c86ea", strokeWidth: 1.35 },
  };
}

function algorithmEdge(): Edge {
  return {
    id: "algorithm-agent",
    source: "strategy",
    target: "flow-agent",
    sourceHandle: "top-source",
    targetHandle: "bottom-target",
    type: "straight",
    animated: true,
    markerEnd: activeMarker,
    style: { stroke: "#7c86ea", strokeWidth: 1.35 },
  };
}

const hierarchyNodes: DiagramNode[] = [
  { id: "layer-platform", type: "layer", position: { x: 0, y: 0 }, data: { title: "联邦平台", subtitle: "统一协议与应用注册入口", tone: "platform" }, style: { width: 1200, height: 132 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-app", type: "layer", position: { x: 0, y: 152 }, data: { title: "应用层", subtitle: "所有应用都按照平台协议开发", tone: "plain" }, style: { width: 1200, height: 142 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-federation", type: "layer", position: { x: 0, y: 314 }, data: { title: "联邦域层", subtitle: "联邦 Agent 运行在所属联邦域内部", tone: "platform" }, style: { width: 1200, height: 230 }, selectable: false, focusable: false, draggable: false },
  { id: "layer-sites", type: "layer", position: { x: 0, y: 564 }, data: { title: "站点层", subtitle: "站点提交内容，并接收联邦处理结果", tone: "sites" }, style: { width: 1200, height: 160 }, selectable: false, focusable: false, draggable: false },

  { id: "platform", type: "platform", className: "platform-root", parentId: "layer-platform", extent: "parent", position: { x: 72, y: 46 }, data: { title: "联邦平台", subtitle: "统一协议 · 注册并管理多个应用", moduleId: "platform" }, style: { width: 1056, height: 72 }, ariaLabel: "联邦平台" },

  ...(["A", "B", "N"] as const).map((suffix, index): PlatformNode => ({
    id: `app-${suffix}`,
    type: "platform",
    parentId: "layer-app",
    extent: "parent",
    position: { x: 115 + index * 360, y: 50 },
    data: { title: `应用 ${suffix}`, subtitle: "按照平台协议开发并注册", moduleId: "application" },
    style: { width: 250, height: 72 },
    ariaLabel: `应用 ${suffix}`,
  })),
  ...(["A", "B", "N"] as const).map((suffix, index): PlatformNode => ({
    id: `federation-${suffix}`,
    type: "platform",
    className: "federation-container",
    parentId: "layer-federation",
    extent: "parent",
    position: { x: 72 + index * 360, y: 52 },
    data: { title: `联邦域 ${suffix}`, subtitle: `组织应用 ${suffix} 的站点协作`, moduleId: "federation" },
    style: { width: 336, height: 162 },
    ariaLabel: `应用 ${suffix} 的联邦域`,
  })),
  ...(["A", "B", "N"] as const).map((suffix): PlatformNode => ({
    id: `agent-${suffix}`,
    type: "platform",
    parentId: `federation-${suffix}`,
    extent: "parent",
    position: { x: 28, y: 80 },
    data: { title: `应用联邦 Agent ${suffix}`, subtitle: "负责本联邦域的处理", moduleId: "agent" },
    style: { width: 280, height: 62 },
    ariaLabel: `联邦域 ${suffix} 内的 Agent`,
  })),
  ...(["A", "B", "N"] as const).flatMap((app, appIndex) =>
    [1, 2, 3].map((site, siteIndex): PlatformNode => ({
      id: `site-${app}-${site}`,
      type: "platform",
      parentId: "layer-sites",
      extent: "parent",
      position: { x: 76 + appIndex * 360 + siteIndex * 112, y: 60 },
      data: { title: `站点 ${app}-${site}`, subtitle: `属于应用 ${app}`, moduleId: "site" },
      style: { width: 108, height: 68 },
      ariaLabel: `应用 ${app} 的站点 ${site}`,
    })),
  ),
];

const branchPorts = ["left", "center", "right"] as const;
const hierarchyEdges: Edge[] = (["A", "B", "N"] as const).flatMap((suffix, appIndex) => [
  verticalEdge(`platform-app-${suffix}`, "platform", `app-${suffix}`, `bottom-app-${branchPorts[appIndex]}`),
  verticalEdge(`app-federation-${suffix}`, `app-${suffix}`, `federation-${suffix}`),
  ...[1, 2, 3].flatMap((site, siteIndex) => [
    verticalEdge(`federation-site-${suffix}-${site}`, `federation-${suffix}`, `site-${suffix}-${site}`, `bottom-site-${branchPorts[siteIndex]}`, "top-down"),
    reverseVerticalEdge(`site-federation-${suffix}-${site}`, `site-${suffix}-${site}`, `federation-${suffix}`, `bottom-site-${branchPorts[siteIndex]}-in`),
  ]),
]);

const flowNodes: DiagramNode[] = [
  { id: "flow-source", type: "layer", position: { x: 0, y: 0 }, data: { title: "站点提交", subtitle: "同一应用的多个站点上传内容", tone: "sites" }, style: { width: 230, height: 420 }, selectable: false, focusable: false, draggable: false },
  { id: "flow-platform", type: "layer", position: { x: 250, y: 0 }, data: { title: "联邦平台", subtitle: "不同应用分别处理", tone: "platform" }, style: { width: 700, height: 420 }, selectable: false, focusable: false, draggable: false },
  { id: "flow-target", type: "layer", position: { x: 970, y: 0 }, data: { title: "站点接收", subtitle: "目标站点接收结果并确认", tone: "sites" }, style: { width: 230, height: 420 }, selectable: false, focusable: false, draggable: false },

  ...[1, 2, 3].map((site, index): PlatformNode => ({
    id: `submit-site-${site}`,
    type: "platform",
    parentId: "flow-source",
    extent: "parent",
    position: { x: 52, y: 92 + index * 116 },
    data: { title: `站点 A-${site}`, subtitle: "提交本地内容", moduleId: "site" },
    style: { width: 126, height: 58 },
    ariaLabel: `提交数据的站点 A-${site}`,
  })),
  { id: "gateway", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 38, y: 194 }, data: { title: "接收与检查", subtitle: "身份、格式、完整性", moduleId: "gateway" }, style: { width: 138, height: 66 }, ariaLabel: "接收与检查" },
  { id: "storage", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 202, y: 194 }, data: { title: "数据保存", subtitle: "保存内容和处理进度", moduleId: "storage" }, style: { width: 142, height: 66 }, ariaLabel: "数据保存" },
  { id: "flow-agent", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 370, y: 194 }, data: { title: "应用联邦 Agent", subtitle: "汇总本应用的站点内容", moduleId: "agent" }, style: { width: 142, height: 66 }, ariaLabel: "应用联邦 Agent" },
  { id: "delivery", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 538, y: 194 }, data: { title: "结果分发", subtitle: "把结果发给目标站点", moduleId: "delivery" }, style: { width: 126, height: 66 }, ariaLabel: "结果分发" },
  { id: "strategy", type: "platform", parentId: "flow-platform", extent: "parent", position: { x: 370, y: 324 }, data: { title: "联邦算法", subtitle: "提供具体处理方式", moduleId: "strategy" }, style: { width: 142, height: 62 }, ariaLabel: "联邦算法" },
  ...[1, 2, 3].map((site, index): PlatformNode => ({
    id: `receive-site-${site}`,
    type: "platform",
    parentId: "flow-target",
    extent: "parent",
    position: { x: 52, y: 92 + index * 116 },
    data: { title: `站点 A-${site}`, subtitle: "接收结果并确认", moduleId: "site" },
    style: { width: 126, height: 58 },
    ariaLabel: `接收结果的站点 A-${site}`,
  })),
];

const flowPorts = ["top", "middle", "bottom"] as const;
const flowEdges: Edge[] = [
  ...[1, 2, 3].map((site, index) => horizontalEdge(`submit-gateway-${site}`, `submit-site-${site}`, "gateway", "right", `left-${flowPorts[index]}`)),
  horizontalEdge("gateway-storage", "gateway", "storage"),
  horizontalEdge("storage-agent", "storage", "flow-agent"),
  horizontalEdge("agent-delivery", "flow-agent", "delivery"),
  algorithmEdge(),
  ...[1, 2, 3].map((site, index) => horizontalEdge(`delivery-site-${site}`, "delivery", `receive-site-${site}`, `right-${flowPorts[index]}`, "left")),
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
          fitViewOptions={{ padding: 0.02 }}
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
      <div className="architecture-inspector__summary" key={selected}><h2>{detail.title}</h2><p>{detail.summary}</p></div>
    </section>
  );
}

export default function PlatformOverview() {
  const [hierarchySelected, setHierarchySelected] = useState<ModuleId>("agent");
  const [flowSelected, setFlowSelected] = useState<ModuleId>("gateway");

  return (
    <div className="landing">
      <header className="landing__header">
        <div><p className="eyebrow">平台概览</p><h1 id="platform-title">联邦平台架构</h1><p>平台提供统一协议并注册多个应用；应用的联邦 Agent 运行在所属联邦域内。</p></div>
      </header>

      <section className="architecture-workbench" id="platform-architecture" aria-labelledby="hierarchy-title">
        <div className="architecture-workbench__bar"><div><h2 id="hierarchy-title">组织层级</h2><span>应用、Agent、联邦域与站点的归属关系</span></div><small>点击节点查看说明</small></div>
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
