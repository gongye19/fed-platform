import { FormEvent, lazy, ReactNode, Suspense, useEffect, useRef, useState, type MouseEvent } from "react";
import { buildEvaluationTrend, groupEvaluationResults, latestEvaluationRows, type EvaluationRow } from "./evaluation";
import { dataCodes, federationCodes, latestReleaseGroup, latestReleaseInstances, siteCodes } from "./versions";

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
  submission_number: number;
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
  generation_job_id: string | null;
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
  inputs: ReleaseInput[];
  deliveries: Delivery[];
};
type ReleaseInput = Pick<Submission, "submission_id" | "submission_number" | "site_id" | "artifact_digest" | "created_at">;
type Delivery = {
  delivery_id: string;
  site_id: string;
  state: string;
  failed_action: string | null;
  last_error: string | null;
  targeted_at: string;
  is_current: boolean;
  has_used: boolean;
  updated_at: string;
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

function Status({ value }: { value: string }) {
  const tone = ["failed", "disabled", "offline", "reject", "失败", "下降", "下发失败", "站点处理失败"].includes(value)
    ? "bad"
    : ["pending", "running", "staged", "retry", "等待", "等待接收", "已接收，未采用", "尚未连接", "待分发", "已暂存", "未提交", "尚未提交", "等待新数据", "尚未上报", "尚未采用"].includes(value)
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
  if (section === "overview") return ["submissions", "releases"];
  if (section === "evaluations") return ["evaluations", "submissions", "releases"];
  if (section === "versions") return ["submissions", "releases"];
  return ["submissions", "releases", "activities"];
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
      {section === "overview" && <div className="panel-stack"><ApplicationSites topology={topology} submissions={submissions} releases={currentFederationReleases} /></div>}
      {section === "evaluations" && <Evaluations items={evaluations} memberships={topology.memberships} submissions={submissions} releases={currentFederationReleases} />}
      {section === "versions" && <VersionManagement appId={appId} federationId={federationId} topology={topology} submissions={submissions} releases={currentFederationReleases} onRefresh={async () => { await Promise.all([loadTopology(true), ...(["submissions", "releases"] as ChannelResource[]).map((resource) => loadResource(resource, true))]); }} />}
      {section === "timeline" && <ActivityTimeline items={activities} memberships={topology.memberships} submissions={submissions} releases={currentFederationReleases} />}
      {section === "logs" && <ActivityLog items={activities} memberships={topology.memberships} submissions={submissions} releases={currentFederationReleases} />}
    </>}
  </>;
}

function applicationCodes(memberships: Membership[], submissions: Submission[], releases: ReleaseSummary[]) {
  const sites = siteCodes(memberships);
  const data = dataCodes(submissions, memberships);
  return { sites, data, releases: federationCodes(releases, data) };
}

function ApplicationSites({ topology, submissions, releases }: { topology: Topology; submissions: Submission[]; releases: ReleaseSummary[] }) {
  const codes = applicationCodes(topology.memberships, submissions, releases);
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">已接入应用</p><h2>站点</h2></div><span>{topology.memberships.length} 个站点</span></div><table><thead><tr><th>站点</th><th>站点应用版本</th><th>当前联邦版本</th><th>连接状态</th><th>最后上传</th></tr></thead><tbody>{topology.memberships.map((member) => <tr key={member.site_id}><td><strong>{codes.sites.get(member.site_id) || "站点未编号"}</strong></td><td>{member.app_version || "尚未上报"}</td><td>{member.reported_release_id ? codes.releases.get(member.reported_release_id) || "历史联邦版本" : "尚未上报"}</td><td><Status value={member.last_seen_at ? "已连接" : "尚未连接"} /></td><td>{formatTime(member.last_seen_at)}</td></tr>)}</tbody></table>{topology.memberships.length === 0 && <Empty>站点首次使用应用专属 API Key 上传成功后，会自动显示在这里。</Empty>}</section>;
}

function visibleActivityTarget(item: Activity, labels: Map<string, string>) {
  return item.target_type === "release" ? labels.get(item.target_id) || "联邦版本" : activityTargetLabel(item.target_type);
}

function ActivityTimeline({ items, memberships, submissions, releases }: { items: Activity[]; memberships: Membership[]; submissions: Submission[]; releases: ReleaseSummary[] }) {
  const names = applicationCodes(memberships, submissions, releases);
  const milestones = items.filter((item) => item.source === "event" || item.action.startsWith("release.")).slice(0, 50);
  return <section className="activity-panel"><div className="section-head"><div><p className="eyebrow">联邦过程</p><h2>时间线</h2></div><span>最近 {milestones.length} 个节点</span></div><div className="timeline">{milestones.map((item, index) => <article key={`${item.created_at}-${index}`} className="timeline__item"><time>{formatTime(item.created_at)}</time><span className="timeline__node" aria-hidden="true" /><div><div className="timeline__title"><strong>{activityLabel(item.action)}</strong><Status value={resultLabel(item.result)} /></div><p>{item.site_id ? names.sites.get(item.site_id) || "站点" : "平台"}</p><small>{visibleActivityTarget(item, names.releases)}</small></div></article>)}{milestones.length === 0 && <Empty>这个应用还没有联邦活动。</Empty>}</div></section>;
}

function ActivityLog({ items, memberships, submissions, releases }: { items: Activity[]; memberships: Membership[]; submissions: Submission[]; releases: ReleaseSummary[] }) {
  const names = applicationCodes(memberships, submissions, releases);
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

function EffectChart({ rows, siteNames, versionNames }: { rows: EvaluationRow[]; siteNames: Record<string, string>; versionNames: Map<string, string> }) {
  const trend = buildEvaluationTrend(rows);
  const labels = ["联邦前", ...trend.rounds.map((item) => versionNames.get(item.roundId) || "未关联版本")];
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
      <div className="effect-chart__scroll"><svg className="effect-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="各站点在不同联邦版本下的效果折线图">
        {[.5, .6, .7, .8, .9, 1].map((tick) => <g key={tick}><line className="effect-chart__grid" x1={bounds.left} y1={y(tick)} x2={width - bounds.right} y2={y(tick)} /><text className="effect-chart__axis" x={bounds.left - 10} y={y(tick) + 4} textAnchor="end">{percentFormatter.format(tick)}</text></g>)}
        {labels.map((label, index) => labels.length <= 10 || index === labels.length - 1 || index % Math.ceil(labels.length / 8) === 0 ? <text className="effect-chart__axis" key={`${label}-${index}`} x={x(index)} y={height - 16} textAnchor="middle">{label}</text> : null)}
        {siteSeries.map((series) => <g key={series.siteId}><path className="effect-chart__site-line" d={chartPath(series.values, x, y)} stroke={series.color} />{series.values.map((value, index) => value === null ? null : <circle key={index} className="effect-chart__point" cx={x(index)} cy={y(value)} r="3.5" fill={series.color}><title>{`${siteNames[series.siteId] || series.siteId}，${labels[index]}，${percentFormatter.format(value)}`}</title></circle>)}</g>)}
      </svg></div>
    </>}
  </section>;
}

function deliveryLabel(delivery: Delivery) {
  if (delivery.state === "failed") return delivery.failed_action === "stage" ? "下发失败" : "站点处理失败";
  if (delivery.state === "pending") return "等待接收";
  if (delivery.is_current) return "正在使用";
  if (delivery.has_used) return "曾使用，已切换";
  return "已接收，未采用";
}

function FederationVersionTable({ releases, siteNames, dataNames, versionNames }: {
  releases: ReleaseSummary[];
  siteNames: Map<string, string>;
  dataNames: Map<string, string>;
  versionNames: Map<string, string>;
}) {
  return <section className="table-wrap version-table"><div className="section-head"><div><p className="eyebrow">已生成版本</p><h2>联邦版本</h2></div><span>{releases.length} 个版本</span></div>
    <div className="version-table__scroll"><table><thead><tr><th>版本编号</th><th>生成时间</th><th>使用的站点数据</th></tr></thead><tbody>{releases.map((release) => <tr key={release.release_id}>
      <td><code className="release-code" translate="no">{versionNames.get(release.release_id) || "数据未关联"}</code></td>
      <td><time>{formatTime(release.created_at)}</time></td>
      <td><div className="version-table__items">{release.inputs?.length > 0 ? release.inputs.map((input) => <span key={input.submission_id}><strong>{dataNames.get(input.submission_id) || "数据未编号"}</strong><small>{siteNames.get(input.site_id) || "站点未编号"}</small></span>) : <em>输入未关联</em>}</div></td>
    </tr>)}</tbody></table></div>
    {releases.length === 0 && <Empty>还没有生成联邦版本。</Empty>}
  </section>;
}

function Evaluations({ items, memberships, submissions, releases }: { items: Submission[]; memberships: Membership[]; submissions: Submission[]; releases: ReleaseSummary[] }) {
  const percent = (value: unknown) => typeof value === "number" ? percentFormatter.format(value) : "暂无";
  const rows = latestEvaluationRows(groupEvaluationResults(items));
  const codes = applicationCodes(memberships, submissions, releases);
  const siteNames = Object.fromEntries(codes.sites);
  const versionNames = new Map(releases.flatMap((release) => release.version_label ? [[release.version_label, codes.releases.get(release.release_id) || "数据未关联"]] : []));
  return <div className="panel-stack"><EffectChart rows={rows} siteNames={siteNames} versionNames={versionNames} /><section className="table-wrap"><div className="section-head"><div><p className="eyebrow">各版本站点结果</p><h2>结果明细</h2></div><span>{rows.length} 条结果</span></div><table><thead><tr><th>联邦版本</th><th>站点</th><th>联邦前</th><th>联邦后</th><th>结果</th><th>上传时间</th></tr></thead><tbody>{rows.map((row) => { const change = row.baseline === null || row.candidate === null ? null : row.candidate - row.baseline; const result = change === null ? "等待联邦结果" : change > 0.0001 ? "提升" : change < -0.0001 ? "下降" : "持平"; return <tr key={row.key}><td>{versionNames.get(row.roundId) || "未关联版本"}</td><td><strong>{siteNames[row.siteId] || "站点未编号"}</strong></td><td>{percent(row.baseline)}</td><td>{percent(row.candidate)}</td><td><span className={`evaluation-result evaluation-result--${result === "提升" ? "up" : result === "下降" ? "down" : result === "持平" ? "same" : "waiting"}`}>{result}</span></td><td>{formatTime(row.createdAt)}</td></tr>; })}</tbody></table>{rows.length === 0 && <Empty>还没有站点上传效果结果。</Empty>}</section></div>;
}

function VersionManagement({ appId, federationId, topology, submissions, releases, onRefresh }: {
  appId: string;
  federationId: string;
  topology: Topology;
  submissions: Submission[];
  releases: ReleaseSummary[];
  onRefresh: () => Promise<void>;
}) {
  const visibleReleases = latestReleaseInstances(releases);
  const [selectedId, setSelectedId] = useState(visibleReleases[0]?.release_id || "");
  const contributions = submissions.filter((item) => item.purpose === "contribution" && item.status === "accepted");
  const usedInputs = new Set(visibleReleases.flatMap((release) => (release.inputs || []).map((input) => input.submission_id)));
  const [selectedInputs, setSelectedInputs] = useState<string[]>(() => contributions.filter((item) => !usedInputs.has(item.submission_id)).map((item) => item.submission_id));
  const selectedInputSet = new Set(selectedInputs);
  const [selectedSites, setSelectedSites] = useState<string[]>([]);
  const [busy, setBusy] = useState<"generate" | "distribute" | "">("");
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
  const selected = visibleReleases.find((release) => release.release_id === selectedId) || null;
  const deliveredSites = new Set((selected?.deliveries || []).filter((delivery) => delivery.state !== "failed" || delivery.failed_action !== "stage").map((delivery) => delivery.site_id));
  const stageableSites = topology.memberships.filter((member) => member.can_receive && !deliveredSites.has(member.site_id)).map((member) => member.site_id);
  const deliveriesBySite = new Map((selected?.deliveries || []).map((delivery) => [delivery.site_id, delivery]));
  const codes = applicationCodes(topology.memberships, submissions, releases);
  const useCount = new Map<string, number>();
  visibleReleases.forEach((release) => (release.inputs || []).forEach((input) => useCount.set(input.submission_id, (useCount.get(input.submission_id) || 0) + 1)));

  useEffect(() => {
    if (!selectedId || !visibleReleases.some((release) => release.release_id === selectedId)) {
      setSelectedId(visibleReleases[0]?.release_id || "");
    }
  }, [releases, selectedId]);
  useEffect(() => { setSelectedSites([]); }, [selectedId]);

  async function generate() {
    setBusy("generate");
    setMessage(null);
    try {
      const readySubmissions = contributions.filter((item) => selectedInputSet.has(item.submission_id));
      const requested = await api<AgentJob>(`${base}/agent/generations`, {
        method: "POST",
        body: JSON.stringify({
          round_id: `selection-${Date.now().toString(36)}`,
          submission_ids: readySubmissions.map((item) => item.submission_id),
        }),
      });
      let job = requested;
      for (let attempt = 0; attempt < 180 && !["succeeded", "failed"].includes(job.status); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
        job = await api<AgentJob>(`${base}/agent/jobs/${requested.job_id}`);
      }
      if (job.status !== "succeeded") throw new Error(job.last_error || "联邦 Agent 生成超时");
      const release = await api<{ release_id: string }>(`${base}/releases/generate`, { method: "POST", body: JSON.stringify({ generation_job_id: requested.job_id }) });
      await onRefresh();
      setSelectedId(release.release_id);
      setSelectedInputs([]);
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
      setSelectedSites([]);
    } catch (reason) {
      setMessage({ tone: "error", text: reason instanceof Error ? reason.message : "版本下发失败" });
    } finally { setBusy(""); }
  }

  return <div className="version-workbench">
    {message && <p className={`message message--${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}<button onClick={() => setMessage(null)} aria-label="关闭消息">×</button></p>}
    <FederationVersionTable releases={visibleReleases} siteNames={codes.sites} dataNames={codes.data} versionNames={codes.releases} />
    <section className="version-panel contribution-panel">
      <div className="section-head"><div><p className="eyebrow">选择站点上传数据</p><h2>联邦生成</h2></div><span>已选 {selectedInputs.length} / {contributions.length}</span></div>
      <div className="batch-groups">{topology.memberships.map((member) => { const siteContributions = contributions.filter((submission) => submission.site_id === member.site_id); return <section className="batch-group" key={member.site_id}><div className="batch-group__head"><strong>{codes.sites.get(member.site_id) || "站点未编号"}</strong><span>{siteContributions.length} 份数据</span></div><div className="batch-group__list">{siteContributions.map((submission) => <label key={submission.submission_id} className={selectedInputSet.has(submission.submission_id) ? "batch-option selected" : "batch-option"}><input type="checkbox" name="generation-input" value={submission.submission_id} checked={selectedInputSet.has(submission.submission_id)} onChange={(event) => setSelectedInputs((current) => event.target.checked ? [...current, submission.submission_id] : current.filter((item) => item !== submission.submission_id))} /><span><strong>{codes.data.get(submission.submission_id) || "数据未编号"}</strong><small>{formatTime(submission.created_at)}</small></span><em>{useCount.get(submission.submission_id) ? `已用于 ${useCount.get(submission.submission_id)} 个版本` : "尚未使用"}</em></label>)}{siteContributions.length === 0 && <p className="batch-group__empty">暂无上传数据</p>}</div></section>; })}</div>
      {contributions.length === 0 && <Empty>还没有站点上传可联邦数据。</Empty>}
      <div className="version-panel__action"><button className="text-button" type="button" disabled={contributions.length === 0 || busy !== ""} onClick={() => setSelectedInputs(contributions.filter((item) => !usedInputs.has(item.submission_id)).map((item) => item.submission_id))}>选择尚未使用的数据</button><button className="button button--primary" type="button" disabled={selectedInputs.length === 0 || busy !== ""} onClick={generate}>{busy === "generate" ? "生成中…" : `用 ${selectedInputs.length} 份数据生成`}</button></div>
    </section>

    <section className="version-panel distribution-panel">
      <div className="section-head"><div><p className="eyebrow">选择版本和目标站点</p><h2>版本下发</h2></div><span>{selected ? codes.releases.get(selected.release_id) : "暂无版本"}</span></div>
      <div className="distribution-body">
        <fieldset className="release-options"><legend>联邦版本</legend><div className="release-options__list">{visibleReleases.map((release) => <label className="release-option" key={release.release_id}><input type="radio" name="delivery-release" value={release.release_id} checked={selectedId === release.release_id} onChange={(event) => setSelectedId(event.target.value)} /><span><code className="release-code" translate="no">{codes.releases.get(release.release_id) || "数据未关联"}</code><time>{formatTime(release.created_at)}</time></span><small>{release.inputs?.length || 0} 份输入数据</small></label>)}{visibleReleases.length === 0 && <p className="release-options__empty">暂无联邦版本</p>}</div></fieldset>
        <fieldset className="delivery-targets" disabled={!selected}><legend>下发站点</legend>{topology.memberships.filter((member) => member.can_receive).map((member) => { const delivery = deliveriesBySite.get(member.site_id); const delivered = deliveredSites.has(member.site_id); return <label className="target-option" key={member.site_id}><input type="checkbox" name="delivery-site" value={member.site_id} disabled={delivered} checked={selectedSites.includes(member.site_id)} onChange={(event) => setSelectedSites((current) => event.target.checked ? [...current, member.site_id] : current.filter((item) => item !== member.site_id))} /><span><strong>{codes.sites.get(member.site_id) || "站点未编号"}</strong><small>{delivery ? deliveryLabel(delivery) : "可下发"}</small></span></label>; })}</fieldset>
      </div>
      <div className="version-panel__action"><span>{selectedSites.length > 0 ? `将下发给 ${selectedSites.length} 个站点` : stageableSites.length > 0 ? "请选择下发目标" : "所有可用站点均已下发"}</span><button className="button" type="button" disabled={!selected || selectedSites.length === 0 || busy !== ""} onClick={distribute}>{busy === "distribute" ? "下发中…" : "下发所选版本"}</button></div>
    </section>
  </div>;
}

export default function App() {
  const { path, navigate } = usePath();
  return <Shell path={path} navigate={navigate} />;
}
