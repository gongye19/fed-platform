import { FormEvent, ReactNode, useEffect, useRef, useState } from "react";
import PlatformOverview from "./PlatformOverview";
import { buildEvaluationTrend, buildSiteTracks, groupEvaluationResults, latestEvaluationRows, type EvaluationRow, type SiteTrackNode } from "./evaluation";
import { latestReleaseGroup, releaseLabels, siteContributionRows } from "./versions";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");

type Json = Record<string, unknown>;
type Application = {
  app_id: string;
  display_name: string;
  current_version: string;
  status: string;
  agent_status: string;
  core_plugin_id: string;
  federation_count: number;
  site_count: number;
};
type Federation = { federation_id: string; display_name: string; status: string };
type Membership = {
  federation_id: string;
  site_id: string;
  display_name: string;
  can_submit: boolean;
  can_receive: boolean;
  can_execute_task: boolean;
  app_version: string | null;
  last_seen_at: string | null;
  reported_release_id: string | null;
  federation_version_reported_at: string | null;
};
type Topology = {
  application: Application & { manifest: Json };
  federations: Federation[];
  memberships: Membership[];
};
type Submission = {
  submission_id: string;
  site_id: string;
  artifact_digest: string;
  status: string;
  created_at: string;
  type_name: string;
  format_version: number;
  media_type: string;
  purpose: "contribution" | "release" | "evaluation";
  size_bytes: number;
  metadata: Json;
};
type ReleaseSummary = {
  release_id: string;
  created_at: string;
  artifact_digests: string[];
  delivery_count: number;
  pending: number;
  staged: number;
  active: number;
  failed: number;
  rolled_back: number;
  version_label: string | null;
  algorithm_id: string | null;
};
type Delivery = {
  delivery_id: string;
  site_id: string;
  state: string;
  failed_action: string | null;
  last_error: string | null;
  updated_at: string;
};
type ReleaseDetail = {
  release_id: string;
  created_at: string;
  artifacts: Array<Submission & { digest: string }>;
  deliveries: Delivery[];
};
type Activity = {
  created_at: string;
  source: string;
  action: string;
  app_id: string | null;
  federation_id: string | null;
  site_id: string | null;
  target_type: string;
  target_id: string;
  detail: Json;
  result: string;
};
type AgentJob = {
  job_id: string;
  status: "pending" | "running" | "retry" | "succeeded" | "failed";
  last_error: string | null;
};

const APP_SECTIONS = [
  ["overview", "概览"],
  ["versions", "版本管理"],
  ["evaluations", "效果"],
  ["timeline", "时间线"],
  ["logs", "日志"],
] as const;
type AppSection = typeof APP_SECTIONS[number][0];

function appSection(value?: string): AppSection {
  return APP_SECTIONS.some(([id]) => id === value) ? value as AppSection : "overview";
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.detail;
    const message = typeof detail === "string" ? detail : detail?.message || `请求失败 (${response.status})`;
    throw new ApiError(response.status, message);
  }
  return data as T;
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = (next: string) => {
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0 });
  };
  return { path, navigate };
}

function formatTime(value: string | null, empty = "尚未连接") {
  if (!value) return empty;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function shortId(value: string, length = 18) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
}

function visibleName(value: string) {
  return value.replace(/\bdemo\b/gi, "").replace(/^[\s_-]+|[\s_-]+$/g, "").replace(/\s{2,}/g, " ").trim() || "未命名";
}

function activityLabel(action: string) {
  return ({
    "submission.received": "收到站点贡献",
    "evaluation.received": "收到站点评测",
    "release.created": "创建联邦版本",
    "release.stage.requested": "下发暂存命令",
    "release.activate.requested": "下发启用命令",
    "release.rollback.requested": "下发回滚命令",
    "delivery.staged": "站点已暂存版本",
    "delivery.active": "站点已启用版本",
    "delivery.rolled_back": "站点已回滚版本",
    "application.registered": "应用已注册",
    "artifact.created": "保存上传内容",
    "generation.requested": "开始联邦生成",
    "submission.accepted": "站点上传已接收",
    "agent.job.completed": "Agent 已处理事件",
    "agent.job.failed": "Agent 处理失败",
    "membership.updated": "站点成员已更新",
    "site.key.issued": "已签发站点密钥",
    "site.enrolled": "站点首次接入",
    "site.version.reported": "站点上报使用版本",
  } as Record<string, string>)[action] || action;
}

function activityTargetLabel(target: string) {
  return ({ agent: "Agent", agent_job: "Agent 任务", application: "应用", artifact: "上传内容", membership: "站点接入", submission: "站点上传", delivery: "站点分发", release: "联邦版本" } as Record<string, string>)[target] || "运行记录";
}

function resultLabel(result: string) {
  return ({ success: "成功", failed: "失败", pending: "等待" } as Record<string, string>)[result] || result;
}

function deliveryStateLabel(value: string) {
  return ({ pending: "待分发", staged: "已暂存", active: "已启用", failed: "失败", rolled_back: "已回滚" } as Record<string, string>)[value] || value;
}

function Status({ value }: { value: string }) {
  const tone = ["failed", "disabled", "offline", "reject", "失败", "下降"].includes(value)
    ? "bad"
    : ["pending", "running", "staged", "retry", "等待", "尚未连接", "待分发", "已暂存", "未提交", "尚未上报"].includes(value)
      ? "waiting"
      : "ok";
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{value}</span>;
}

function ErrorMessage({ error }: { error: string }) {
  return <p className="message message--error" role="alert">{error}</p>;
}

function Empty({ children }: { children: ReactNode }) {
  return <div className="empty"><span className="empty__mark" aria-hidden="true" />{children}</div>;
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={onClose} onClose={onClose} aria-labelledby="dialog-title">
      <div className="dialog__head">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭">×</button>
      </div>
      {children}
    </dialog>
  );
}

function Shell({ path, navigate }: {
  path: string;
  navigate: (path: string) => void;
}) {
  const appMatch = path.match(/^\/apps\/([^/]+)(?:\/([^/]+))?$/);
  const selectedAppId = appMatch ? decodeURIComponent(appMatch[1]) : "";
  const selectedSection = appSection(appMatch?.[2]);
  const [applicationsOpen, setApplicationsOpen] = useState(path.startsWith("/apps"));
  const [applications, setApplications] = useState<Application[]>([]);
  useEffect(() => {
    if (path.startsWith("/apps")) setApplicationsOpen(true);
  }, [path]);
  useEffect(() => {
    void api<{ items: Application[] }>("/admin/v1/apps?limit=100")
      .then((data) => setApplications(data.items))
      .catch(() => setApplications([]));
  }, []);
  return (
    <div className="shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => navigate("/")}><strong>FED</strong><span>联邦控制面</span></button>
        <p className="sidebar__label">联邦工作区</p>
        <nav aria-label="主导航">
          <button className={path === "/" ? "active" : ""} onClick={() => navigate("/")} aria-current={path === "/" ? "page" : undefined}>概览</button>
          <button
            className={path.startsWith("/apps") ? "active sidebar__apps-toggle" : "sidebar__apps-toggle"}
            onClick={() => {
              if (path === "/apps") setApplicationsOpen((current) => !current);
              else { setApplicationsOpen(true); navigate("/apps"); }
            }}
            aria-expanded={applicationsOpen}
          >
            <span>应用</span><span aria-hidden="true">{applicationsOpen ? "−" : "+"}</span>
          </button>
          {applicationsOpen && <div className="sidebar-apps">
            {applications.map((item) => {
              const selected = item.app_id === selectedAppId;
              const base = `/apps/${encodeURIComponent(item.app_id)}`;
              return <div className="sidebar-app" key={item.app_id}>
                <button className={selected ? "sidebar-app__name active" : "sidebar-app__name"} onClick={() => navigate(`${base}/overview`)}>
                  <span>{visibleName(item.display_name)}</span><small>{item.current_version}</small>
                </button>
              </div>;
            })}
          </div>}
        </nav>
        <div className="sidebar__foot">
          <span className="connection"><i />API 已连接</span>
          <span className="environment">开发环境</span>
        </div>
      </aside>
      <main className="content">
        {path === "/" ? (
          <PlatformOverview />
        ) : appMatch ? (
          <ApplicationDetail appId={selectedAppId} section={selectedSection} navigate={navigate} />
        ) : path === "/apps" ? (
          <ApplicationsPage navigate={navigate} />
        ) : (
          <PlatformOverview />
        )}
      </main>
    </div>
  );
}

function PageHeader({ eyebrow, title, meta, action }: { eyebrow: string; title: string; meta?: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{meta && <p className="page-header__meta">{meta}</p>}</div>
      {action}
    </header>
  );
}

function ApplicationsPage({ navigate }: { navigate: (path: string) => void }) {
  const [items, setItems] = useState<Application[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [registering, setRegistering] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ items: Application[] }>("/admin/v1/apps?limit=100");
      setItems(data.items);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "加载失败");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const visible = items.filter((item) => `${item.app_id} ${item.display_name}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <PageHeader eyebrow="Registry / Applications" title="应用" meta={`${items.length} 个已注册应用 · 每个应用拥有独立联邦 Agent`} action={<button className="button button--primary" onClick={() => setRegistering(true)}>注册应用</button>} />
      <div className="toolbar">
        <label className="search"><span className="sr-only">搜索应用</span><input type="search" placeholder="搜索 app_id 或名称" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="button button--quiet" onClick={load}>刷新</button>
      </div>
      {error && <ErrorMessage error={error} />}
      <section className="ledger" aria-busy={loading}>
        <div className="ledger__head"><span>APPLICATION</span><span>AGENT</span><span>FEDERATIONS</span><span>SITES</span><span>STATE</span></div>
        {!loading && visible.length === 0 ? <Empty>没有匹配的应用。注册第一个 FedApp Manifest 后，平台会同时创建它的 Agent。</Empty> : visible.map((item) => (
          <button className="ledger__row" key={item.app_id} onClick={() => navigate(`/apps/${encodeURIComponent(item.app_id)}/overview`)}>
            <span><strong>{visibleName(item.display_name)}</strong><small className="mono">{item.app_id} · v{item.current_version}</small></span>
            <span><Status value={item.agent_status} /></span>
            <span className="ledger__number">{item.federation_count}</span>
            <span className="ledger__number">{item.site_count}</span>
            <span><Status value={item.status} /></span>
          </button>
        ))}
      </section>
      {registering && <RegisterApplication onClose={() => setRegistering(false)} onCreated={async () => { setRegistering(false); await load(); }} />}
    </>
  );
}

const sampleManifest = JSON.stringify({
  schema_version: "fedapp/v1",
  app_id: "com.example.agent",
  app_version: "1.0.0",
  display_name: "Example Agent",
  adapter_protocol: ">=1.0 <2.0",
  artifact_types: [{ type: "com.example.observation", format_version: 1, media_type: "application/json", metadata_schema: { type: "object" } }],
  task_types: [],
}, null, 2);

function RegisterApplication({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [manifest, setManifest] = useState(sampleManifest);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const body = JSON.parse(manifest);
      await api("/admin/v1/apps", { method: "POST", body: JSON.stringify(body) });
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Manifest 无效");
    }
  }
  return <Modal title="注册应用契约" onClose={onClose}><form onSubmit={submit} className="stack"><p className="hint">提交完整 FedApp Manifest。相同版本注册后不可改变语义。</p><label>Manifest JSON<textarea className="code-field" value={manifest} onChange={(event) => setManifest(event.target.value)} rows={18} spellCheck={false} /></label>{error && <ErrorMessage error={error} />}<div className="dialog__actions"><button type="button" className="button button--quiet" onClick={onClose}>取消</button><button className="button button--primary">注册应用</button></div></form></Modal>;
}

function ApplicationDetail({ appId, section, navigate }: { appId: string; section: AppSection; navigate: (path: string) => void }) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [federationId, setFederationId] = useState("");
  const [evaluations, setEvaluations] = useState<Submission[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [error, setError] = useState("");

  const loadTopology = async () => {
    try {
      const nextTopology = await api<Topology>(`/admin/v1/apps/${encodeURIComponent(appId)}/topology`);
      setTopology(nextTopology);
      setFederationId((current) => nextTopology.federations.some((item) => item.federation_id === current) ? current : nextTopology.federations[0]?.federation_id || "");
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "应用加载失败"); }
  };
  const loadChannel = async () => {
    if (!federationId) { setEvaluations([]); setSubmissions([]); setReleases([]); return; }
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      const [evaluationData, submissionData, releaseData] = await Promise.all([
        api<{ items: Submission[] }>(`${base}/evaluations?limit=100`),
        api<{ items: Submission[] }>(`${base}/submissions?limit=100`),
        api<{ items: ReleaseSummary[] }>(`${base}/releases?limit=50`),
      ]);
      setEvaluations(evaluationData.items);
      setSubmissions(submissionData.items);
      setReleases(releaseData.items);
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "通道加载失败"); }
  };
  useEffect(() => { void loadTopology(); }, [appId]);
  useEffect(() => { void loadChannel(); }, [appId, federationId]);
  useEffect(() => {
    void api<{ items: Activity[] }>(`/admin/v1/activity?app_id=${encodeURIComponent(appId)}&limit=100`)
      .then((data) => setActivities(data.items))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "活动加载失败"));
  }, [appId]);

  if (!topology) return <><PageHeader eyebrow="Registry / Application" title={appId} meta="正在加载应用拓扑…" />{error && <ErrorMessage error={error} />}</>;
  const app = topology.application;
  const sectionLabel = APP_SECTIONS.find(([id]) => id === section)?.[1] || "概览";
  const base = `/apps/${encodeURIComponent(appId)}`;
  const currentFederationReleases = latestReleaseGroup(releases);
  return <>
    <PageHeader eyebrow={`应用 / ${sectionLabel}`} title={visibleName(app.display_name)} meta={`应用版本 ${app.current_version}`} />
    <div className="app-state"><Status value={app.status} /><span>Agent</span><Status value={app.agent_status} /></div>
    {error && <ErrorMessage error={error} />}
    <nav className="app-nav" aria-label={`${visibleName(app.display_name)} 导航`}>{APP_SECTIONS.map(([id, label]) => <button key={id} className={section === id ? "active" : ""} aria-current={section === id ? "page" : undefined} onClick={() => navigate(`${base}/${id}`)}>{label}</button>)}</nav>
    {section === "overview" && <div className="panel-stack"><ApplicationSites topology={topology} /><SiteOperationTracks memberships={topology.memberships} releases={currentFederationReleases} activities={activities.filter((item) => !item.federation_id || item.federation_id === federationId)} /></div>}
    {section === "evaluations" && <Evaluations items={evaluations} memberships={topology.memberships} />}
    {section === "versions" && <VersionManagement appId={appId} federationId={federationId} topology={topology} submissions={submissions} releases={currentFederationReleases} onRefresh={async () => { await Promise.all([loadTopology(), loadChannel()]); }} />}
    {section === "timeline" && <ActivityTimeline items={activities} memberships={topology.memberships} releases={currentFederationReleases} />}
    {section === "logs" && <ActivityLog items={activities} memberships={topology.memberships} releases={currentFederationReleases} />}
  </>;
}

function ApplicationSites({ topology }: { topology: Topology }) {
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">已接入应用</p><h2>站点</h2></div><span>{topology.memberships.length} 个站点</span></div><table><thead><tr><th>站点</th><th>站点应用版本</th><th>连接状态</th><th>最后上传</th></tr></thead><tbody>{topology.memberships.map((member) => <tr key={member.site_id}><td><strong>{visibleName(member.display_name)}</strong></td><td>{member.app_version || "尚未上报"}</td><td><Status value={member.last_seen_at ? "已连接" : "尚未连接"} /></td><td>{formatTime(member.last_seen_at)}</td></tr>)}</tbody></table>{topology.memberships.length === 0 && <Empty>站点首次使用应用专属 API Key 上传成功后，会自动显示在这里。</Empty>}</section>;
}

function activityNames(memberships: Membership[], releases: ReleaseSummary[]) {
  return {
    sites: new Map(memberships.map((member) => [member.site_id, visibleName(member.display_name)])),
    releases: releaseLabels(releases),
  };
}

function visibleActivityTarget(item: Activity, labels: Map<string, string>) {
  return item.target_type === "release" ? labels.get(item.target_id) || "联邦版本" : activityTargetLabel(item.target_type);
}

function ActivityTimeline({ items, memberships, releases }: { items: Activity[]; memberships: Membership[]; releases: ReleaseSummary[] }) {
  const names = activityNames(memberships, releases);
  const milestones = items.filter((item) => item.source === "event" || item.action.startsWith("release.")).slice(0, 50);
  return <section className="activity-panel"><div className="section-head"><div><p className="eyebrow">联邦过程</p><h2>时间线</h2></div><span>最近 {milestones.length} 个节点</span></div><div className="timeline">{milestones.map((item, index) => <article key={`${item.created_at}-${index}`} className="timeline__item"><time>{formatTime(item.created_at)}</time><span className="timeline__node" /><div><div className="timeline__title"><strong>{activityLabel(item.action)}</strong><Status value={resultLabel(item.result)} /></div><p>{item.site_id ? names.sites.get(item.site_id) || "站点" : "平台"}</p><small>{visibleActivityTarget(item, names.releases)}</small></div></article>)}{milestones.length === 0 && <Empty>这个应用还没有联邦活动。</Empty>}</div></section>;
}

function ActivityLog({ items, memberships, releases }: { items: Activity[]; memberships: Membership[]; releases: ReleaseSummary[] }) {
  const names = activityNames(memberships, releases);
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">运行记录</p><h2>日志</h2></div><span>最近 {items.length} 条</span></div><table><thead><tr><th>时间</th><th>活动</th><th>来源</th><th>站点</th><th>对象</th><th>结果</th></tr></thead><tbody>{items.map((item, index) => <tr key={`${item.created_at}-${index}`}><td>{formatTime(item.created_at)}</td><td><strong>{activityLabel(item.action)}</strong></td><td>{item.source === "event" ? "站点事件" : "平台操作"}</td><td>{item.site_id ? names.sites.get(item.site_id) || "站点" : "平台"}</td><td>{visibleActivityTarget(item, names.releases)}</td><td><Status value={resultLabel(item.result)} /></td></tr>)}</tbody></table>{items.length === 0 && <Empty>这个应用还没有日志。</Empty>}</section>;
}

const chartColors = ["#7c86e8", "#76c7a0", "#d5a75d", "#e4777f", "#70b7d3", "#b08bd7"];

function chartPath(values: Array<number | null>, x: (index: number) => number, y: (value: number) => number) {
  let path = "";
  let connected = false;
  values.forEach((value, index) => {
    if (value === null) { connected = false; return; }
    path += `${connected ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)} `;
    connected = true;
  });
  return path.trim();
}

function EffectChart({ rows, siteNames }: { rows: EvaluationRow[]; siteNames: Record<string, string> }) {
  const trend = buildEvaluationTrend(rows);
  const labels = ["联邦前", ...trend.rounds.map((_, index) => `第 ${index + 1} 轮`)];
  const width = Math.max(760, Math.min(1080, labels.length * 120));
  const height = 320;
  const bounds = { top: 22, right: 24, bottom: 48, left: 52 };
  const plotWidth = width - bounds.left - bounds.right;
  const plotHeight = height - bounds.top - bounds.bottom;
  const x = (index: number) => bounds.left + (labels.length === 1 ? 0 : plotWidth * index / (labels.length - 1));
  const y = (value: number) => bounds.top + (1 - value) * plotHeight / .5;
  const siteSeries = trend.siteIds.map((siteId, index) => ({ siteId, values: trend.valuesBySite[siteId], color: chartColors[index % chartColors.length] }));

  return <section className="effect-panel"><div className="section-head"><div><p className="eyebrow">各站点</p><h2>效果趋势</h2></div></div>
    {rows.length === 0 ? <Empty>还没有站点上传效果结果。</Empty> : <>
      <div className="effect-legend">{siteSeries.map((series) => <span key={series.siteId}><i className="effect-legend__line" style={{ background: series.color }} />{siteNames[series.siteId] || series.siteId}</span>)}</div>
      <div className="effect-chart__scroll"><svg className="effect-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="各站点效果随联邦轮次的变化折线图">
        {[.5, .6, .7, .8, .9, 1].map((tick) => <g key={tick}><line className="effect-chart__grid" x1={bounds.left} y1={y(tick)} x2={width - bounds.right} y2={y(tick)} /><text className="effect-chart__axis" x={bounds.left - 10} y={y(tick) + 4} textAnchor="end">{tick * 100}%</text></g>)}
        {labels.map((label, index) => labels.length <= 10 || index === labels.length - 1 || index % Math.ceil(labels.length / 8) === 0 ? <text className="effect-chart__axis" key={label} x={x(index)} y={height - 16} textAnchor="middle"><title>{index === 0 ? label : trend.rounds[index - 1].roundId}</title>{label}</text> : null)}
        {siteSeries.map((series) => <g key={series.siteId}><path className="effect-chart__site-line" d={chartPath(series.values, x, y)} stroke={series.color} />{series.values.map((value, index) => value === null ? null : <circle key={index} className="effect-chart__point" cx={x(index)} cy={y(value)} r="3.5" fill={series.color}><title>{`${siteNames[series.siteId] || series.siteId} · ${labels[index]} · ${(value * 100).toFixed(1)}%`}</title></circle>)}</g>)}
      </svg></div>
    </>}
  </section>;
}

function trackNodeLabel(node: SiteTrackNode) {
  return ({
    contribution: node.complete ? "已上传待联邦数据" : "未上传待联邦数据",
    distribute: node.complete ? "已下发联邦版本" : "未下发联邦版本",
    update: node.complete ? "已更新联邦版本" : "未更新联邦版本",
    evaluation: node.complete ? "已返回测试结果" : "未返回测试结果",
  } as const)[node.kind];
}

function SiteOperationTracks({ memberships, releases, activities }: { memberships: Membership[]; releases: ReleaseSummary[]; activities: Activity[] }) {
  const releaseNames = Object.fromEntries(releaseLabels(releases));
  const currentReleases = Object.fromEntries(memberships.map((member) => [member.site_id, member.reported_release_id]));
  const tracks = buildSiteTracks(memberships.map((member) => member.site_id), activities, releases, currentReleases);
  const members = Object.fromEntries(memberships.map((member) => [member.site_id, member]));
  return <section className="effect-panel"><div className="section-head"><div><p className="eyebrow">上传与版本状态</p><h2>站点运行轨迹</h2></div><div className="track-legend"><span><i className="track-mark track-mark--complete" />已完成</span><span><i className="track-mark track-mark--missing" />未完成</span></div></div>
    {tracks.length === 0 ? <Empty>还没有站点接入这个应用。</Empty> : <div className="site-tracks">{tracks.map((track) => {
      const member = members[track.siteId];
      const current = member.reported_release_id ? releaseNames[member.reported_release_id] || shortId(member.reported_release_id, 10) : "尚未上报使用版本";
      return <div className="site-track" key={track.siteId}><div className="site-track__site"><strong>{visibleName(member.display_name)}</strong><span>当前联邦版本：{current}</span></div><div className="site-track__events">{track.nodes.length === 0 ? <span className="site-track__empty">还没有可追踪的联邦版本</span> : track.nodes.map((node, index) => {
        const version = releaseNames[node.releaseId] || "联邦版本";
        return <div className={`site-track__event${node.complete ? "" : " site-track__event--missing"}`} key={`${node.kind}-${node.releaseId}-${index}`} title={`${trackNodeLabel(node)} · ${version}`}><i className={`track-mark track-mark--${node.kind}${node.complete ? "" : " track-mark--missing"}`} /><strong>{trackNodeLabel(node)}</strong><small>{version}</small></div>;
      })}</div></div>;
    })}</div>}
  </section>;
}

function Evaluations({ items, memberships }: { items: Submission[]; memberships: Membership[] }) {
  const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
  const rows = latestEvaluationRows(groupEvaluationResults(items));
  const siteNames = Object.fromEntries(memberships.map((member) => [member.site_id, visibleName(member.display_name)]));
  const rounds = new Map(buildEvaluationTrend(rows).rounds.map((round, index) => [round.roundId, `第 ${index + 1} 轮`]));
  return <div className="panel-stack"><EffectChart rows={rows} siteNames={siteNames} /><section className="table-wrap"><div className="section-head"><div><p className="eyebrow">每轮站点结果</p><h2>结果明细</h2></div><span>{rows.length} 条结果</span></div><table><thead><tr><th>轮次</th><th>站点</th><th>联邦前</th><th>联邦后</th><th>结果</th><th>上传时间</th></tr></thead><tbody>{rows.map((row) => { const change = row.baseline === null || row.candidate === null ? null : row.candidate - row.baseline; const result = change === null ? "等待联邦结果" : change > 0.0001 ? "提升" : change < -0.0001 ? "下降" : "持平"; return <tr key={row.key}><td>{rounds.get(row.roundId) || "本轮"}</td><td><strong>{siteNames[row.siteId] || "站点"}</strong></td><td>{percent(row.baseline)}</td><td>{percent(row.candidate)}</td><td><span className={`evaluation-result evaluation-result--${result === "提升" ? "up" : result === "下降" ? "down" : result === "持平" ? "same" : "waiting"}`}>{result}</span></td><td>{formatTime(row.createdAt)}</td></tr>; })}</tbody></table>{rows.length === 0 && <Empty>还没有站点上传效果结果。</Empty>}</section></div>;
}

function VersionManagement({ appId, federationId, topology, submissions, releases, onRefresh }: {
  appId: string;
  federationId: string;
  topology: Topology;
  submissions: Submission[];
  releases: ReleaseSummary[];
  onRefresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(releases[0]?.release_id || "");
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [busy, setBusy] = useState<"generate" | "distribute" | "">("");
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
  const latestRelease = releases[0] || null;
  const contributionRows = siteContributionRows(topology.memberships, submissions, latestRelease?.created_at || null);
  const newCount = contributionRows.filter((row) => row.state === "new").length;
  const allReady = contributionRows.length > 0 && newCount === contributionRows.length;
  const selected = releases.find((release) => release.release_id === selectedId) || null;
  const selectedDetail = detail?.release_id === selectedId ? detail : null;
  const stageableSites = selectedDetail?.deliveries.filter((delivery) => delivery.state === "pending" || (delivery.state === "failed" && delivery.failed_action === "stage")).map((delivery) => delivery.site_id) || [];
  const labels = releaseLabels(releases);

  useEffect(() => {
    if (!selectedId || !releases.some((release) => release.release_id === selectedId)) {
      setSelectedId(releases[0]?.release_id || "");
    }
  }, [releases, selectedId]);
  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let cancelled = false;
    setDetail(null);
    void api<ReleaseDetail>(`${base}/releases/${selectedId}`)
      .then((next) => { if (!cancelled) setDetail(next); })
      .catch((reason) => { if (!cancelled) setMessage({ tone: "error", text: reason instanceof Error ? reason.message : "版本加载失败" }); });
    return () => { cancelled = true; };
  }, [base, selectedId]);

  async function generate() {
    setBusy("generate");
    setMessage(null);
    try {
      const readySubmissions = contributionRows.flatMap((row) => row.submission ? [row.submission] : []);
      const roundIds = [...new Set(readySubmissions.map((item) => item.metadata.round_id).filter((value): value is string => typeof value === "string"))];
      if (roundIds.length !== 1) throw new Error("站点提交不属于同一个有效轮次");
      const requested = await api<AgentJob>(`${base}/agent/generations`, {
        method: "POST",
        body: JSON.stringify({
          round_id: roundIds[0],
          submission_ids: readySubmissions.map((item) => item.submission_id),
        }),
      });
      let job = requested;
      for (let attempt = 0; attempt < 180 && !["succeeded", "failed"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        job = await api<AgentJob>(`${base}/agent/jobs/${requested.job_id}`);
      }
      if (job.status !== "succeeded") throw new Error(job.last_error || "联邦 Agent 生成超时");
      const release = await api<{ release_id: string }>(`${base}/releases/generate`, { method: "POST" });
      await onRefresh();
      setSelectedId(release.release_id);
      setMessage({ tone: "success", text: "新的联邦版本已生成。" });
    } catch (reason) {
      setMessage({ tone: "error", text: reason instanceof Error ? reason.message : "联邦生成失败" });
    } finally { setBusy(""); }
  }

  async function distribute() {
    if (!selected || stageableSites.length === 0) return;
    setBusy("distribute");
    setMessage(null);
    try {
      await api(`${base}/releases/${selected.release_id}/stage`, {
        method: "POST",
        body: JSON.stringify({ site_ids: stageableSites }),
      });
      setMessage({ tone: "success", text: `已向 ${stageableSites.length} 个站点发出下发命令。` });
      await onRefresh();
      setDetail(await api<ReleaseDetail>(`${base}/releases/${selected.release_id}`));
    } catch (reason) {
      setMessage({ tone: "error", text: reason instanceof Error ? reason.message : "版本下发失败" });
    } finally { setBusy(""); }
  }

  return <div className="version-workbench">
    {message && <p className={`message message--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}<button onClick={() => setMessage(null)} aria-label="关闭消息">×</button></p>}
    <div className="version-workbench__top">
      <section className="version-panel contribution-panel">
        <div className="section-head"><div><p className="eyebrow">本轮输入</p><h2>站点提交</h2></div><span>{newCount} / {contributionRows.length} 有新提交</span></div>
        <div className="contribution-list">{contributionRows.map((row) => <div key={row.site_id}><span><strong>{visibleName(row.display_name)}</strong></span><span><Status value={row.state === "new" ? "有新提交" : row.state === "included" ? "已纳入版本" : "未提交"} /><time>{row.submission ? formatTime(row.submission.created_at) : "—"}</time></span></div>)}</div>
        {contributionRows.length === 0 && <Empty>还没有站点接入这个应用。</Empty>}
        <div className="version-panel__action"><span>{allReady ? "所有站点已提交，可以生成下一版。" : "等待所有站点提交本轮内容。"}</span><button className="button button--primary" type="button" disabled={!allReady || busy !== ""} onClick={generate}>{busy === "generate" ? "生成中…" : "联邦生成"}</button></div>
      </section>

      <section className="version-panel version-library">
        <div className="section-head"><div><p className="eyebrow">可下发</p><h2>联邦版本库</h2></div><span>{releases.length} 个联邦版本</span></div>
        <div className="version-options" role="listbox" aria-label="选择下发版本">{releases.map((release) => <button key={release.release_id} type="button" role="option" className={release.release_id === selectedId ? "version-option selected" : "version-option"} aria-selected={release.release_id === selectedId} onClick={() => setSelectedId(release.release_id)}><span className="version-option__radio" aria-hidden="true" /><span><strong>{labels.get(release.release_id)}</strong><small>{formatTime(release.created_at)}</small></span><span className="version-option__delivery">{release.pending > 0 ? `${release.pending} 待下发` : `${release.delivery_count} 已下发`}</span></button>)}</div>
        {releases.length === 0 && <Empty>还没有生成联邦版本。</Empty>}
        <div className="version-panel__action"><span>{selected ? `已选择 ${labels.get(selected.release_id) || "联邦版本"}` : "先选择一个版本"}</span><button className="button" type="button" disabled={!selected || !detail || stageableSites.length === 0 || busy !== ""} onClick={distribute}>{busy === "distribute" ? "下发中…" : stageableSites.length > 0 ? `下发至 ${stageableSites.length} 个站点` : "已全部下发"}</button></div>
      </section>
    </div>

    <section className="version-panel site-version-panel">
      <div className="section-head"><div><p className="eyebrow">站点上报</p><h2>站点版本状态</h2></div><span>下发不等于启用</span></div>
      <table><thead><tr><th>站点</th><th>当前联邦版本</th><th>站点应用版本</th><th>上报时间</th></tr></thead><tbody>{topology.memberships.map((member) => <tr key={member.site_id}><td><strong>{visibleName(member.display_name)}</strong></td><td>{member.reported_release_id ? <><strong>{labels.get(member.reported_release_id) || "历史联邦版本"}</strong><small><Status value="使用中" /></small></> : <Status value="尚未上报" />}</td><td>{member.app_version || "—"}</td><td>{formatTime(member.federation_version_reported_at, "尚未上报")}</td></tr>)}</tbody></table>
      {topology.memberships.length === 0 && <Empty>站点上传后，这里会显示它实际使用的版本。</Empty>}
    </section>
  </div>;
}

export default function App() {
  const { path, navigate } = usePath();
  return <Shell path={path} navigate={navigate} />;
}
