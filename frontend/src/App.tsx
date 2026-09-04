import { FormEvent, lazy, ReactNode, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { buildEvaluationTrend, buildSiteTracks, groupEvaluationResults, latestEvaluationRows, type EvaluationRow, type SiteTrackNode } from "./evaluation";
import { latestReleaseGroup, releaseLabels, siteContributionRows } from "./versions";

const PlatformOverview = lazy(() => import("./PlatformOverview"));

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/$/, "");
const percentFormatter = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

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
  deliveries?: Delivery[];
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

const topologyRequests = new Map<string, { createdAt: number; request: Promise<Topology> }>();

function applicationTopology(appId: string, force = false) {
  const cached = topologyRequests.get(appId);
  if (!force && cached && Date.now() - cached.createdAt < 15_000) return cached.request;
  const request = api<Topology>(`/admin/v1/apps/${encodeURIComponent(appId)}/topology`)
    .catch((error) => { topologyRequests.delete(appId); throw error; });
  topologyRequests.set(appId, { createdAt: Date.now(), request });
  return request;
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  const navigate = (next: string) => {
    if (next === window.location.pathname) return;
    window.history.pushState({}, "", next);
    setPath(next);
    window.scrollTo({ top: 0 });
  };
  return { path, navigate };
}

function routeClick(event: MouseEvent<HTMLAnchorElement>, path: string, navigate: (path: string) => void) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(path);
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
    : ["pending", "running", "staged", "retry", "等待", "尚未连接", "待分发", "已暂存", "未提交", "尚未提交", "等待新数据", "尚未上报"].includes(value)
      ? "waiting"
      : "ok";
  const label = ({ active: "运行中", disabled: "已停用", failed: "失败", idle: "空闲", offline: "离线", online: "在线", pending: "等待", retry: "重试中", running: "处理中", staged: "已暂存" } as Record<string, string>)[value] || value;
  return <span className={`status status--${tone}`}><span aria-hidden="true" />{label}</span>;
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
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <aside className="sidebar">
        <a className="brand" href="/" onClick={(event) => routeClick(event, "/", navigate)}><strong>FED</strong><span>联邦控制面</span></a>
        <p className="sidebar__label">联邦工作区</p>
        <nav aria-label="主导航">
          <a className={path === "/" ? "active" : ""} href="/" onClick={(event) => routeClick(event, "/", navigate)} aria-current={path === "/" ? "page" : undefined}>概览</a>
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
                <a className={selected ? "sidebar-app__name active" : "sidebar-app__name"} href={`${base}/overview`} onMouseEnter={() => { void applicationTopology(item.app_id).catch(() => undefined); }} onFocus={() => { void applicationTopology(item.app_id).catch(() => undefined); }} onClick={(event) => routeClick(event, `${base}/overview`, navigate)}>
                  <span>{visibleName(item.display_name)}</span><small>{item.current_version}</small>
                </a>
              </div>;
            })}
          </div>}
        </nav>
        <div className="sidebar__foot">
          <span className="connection"><i aria-hidden="true" />API 已连接</span>
          <span className="environment">开发环境</span>
        </div>
      </aside>
      <main className="content" id="main-content" tabIndex={-1}>
        {path === "/" ? (
          <Suspense fallback={<ApplicationLoading />}><PlatformOverview /></Suspense>
        ) : appMatch ? (
          <ApplicationDetail key={selectedAppId} appId={selectedAppId} section={selectedSection} navigate={navigate} />
        ) : path === "/apps" ? (
          <ApplicationsPage navigate={navigate} />
        ) : (
          <Suspense fallback={<ApplicationLoading />}><PlatformOverview /></Suspense>
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

function ApplicationLoading() {
  return <section className="app-loading" role="status" aria-live="polite" aria-busy="true">
    <span className="sr-only">正在加载应用…</span>
    <div className="app-loading__header" aria-hidden="true"><span /><strong /><i /></div>
    <div className="app-loading__tabs" aria-hidden="true" />
    <div className="app-loading__panel" aria-hidden="true" />
  </section>;
}

function SectionLoading() {
  return <section className="section-loading" role="status" aria-live="polite" aria-busy="true"><span className="sr-only">正在加载…</span><i aria-hidden="true" /><i aria-hidden="true" /><i aria-hidden="true" /></section>;
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
      <PageHeader eyebrow="应用管理" title="应用" meta={`${items.length} 个已注册应用`} action={<button className="button button--primary" onClick={() => setRegistering(true)}>注册应用</button>} />
      <div className="toolbar">
        <label className="search"><span className="sr-only">搜索应用</span><input type="search" name="application-search" autoComplete="off" placeholder="搜索应用名称…" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="button button--quiet" onClick={load}>刷新</button>
      </div>
      {error && <ErrorMessage error={error} />}
      <section className="ledger" aria-busy={loading}>
        <div className="ledger__head"><span>应用</span><span>站点</span><span>状态</span></div>
        {!loading && visible.length === 0 ? <Empty>没有匹配的应用。</Empty> : visible.map((item) => (
          <a className="ledger__row" key={item.app_id} href={`/apps/${encodeURIComponent(item.app_id)}/overview`} onMouseEnter={() => { void applicationTopology(item.app_id).catch(() => undefined); }} onFocus={() => { void applicationTopology(item.app_id).catch(() => undefined); }} onClick={(event) => routeClick(event, `/apps/${encodeURIComponent(item.app_id)}/overview`, navigate)}>
            <span><strong>{visibleName(item.display_name)}</strong><small>应用版本 {item.current_version}</small></span>
            <span className="ledger__number">{item.site_count}</span>
            <span><Status value={item.status} /></span>
          </a>
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
  const [submitting, setSubmitting] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const body = JSON.parse(manifest);
      await api("/admin/v1/apps", { method: "POST", body: JSON.stringify(body) });
      onCreated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Manifest 无效");
      setSubmitting(false);
    }
  }
  return <Modal title="注册应用契约" onClose={onClose}><form onSubmit={submit} className="stack" aria-busy={submitting}><p className="hint">提交完整 FedApp Manifest。相同版本注册后不可改变语义。</p><label>Manifest JSON<textarea className="code-field" name="manifest" autoComplete="off" value={manifest} onChange={(event) => setManifest(event.target.value)} rows={18} spellCheck={false} /></label>{error && <ErrorMessage error={error} />}<div className="dialog__actions"><button type="button" className="button button--quiet" onClick={onClose}>取消</button><button className="button button--primary" disabled={submitting}>{submitting ? "注册中…" : "注册应用"}</button></div></form></Modal>;
}

type ChannelResource = "evaluations" | "submissions" | "releases" | "activities";

function sectionResources(section: AppSection): ChannelResource[] {
  if (section === "overview") return ["releases"];
  if (section === "evaluations") return ["evaluations"];
  if (section === "versions") return ["submissions", "releases", "activities"];
  return ["releases", "activities"];
}

function ApplicationDetail({ appId, section, navigate }: { appId: string; section: AppSection; navigate: (path: string) => void }) {
  const [topology, setTopology] = useState<Topology | null>(null);
  const [federationId, setFederationId] = useState("");
  const [evaluations, setEvaluations] = useState<Submission[]>([]);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loadingResources, setLoadingResources] = useState<Set<ChannelResource>>(new Set());
  const [error, setError] = useState("");
  const loaded = useRef(new Set<ChannelResource>());
  const inflight = useRef(new Set<ChannelResource>());

  const loadTopology = async (force = false) => {
    setError("");
    try {
      const nextTopology = await applicationTopology(appId, force);
      setTopology(nextTopology);
      setFederationId((current) => nextTopology.federations.some((item) => item.federation_id === current) ? current : nextTopology.federations[0]?.federation_id || "");
      setError("");
    } catch { setError("暂时无法加载这个应用，请检查网络连接后重试。"); }
  };

  const loadResource = async (resource: ChannelResource, force = false) => {
    if (!federationId || (!force && (loaded.current.has(resource) || inflight.current.has(resource)))) return;
    inflight.current.add(resource);
    setLoadingResources((current) => new Set(current).add(resource));
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      if (resource === "evaluations") setEvaluations((await api<{ items: Submission[] }>(`${base}/evaluations?limit=100`)).items);
      if (resource === "submissions") setSubmissions((await api<{ items: Submission[] }>(`${base}/submissions?limit=100`)).items);
      if (resource === "releases") setReleases((await api<{ items: ReleaseSummary[] }>(`${base}/releases?limit=50`)).items);
      if (resource === "activities") setActivities((await api<{ items: Activity[] }>(`/admin/v1/activity?app_id=${encodeURIComponent(appId)}&limit=100`)).items);
      loaded.current.add(resource);
    } catch (reason) {
      loaded.current.delete(resource);
      setError(reason instanceof Error ? reason.message : "数据加载失败");
    } finally {
      inflight.current.delete(resource);
      setLoadingResources((current) => { const next = new Set(current); next.delete(resource); return next; });
    }
  };

  useEffect(() => { void loadTopology(); }, [appId]);
  useEffect(() => {
    if (!federationId) return;
    setError("");
    void Promise.all(sectionResources(section).map((resource) => loadResource(resource)));
  }, [appId, federationId, section]);

  if (!topology) return error ? <><PageHeader eyebrow="应用" title="无法打开应用" action={<button className="button" onClick={() => void loadTopology(true)}>重新加载</button>} /><ErrorMessage error={error} /></> : <ApplicationLoading />;
  const app = topology.application;
  const sectionLabel = APP_SECTIONS.find(([id]) => id === section)?.[1] || "概览";
  const base = `/apps/${encodeURIComponent(appId)}`;
  const currentFederationReleases = latestReleaseGroup(releases);
  const currentFederationActivities = activities.filter((item) => !item.federation_id || item.federation_id === federationId);
  const sectionLoading = !error && sectionResources(section).some((resource) => loadingResources.has(resource) || !loaded.current.has(resource));
  return <>
    <PageHeader eyebrow={`应用 / ${sectionLabel}`} title={visibleName(app.display_name)} meta={`应用版本 ${app.current_version}`} />
    <div className="app-state"><Status value={app.status} /></div>
    {error && <ErrorMessage error={error} />}
    <nav className="app-nav" aria-label={`${visibleName(app.display_name)} 导航`}>{APP_SECTIONS.map(([id, label]) => <a key={id} href={`${base}/${id}`} onClick={(event) => routeClick(event, `${base}/${id}`, navigate)} className={section === id ? "active" : ""} aria-current={section === id ? "page" : undefined}>{label}</a>)}</nav>
    {sectionLoading ? <SectionLoading /> : <>
      {section === "overview" && <div className="panel-stack"><ApplicationSites topology={topology} releases={currentFederationReleases} /></div>}
      {section === "evaluations" && <Evaluations items={evaluations} memberships={topology.memberships} />}
      {section === "versions" && <VersionManagement appId={appId} federationId={federationId} topology={topology} submissions={submissions} releases={currentFederationReleases} activities={currentFederationActivities} onRefresh={async () => { await Promise.all([loadTopology(true), ...(["submissions", "releases", "activities"] as ChannelResource[]).map((resource) => loadResource(resource, true))]); }} />}
      {section === "timeline" && <ActivityTimeline items={activities} memberships={topology.memberships} releases={currentFederationReleases} />}
      {section === "logs" && <ActivityLog items={activities} memberships={topology.memberships} releases={currentFederationReleases} />}
    </>}
  </>;
}

function ApplicationSites({ topology, releases }: { topology: Topology; releases: ReleaseSummary[] }) {
  const labels = releaseLabels(releases);
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">已接入应用</p><h2>站点</h2></div><span>{topology.memberships.length} 个站点</span></div><table><thead><tr><th>站点</th><th>站点应用版本</th><th>当前联邦版本</th><th>连接状态</th><th>最后上传</th></tr></thead><tbody>{topology.memberships.map((member) => <tr key={member.site_id}><td><strong>{visibleName(member.display_name)}</strong></td><td>{member.app_version || "尚未上报"}</td><td>{member.reported_release_id ? labels.get(member.reported_release_id) || "历史联邦版本" : "尚未上报"}</td><td><Status value={member.last_seen_at ? "已连接" : "尚未连接"} /></td><td>{formatTime(member.last_seen_at)}</td></tr>)}</tbody></table>{topology.memberships.length === 0 && <Empty>站点首次使用应用专属 API Key 上传成功后，会自动显示在这里。</Empty>}</section>;
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
  return <section className="activity-panel"><div className="section-head"><div><p className="eyebrow">联邦过程</p><h2>时间线</h2></div><span>最近 {milestones.length} 个节点</span></div><div className="timeline">{milestones.map((item, index) => <article key={`${item.created_at}-${index}`} className="timeline__item"><time>{formatTime(item.created_at)}</time><span className="timeline__node" aria-hidden="true" /><div><div className="timeline__title"><strong>{activityLabel(item.action)}</strong><Status value={resultLabel(item.result)} /></div><p>{item.site_id ? names.sites.get(item.site_id) || "站点" : "平台"}</p><small>{visibleActivityTarget(item, names.releases)}</small></div></article>)}{milestones.length === 0 && <Empty>这个应用还没有联邦活动。</Empty>}</div></section>;
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
      <div className="effect-legend">{siteSeries.map((series) => <span key={series.siteId}><i className="effect-legend__line" aria-hidden="true" style={{ background: series.color }} />{siteNames[series.siteId] || series.siteId}</span>)}</div>
      <div className="effect-chart__scroll"><svg className="effect-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="各站点效果随联邦轮次的变化折线图">
        {[.5, .6, .7, .8, .9, 1].map((tick) => <g key={tick}><line className="effect-chart__grid" x1={bounds.left} y1={y(tick)} x2={width - bounds.right} y2={y(tick)} /><text className="effect-chart__axis" x={bounds.left - 10} y={y(tick) + 4} textAnchor="end">{percentFormatter.format(tick)}</text></g>)}
        {labels.map((label, index) => labels.length <= 10 || index === labels.length - 1 || index % Math.ceil(labels.length / 8) === 0 ? <text className="effect-chart__axis" key={label} x={x(index)} y={height - 16} textAnchor="middle"><title>{index === 0 ? label : trend.rounds[index - 1].roundId}</title>{label}</text> : null)}
        {siteSeries.map((series) => <g key={series.siteId}><path className="effect-chart__site-line" d={chartPath(series.values, x, y)} stroke={series.color} />{series.values.map((value, index) => value === null ? null : <circle key={index} className="effect-chart__point" cx={x(index)} cy={y(value)} r="3.5" fill={series.color}><title>{`${siteNames[series.siteId] || series.siteId}，${labels[index]}，${percentFormatter.format(value)}`}</title></circle>)}</g>)}
      </svg></div>
    </>}
  </section>;
}

function trackNodeLabel(node: SiteTrackNode) {
  return ({
    included: "已参与本次联邦",
    available: "有数据，但未纳入本次联邦",
    missing: "本次未上传数据",
    not_selected: "未选择该站点下发",
    queued: "已发送，等待站点接收",
    received: "站点已接收版本",
    failed: "下发失败",
    using: "当前正在使用",
    used: "曾使用，之后更新到新版本",
    kept_previous: "已收到，但仍保留原版本",
    rolled_back: "使用后已回退",
    unknown: "站点尚未上报是否采用",
    not_applicable: "本节点无需执行",
    returned: "已返回测试结果",
    waiting: "尚未返回测试结果",
  } as const)[node.state];
}

function trackNodeTone(node: SiteTrackNode) {
  if (["included", "received", "using", "used", "returned"].includes(node.state)) return "complete";
  if (["failed", "rolled_back"].includes(node.state)) return "failed";
  if (["available", "queued", "kept_previous", "unknown", "waiting"].includes(node.state)) return "waiting";
  return "inactive";
}

const trackGuide: Array<{ kind: SiteTrackNode["kind"]; label: string; description: string }> = [
  { kind: "contribution", label: "待联邦数据", description: "站点提交本轮输入" },
  { kind: "distribute", label: "联邦版本下发", description: "平台发送版本到站点" },
  { kind: "update", label: "联邦版本更新", description: "站点确认使用该版本" },
  { kind: "evaluation", label: "测试结果返回", description: "站点返回该版本评测" },
];

function SiteOperationTracks({ memberships, releases, activities, submissions }: { memberships: Membership[]; releases: ReleaseSummary[]; activities: Activity[]; submissions: Submission[] }) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const ordered = releases.slice().sort((left, right) => left.created_at.localeCompare(right.created_at));
  const releaseNames = Object.fromEntries(releaseLabels(releases));
  const currentReports = Object.fromEntries(memberships.map((member) => [member.site_id, { releaseId: member.reported_release_id, reportedAt: member.federation_version_reported_at }]));
  const tracks = buildSiteTracks(memberships.map((member) => member.site_id), activities, releases, currentReports, submissions);
  const members = Object.fromEntries(memberships.map((member) => [member.site_id, member]));
  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline) timeline.scrollLeft = timeline.scrollWidth;
  }, [releases.length]);
  return <section className="version-panel track-panel"><div className="section-head"><div><p className="eyebrow">联邦过程</p><h2>站点运行轨迹</h2></div><span>最新版本在右侧</span></div>
    <div className="track-guide">{trackGuide.map((item) => <div key={item.kind}><i className={`track-mark track-mark--${item.kind}`} aria-hidden="true" /><span><strong>{item.label}</strong><small>{item.description}</small></span></div>)}</div>
    <div className="track-state-guide" aria-label="节点状态说明"><span><i className="track-state track-state--complete" aria-hidden="true" />完成</span><span><i className="track-state track-state--waiting" aria-hidden="true" />等待或保留旧版</span><span><i className="track-state track-state--failed" aria-hidden="true" />失败或回退</span><span><i className="track-state track-state--inactive" aria-hidden="true" />未参与或未上报</span></div>
    {tracks.length === 0 ? <Empty>还没有站点接入这个应用。</Empty> : releases.length === 0 ? <Empty>还没有可追踪的联邦版本。</Empty> : <div className="track-table__viewport" ref={timelineRef}><div className="track-table" style={{ gridTemplateColumns: `200px repeat(${ordered.length}, 216px)` }}>
      <div className="track-table__corner">站点</div>
      {ordered.map((release) => <div className="track-table__version" key={release.release_id}><strong>{releaseNames[release.release_id]}</strong><time>{formatTime(release.created_at)}</time></div>)}
      {tracks.map((track) => {
        const member = members[track.siteId];
        const current = member.reported_release_id ? releaseNames[member.reported_release_id] || "历史版本" : "尚未上报";
        return <div className="track-table__row" key={track.siteId}>
          <div className="track-table__site"><strong>{visibleName(member.display_name)}</strong><span>当前 {current}</span></div>
          {ordered.map((release, releaseIndex) => <div className="track-cycle" key={release.release_id} role="group" aria-label={`${visibleName(member.display_name)} ${releaseNames[release.release_id]}`}>
            {track.nodes.slice(releaseIndex * 4, releaseIndex * 4 + 4).map((node) => <span className="track-cycle__node" key={node.kind} title={trackNodeLabel(node)} role="img" aria-label={`${trackGuide.find((item) => item.kind === node.kind)?.label}：${trackNodeLabel(node)}`}><i className={`track-mark track-mark--${node.kind} track-mark--${trackNodeTone(node)}`} aria-hidden="true" /></span>)}
          </div>)}
        </div>;
      })}
    </div></div>}
  </section>;
}

function Evaluations({ items, memberships }: { items: Submission[]; memberships: Membership[] }) {
  const percent = (value: unknown) => typeof value === "number" ? percentFormatter.format(value) : "暂无";
  const rows = latestEvaluationRows(groupEvaluationResults(items));
  const siteNames = Object.fromEntries(memberships.map((member) => [member.site_id, visibleName(member.display_name)]));
  const rounds = new Map(buildEvaluationTrend(rows).rounds.map((round, index) => [round.roundId, `第 ${index + 1} 轮`]));
  return <div className="panel-stack"><EffectChart rows={rows} siteNames={siteNames} /><section className="table-wrap"><div className="section-head"><div><p className="eyebrow">每轮站点结果</p><h2>结果明细</h2></div><span>{rows.length} 条结果</span></div><table><thead><tr><th>轮次</th><th>站点</th><th>联邦前</th><th>联邦后</th><th>结果</th><th>上传时间</th></tr></thead><tbody>{rows.map((row) => { const change = row.baseline === null || row.candidate === null ? null : row.candidate - row.baseline; const result = change === null ? "等待联邦结果" : change > 0.0001 ? "提升" : change < -0.0001 ? "下降" : "持平"; return <tr key={row.key}><td>{rounds.get(row.roundId) || "本轮"}</td><td><strong>{siteNames[row.siteId] || "站点"}</strong></td><td>{percent(row.baseline)}</td><td>{percent(row.candidate)}</td><td><span className={`evaluation-result evaluation-result--${result === "提升" ? "up" : result === "下降" ? "down" : result === "持平" ? "same" : "waiting"}`}>{result}</span></td><td>{formatTime(row.createdAt)}</td></tr>; })}</tbody></table>{rows.length === 0 && <Empty>还没有站点上传效果结果。</Empty>}</section></div>;
}

function VersionManagement({ appId, federationId, topology, submissions, releases, activities, onRefresh }: {
  appId: string;
  federationId: string;
  topology: Topology;
  submissions: Submission[];
  releases: ReleaseSummary[];
  activities: Activity[];
  onRefresh: () => Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState(releases[0]?.release_id || "");
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [busy, setBusy] = useState<"generate" | "distribute" | "">("");
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
  const latestRelease = releases[0] || null;
  const contributionRows = siteContributionRows(topology.memberships, submissions, latestRelease?.created_at || null);
  const newCount = contributionRows.filter((row) => row.state === "new").length;
  const selected = releases.find((release) => release.release_id === selectedId) || null;
  const selectedDetail = detail?.release_id === selectedId ? detail : null;
  const requestedStageSites = new Set(activities.filter((item) => item.action === "release.stage.requested" && item.target_id === selectedId && Array.isArray(item.detail.site_ids)).flatMap((item) => item.detail.site_ids as string[]));
  const stageableSites = selectedDetail?.deliveries.filter((delivery) => (delivery.state === "pending" && !requestedStageSites.has(delivery.site_id)) || (delivery.state === "failed" && delivery.failed_action === "stage")).map((delivery) => delivery.site_id) || [];
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
  useEffect(() => { setSelectedSites(stageableSites); }, [selectedId, stageableSites.join("|")]);

  async function generate() {
    setBusy("generate");
    setMessage(null);
    try {
      const readySubmissions = contributionRows.flatMap((row) => row.state === "new" && row.submission ? [row.submission] : []);
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
    if (!selected || selectedSites.length === 0) return;
    setBusy("distribute");
    setMessage(null);
    try {
      await api(`${base}/releases/${selected.release_id}/stage`, {
        method: "POST",
        body: JSON.stringify({ site_ids: selectedSites }),
      });
      setMessage({ tone: "success", text: `已向 ${selectedSites.length} 个站点发出下发命令。` });
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
        <div className="section-head"><div><p className="eyebrow">下一联邦版本</p><h2>待联邦数据</h2></div><span>{newCount} / {contributionRows.length} 可用于生成</span></div>
        <div className="contribution-list">{contributionRows.map((row) => <div key={row.site_id}><span><strong>{visibleName(row.display_name)}</strong></span><span><Status value={row.state === "new" ? "可用于生成" : row.state === "included" ? "等待新数据" : "尚未提交"} /><time>{row.submission ? formatTime(row.submission.created_at) : "暂无"}</time></span></div>)}</div>
        {contributionRows.length === 0 && <Empty>还没有站点接入这个应用。</Empty>}
        <div className="version-panel__action"><span>{newCount > 0 ? `将使用 ${newCount} 个站点的新数据，其他站点本次不参与。` : "至少需要 1 个站点上传新数据。"}</span><button className="button button--primary" type="button" disabled={newCount === 0 || busy !== ""} onClick={generate}>{busy === "generate" ? "生成中…" : "联邦生成"}</button></div>
      </section>

      <section className="version-panel version-library">
        <div className="section-head"><div><p className="eyebrow">可下发</p><h2>联邦版本库</h2></div><span>{releases.length} 个联邦版本</span></div>
        <div className="version-options">{releases.map((release) => {
          const requested = new Set(activities.filter((item) => item.action === "release.stage.requested" && item.target_id === release.release_id && Array.isArray(item.detail.site_ids)).flatMap((item) => item.detail.site_ids as string[]));
          const failed = (release.deliveries || []).filter((delivery) => requested.has(delivery.site_id) && delivery.state === "failed").length;
          const waiting = (release.deliveries || []).filter((delivery) => requested.has(delivery.site_id) && delivery.state === "pending").length;
          const deliveryLabel = requested.size === 0 ? "未下发" : failed > 0 ? `${failed} 个失败` : waiting > 0 ? `${waiting} 个等待` : `${requested.size} 个已接收`;
          return <button key={release.release_id} type="button" className={release.release_id === selectedId ? "version-option selected" : "version-option"} aria-pressed={release.release_id === selectedId} onClick={() => setSelectedId(release.release_id)}><span className="version-option__radio" aria-hidden="true" /><span><strong>{labels.get(release.release_id)}</strong><small>{formatTime(release.created_at)}</small></span><span className="version-option__delivery">{deliveryLabel}</span></button>;
        })}</div>
        {releases.length === 0 && <Empty>还没有生成联邦版本。</Empty>}
        {selected && detail && stageableSites.length > 0 && <fieldset className="delivery-targets"><legend>选择下发站点</legend>{stageableSites.map((siteId) => <label key={siteId}><input type="checkbox" name="delivery-site" value={siteId} checked={selectedSites.includes(siteId)} onChange={(event) => setSelectedSites((current) => event.target.checked ? [...current, siteId] : current.filter((item) => item !== siteId))} /><span>{visibleName(topology.memberships.find((member) => member.site_id === siteId)?.display_name || siteId)}</span></label>)}</fieldset>}
        <div className="version-panel__action"><span>{selected ? `已选择 ${labels.get(selected.release_id) || "联邦版本"}` : "先选择一个版本"}</span><button className="button" type="button" disabled={!selected || !detail || selectedSites.length === 0 || busy !== ""} onClick={distribute}>{busy === "distribute" ? "下发中…" : stageableSites.length > 0 ? `下发至 ${selectedSites.length} 个站点` : "暂无待下发站点"}</button></div>
      </section>
    </div>

    <SiteOperationTracks memberships={topology.memberships} releases={releases} activities={activities} submissions={submissions} />
  </div>;
}

export default function App() {
  const { path, navigate } = usePath();
  return <Shell path={path} navigate={navigate} />;
}
