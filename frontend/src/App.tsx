import { FormEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import PlatformOverview from "./PlatformOverview";

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
type Site = {
  site_id: string;
  display_name: string;
  node_version: string | null;
  last_seen_at: string | null;
  created_at: string;
  application_count: number;
  membership_count: number;
  pending_commands: number;
};
type Federation = { federation_id: string; display_name: string; status: string };
type Membership = {
  federation_id: string;
  site_id: string;
  display_name: string;
  can_submit: boolean;
  can_receive: boolean;
  can_execute_task: boolean;
  last_seen_at: string | null;
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
  result: string;
};

const APP_SECTIONS = [
  ["overview", "概览"],
  ["sites", "站点"],
  ["versions", "版本"],
  ["evaluations", "效果"],
  ["timeline", "时间线"],
  ["activity", "活动日志"],
  ["artifacts", "工件"],
  ["contract", "契约"],
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

function formatTime(value: string | null) {
  if (!value) return "尚未连接";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function shortId(value: string, length = 18) {
  return value.length > length ? `${value.slice(0, length)}…` : value;
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
    "agent.job.completed": "Agent 已处理事件",
    "agent.job.failed": "Agent 处理失败",
    "membership.updated": "站点成员已更新",
  } as Record<string, string>)[action] || action;
}

function Status({ value }: { value: string }) {
  const tone = ["failed", "disabled", "offline", "reject"].includes(value)
    ? "bad"
    : ["pending", "running", "staged", "retry"].includes(value)
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
                  <span>{item.display_name}</span><small>{item.current_version}</small>
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
        <div className="ledger__head"><span>APPLICATION</span><span>AGENT CORE</span><span>FEDERATIONS</span><span>SITES</span><span>STATE</span></div>
        {!loading && visible.length === 0 ? <Empty>没有匹配的应用。注册第一个 FedApp Manifest 后，平台会同时创建它的 Agent。</Empty> : visible.map((item) => (
          <button className="ledger__row" key={item.app_id} onClick={() => navigate(`/apps/${encodeURIComponent(item.app_id)}/overview`)}>
            <span><strong>{item.display_name}</strong><small className="mono">{item.app_id} · v{item.current_version}</small></span>
            <span><Status value={item.agent_status} /><small className="mono">{item.core_plugin_id}</small></span>
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
  const [sites, setSites] = useState<Site[]>([]);
  const [federationId, setFederationId] = useState("");
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [evaluations, setEvaluations] = useState<Submission[]>([]);
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [selectedDigests, setSelectedDigests] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [federationModal, setFederationModal] = useState(false);
  const [membershipModal, setMembershipModal] = useState(false);

  const loadTopology = async () => {
    try {
      const [nextTopology, nextSites] = await Promise.all([
        api<Topology>(`/admin/v1/apps/${encodeURIComponent(appId)}/topology`),
        api<{ items: Site[] }>("/admin/v1/sites?limit=100"),
      ]);
      setTopology(nextTopology);
      setSites(nextSites.items);
      setFederationId((current) => nextTopology.federations.some((item) => item.federation_id === current) ? current : nextTopology.federations[0]?.federation_id || "");
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "应用加载失败"); }
  };
  const loadChannel = async () => {
    if (!federationId) { setSubmissions([]); setEvaluations([]); setReleases([]); return; }
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      const [submissionData, evaluationData, releaseData] = await Promise.all([
        api<{ items: Submission[] }>(`${base}/submissions?limit=100`),
        api<{ items: Submission[] }>(`${base}/evaluations?limit=100`),
        api<{ items: ReleaseSummary[] }>(`${base}/releases?limit=100`),
      ]);
      setSubmissions(submissionData.items);
      setEvaluations(evaluationData.items);
      setReleases(releaseData.items);
      setSelectedDigests((current) => current.filter((digest) => submissionData.items.some((item) => item.artifact_digest === digest)));
      setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "通道加载失败"); }
  };
  useEffect(() => { void loadTopology(); }, [appId]);
  useEffect(() => { void loadChannel(); setDetail(null); }, [appId, federationId]);
  useEffect(() => {
    void api<{ items: Activity[] }>(`/admin/v1/activity?app_id=${encodeURIComponent(appId)}&limit=100`)
      .then((data) => setActivities(data.items))
      .catch((reason) => setError(reason instanceof Error ? reason.message : "活动加载失败"));
  }, [appId]);

  const uniqueArtifacts = useMemo(() => Array.from(new Map(submissions.map((item) => [item.artifact_digest, item])).values()), [submissions]);
  async function createFederation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api(`/admin/v1/apps/${encodeURIComponent(appId)}/federations`, { method: "POST", body: JSON.stringify({ federation_id: form.get("federation_id"), display_name: form.get("display_name") }) });
      setFederationModal(false); setNotice("Federation 已创建。"); await loadTopology();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "创建失败"); }
  }
  async function addMembership(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const federation = String(form.get("federation_id"));
    const site = String(form.get("site_id"));
    try {
      await api(`/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federation)}/memberships/${encodeURIComponent(site)}`, { method: "PUT", body: JSON.stringify({ can_submit: form.has("can_submit"), can_receive: form.has("can_receive"), can_execute_task: form.has("can_execute_task") }) });
      setMembershipModal(false); setNotice(`${site} 的成员权限已保存。`); await loadTopology();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "保存失败"); }
  }
  async function createRelease() {
    if (!selectedDigests.length || !federationId) return;
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      await api(`${base}/releases`, { method: "POST", body: JSON.stringify({ artifact_digests: selectedDigests }) });
      setSelectedDigests([]); setNotice("不可变 Release 已创建，等待下发 stage 命令。"); await loadChannel();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发布创建失败"); }
  }
  async function openRelease(releaseId: string) {
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      setDetail(await api<ReleaseDetail>(`${base}/releases/${releaseId}`));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "发布加载失败"); }
  }
  async function deliveryAction(action: "stage" | "activate" | "rollback") {
    if (!detail) return;
    const allowed = { stage: "pending", activate: "staged", rollback: "active" }[action];
    const siteIds = detail.deliveries.filter((item) => item.state === allowed || (item.state === "failed" && item.failed_action === action)).map((item) => item.site_id);
    if (!siteIds.length) return;
    if (action !== "stage" && !window.confirm(`向 ${siteIds.length} 个站点下发 ${action} 命令？`)) return;
    try {
      const base = `/admin/v1/apps/${encodeURIComponent(appId)}/federations/${encodeURIComponent(federationId)}`;
      await api(`${base}/releases/${detail.release_id}/${action}`, { method: "POST", body: JSON.stringify({ site_ids: siteIds }) });
      setNotice(`${action} 命令已写入 ${siteIds.length} 个站点的下行通道。`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "命令下发失败"); }
  }

  if (!topology) return <><PageHeader eyebrow="Registry / Application" title={appId} meta="正在加载应用拓扑…" />{error && <ErrorMessage error={error} />}</>;
  const app = topology.application;
  const sectionLabel = APP_SECTIONS.find(([id]) => id === section)?.[1] || "概览";
  const base = `/apps/${encodeURIComponent(appId)}`;
  return <>
    <PageHeader eyebrow={`应用 / ${sectionLabel}`} title={app.display_name} meta={`${app.app_id} · v${app.current_version}`} action={<div className="header-actions"><button className="button button--quiet" onClick={() => setMembershipModal(true)} disabled={!topology.federations.length || !sites.length}>配置成员</button><button className="button button--primary" onClick={() => setFederationModal(true)}>新建联邦域</button></div>} />
    <div className="app-state"><Status value={app.status} /><span>Agent</span><Status value={app.agent_status} /><code>{app.core_plugin_id}</code></div>
    {error && <ErrorMessage error={error} />}{notice && <p className="message message--success" role="status">{notice}<button onClick={() => setNotice("")} aria-label="关闭提示">×</button></p>}
    <nav className="app-nav" aria-label={`${app.display_name} 导航`}>{APP_SECTIONS.map(([id, label]) => <button key={id} className={section === id ? "active" : ""} aria-current={section === id ? "page" : undefined} onClick={() => navigate(`${base}/${id}`)}>{label}</button>)}</nav>
    {section === "overview" && <TopologyView topology={topology} onSelect={(id) => { setFederationId(id); navigate(`${base}/artifacts`); }} />}
    {!["overview", "sites", "timeline", "activity", "contract"].includes(section) && <FederationSwitch items={topology.federations} value={federationId} onChange={setFederationId} />}
    {section === "sites" && <ApplicationSites topology={topology} sites={sites} />}
    {section === "artifacts" && <Artifacts submissions={submissions} />}
    {section === "evaluations" && <Evaluations items={evaluations} />}
    {section === "versions" && <Releases releases={releases} artifacts={uniqueArtifacts} selected={selectedDigests} onSelected={setSelectedDigests} onCreate={createRelease} detail={detail} onOpen={openRelease} onAction={deliveryAction} />}
    {section === "timeline" && <ActivityTimeline items={activities} />}
    {section === "activity" && <ActivityLog items={activities} />}
    {section === "contract" && <Contract manifest={app.manifest} />}
    {federationModal && <Modal title="新建联邦域" onClose={() => setFederationModal(false)}><form className="stack" onSubmit={createFederation}><label>联邦域 ID<input name="federation_id" required pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}" placeholder="main" /></label><label>显示名称<input name="display_name" required maxLength={160} placeholder="Main Federation" /></label><div className="dialog__actions"><button type="button" className="button button--quiet" onClick={() => setFederationModal(false)}>取消</button><button className="button button--primary">创建</button></div></form></Modal>}
    {membershipModal && <Modal title="配置成员权限" onClose={() => setMembershipModal(false)}><form className="stack" onSubmit={addMembership}><label>Federation<select name="federation_id" defaultValue={federationId}>{topology.federations.map((item) => <option key={item.federation_id} value={item.federation_id}>{item.display_name} · {item.federation_id}</option>)}</select></label><label>站点<select name="site_id">{sites.map((site) => <option key={site.site_id} value={site.site_id}>{site.display_name} · {site.site_id}</option>)}</select></label><fieldset className="checks"><legend>权限</legend><label><input type="checkbox" name="can_submit" />提交工件</label><label><input type="checkbox" name="can_receive" />接收发布</label><label><input type="checkbox" name="can_execute_task" />执行任务</label></fieldset><div className="dialog__actions"><button type="button" className="button button--quiet" onClick={() => setMembershipModal(false)}>取消</button><button className="button button--primary">保存成员</button></div></form></Modal>}
  </>;
}

function FederationSwitch({ items, value, onChange }: { items: Federation[]; value: string; onChange: (id: string) => void }) {
  return <div className="federation-switch"><span>FEDERATION</span>{items.length ? <select value={value} onChange={(event) => onChange(event.target.value)}>{items.map((item) => <option key={item.federation_id} value={item.federation_id}>{item.display_name} · {item.federation_id}</option>)}</select> : <em>请先创建 Federation</em>}</div>;
}

function TopologyView({ topology, onSelect }: { topology: Topology; onSelect: (id: string) => void }) {
  return <section className="topology"><div className="topology__legend"><span>FEDERATION TOPOLOGY</span><span>{topology.federations.length} federations · {topology.memberships.length} memberships</span></div><div className="topology__root"><p>APP FEDERATION AGENT</p><strong>{topology.application.display_name}</strong><code>{topology.application.core_plugin_id}</code></div><div className="topology__branches">{topology.federations.map((federation) => { const members = topology.memberships.filter((item) => item.federation_id === federation.federation_id); return <article className="topology__branch" key={federation.federation_id}><button className="topology__federation" onClick={() => onSelect(federation.federation_id)}><span>FEDERATION</span><strong>{federation.display_name}</strong><code>{federation.federation_id}</code></button><div className="topology__sites">{members.map((member) => <div className="topology__site" key={member.site_id}><div><strong>{member.display_name}</strong><code>{member.site_id}</code></div><Status value={member.last_seen_at ? "online" : "not-seen"} /><p>{[member.can_submit && "submit", member.can_receive && "receive", member.can_execute_task && "execute"].filter(Boolean).join(" / ") || "no permissions"}</p></div>)}{members.length === 0 && <Empty>这个 Federation 还没有成员。</Empty>}</div></article>; })}{topology.federations.length === 0 && <Empty>创建第一个 Federation，再把已注册站点加入进来。</Empty>}</div></section>;
}

function ApplicationSites({ topology, sites }: { topology: Topology; sites: Site[] }) {
  const federations = new Map(topology.federations.map((item) => [item.federation_id, item.display_name]));
  const siteDetails = new Map(sites.map((item) => [item.site_id, item]));
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">应用成员</p><h2>站点</h2></div><span>{topology.memberships.length} 个成员关系</span></div><table><thead><tr><th>站点</th><th>所属联邦域</th><th>节点版本</th><th>连接状态</th><th>权限</th><th>最后出现</th></tr></thead><tbody>{topology.memberships.map((member) => { const site = siteDetails.get(member.site_id); return <tr key={`${member.federation_id}-${member.site_id}`}><td><strong>{member.display_name}</strong><small className="mono">{member.site_id}</small></td><td><strong>{federations.get(member.federation_id) || member.federation_id}</strong><small className="mono">{member.federation_id}</small></td><td className="mono">{site?.node_version || "—"}</td><td><Status value={member.last_seen_at ? "online" : "not-seen"} /></td><td>{[member.can_submit && "上传", member.can_receive && "接收", member.can_execute_task && "执行"].filter(Boolean).join(" / ") || "无"}</td><td>{formatTime(member.last_seen_at)}</td></tr>; })}</tbody></table>{topology.memberships.length === 0 && <Empty>这个应用还没有站点。配置成员后，站点会显示在这里。</Empty>}</section>;
}

function ActivityTimeline({ items }: { items: Activity[] }) {
  const milestones = items.filter((item) => item.source === "event" || item.action.startsWith("release.")).slice(0, 50);
  return <section className="activity-panel"><div className="section-head"><div><p className="eyebrow">联邦过程</p><h2>时间线</h2></div><span>最近 {milestones.length} 个节点</span></div><div className="timeline">{milestones.map((item, index) => <article key={`${item.created_at}-${index}`} className="timeline__item"><time>{formatTime(item.created_at)}</time><span className="timeline__node" /><div><div className="timeline__title"><strong>{activityLabel(item.action)}</strong><Status value={item.result} /></div><p>{[item.site_id, item.federation_id].filter(Boolean).join(" · ") || "应用 Agent"}</p><small className="mono">{item.target_type} · {shortId(item.target_id, 30)}</small></div></article>)}{milestones.length === 0 && <Empty>这个应用还没有联邦活动。</Empty>}</div></section>;
}

function ActivityLog({ items }: { items: Activity[] }) {
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">运行记录</p><h2>活动日志</h2></div><span>最近 {items.length} 条</span></div><table><thead><tr><th>时间</th><th>活动</th><th>来源</th><th>联邦域 / 站点</th><th>对象</th><th>结果</th></tr></thead><tbody>{items.map((item, index) => <tr key={`${item.created_at}-${index}`}><td>{formatTime(item.created_at)}</td><td><strong>{activityLabel(item.action)}</strong><small className="mono">{item.action}</small></td><td>{item.source === "event" ? "站点事件" : "平台操作"}</td><td><strong>{item.federation_id || "—"}</strong><small className="mono">{item.site_id || "应用 Agent"}</small></td><td><span>{item.target_type}</span><small className="mono">{shortId(item.target_id, 22)}</small></td><td><Status value={item.result} /></td></tr>)}</tbody></table>{items.length === 0 && <Empty>这个应用还没有活动日志。</Empty>}</section>;
}

function Artifacts({ submissions }: { submissions: Submission[] }) {
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">Inbound channel</p><h2>工件提交</h2></div><span>{submissions.length} submissions</span></div><table><thead><tr><th>类型</th><th>来源站点</th><th>Digest</th><th>大小</th><th>状态</th><th>接收时间</th></tr></thead><tbody>{submissions.map((item) => <tr key={item.submission_id}><td><strong>{item.type_name}</strong><small>format v{item.format_version}</small></td><td className="mono">{item.site_id}</td><td><code title={item.artifact_digest}>{shortId(item.artifact_digest, 24)}</code></td><td>{formatBytes(item.size_bytes)}</td><td><Status value={item.status} /></td><td>{formatTime(item.created_at)}</td></tr>)}</tbody></table>{submissions.length === 0 && <Empty>当前 Federation 还没有收到工件。站点上传后会显示在这里。</Empty>}</section>;
}

function Evaluations({ items }: { items: Submission[] }) {
  const percent = (value: unknown) => typeof value === "number" ? `${(value * 100).toFixed(1)}%` : "—";
  return <section className="table-wrap"><div className="section-head"><div><p className="eyebrow">Local validation</p><h2>站点评测</h2></div><span>{items.length} reports</span></div><table><thead><tr><th>轮次</th><th>站点</th><th>当前版本</th><th>候选版本</th><th>提升 / 退步</th><th>结论</th><th>接收时间</th></tr></thead><tbody>{items.map((item) => { const meta = item.metadata; return <tr key={item.submission_id}><td className="mono">{String(meta.round_id || "—")}</td><td className="mono">{item.site_id}</td><td>{percent(meta.baseline_accuracy)}</td><td>{percent(meta.candidate_accuracy)}</td><td>{String(meta.improved ?? "—")} / {String(meta.regressed ?? "—")}</td><td><Status value={String(meta.decision || "reported")} /></td><td>{formatTime(item.created_at)}</td></tr>; })}</tbody></table>{items.length === 0 && <Empty>还没有站点返回本地评测结果。候选版本暂存后，站点会在这里报告效果。</Empty>}</section>;
}

function Releases({ releases, artifacts, selected, onSelected, onCreate, detail, onOpen, onAction }: { releases: ReleaseSummary[]; artifacts: Submission[]; selected: string[]; onSelected: (ids: string[]) => void; onCreate: () => void; detail: ReleaseDetail | null; onOpen: (id: string) => void; onAction: (action: "stage" | "activate" | "rollback") => void }) {
  const toggle = (digest: string) => onSelected(selected.includes(digest) ? selected.filter((item) => item !== digest) : [...selected, digest]);
  return <div className="release-layout"><section className="release-compose"><p className="eyebrow">不可变快照</p><h2>创建版本</h2><p className="hint">选择联邦结果并创建版本，平台会将它分发给当前可接收的站点。</p><div className="artifact-picker">{artifacts.map((item) => <label key={item.artifact_digest}><input type="checkbox" checked={selected.includes(item.artifact_digest)} onChange={() => toggle(item.artifact_digest)} /><span><strong>{item.type_name}</strong><code>{shortId(item.artifact_digest, 22)}</code></span><small>{formatBytes(item.size_bytes)}</small></label>)}{artifacts.length === 0 && <Empty>没有可发布工件。</Empty>}</div><button className="button button--primary" disabled={!selected.length} onClick={onCreate}>创建版本 · {selected.length}</button></section><section className="release-list"><div className="section-head"><div><p className="eyebrow">分发状态</p><h2>版本与站点</h2></div><span>{releases.length} 个版本</span></div>{releases.map((release) => <article className={`release-card ${detail?.release_id === release.release_id ? "active" : ""}`} key={release.release_id}><button onClick={() => onOpen(release.release_id)}><span><strong className="mono">{shortId(release.release_id, 16)}</strong><small>{formatTime(release.created_at)} · {release.artifact_digests.length} 个工件</small></span><span className="release-counts"><em>{release.pending} 待分发</em><em>{release.staged} 已暂存</em><em>{release.active} 已启用</em>{release.failed > 0 && <em className="bad">{release.failed} 失败</em>}</span></button>{detail?.release_id === release.release_id && <ReleaseDeliveries detail={detail} onAction={onAction} />}</article>)}{releases.length === 0 && <Empty>还没有版本。选择左侧联邦结果创建第一个版本。</Empty>}</section></div>;
}

function ReleaseDeliveries({ detail, onAction }: { detail: ReleaseDetail; onAction: (action: "stage" | "activate" | "rollback") => void }) {
  const can = (action: string, state: string) => detail.deliveries.some((item) => item.state === state || (item.state === "failed" && item.failed_action === action));
  return <div className="delivery-panel"><div className="delivery-actions"><button className="button button--quiet" disabled={!can("stage", "pending")} onClick={() => onAction("stage")}>Stage</button><button className="button button--primary" disabled={!can("activate", "staged")} onClick={() => onAction("activate")}>Activate</button><button className="button button--danger" disabled={!can("rollback", "active")} onClick={() => onAction("rollback")}>Rollback</button></div><div className="delivery-grid">{detail.deliveries.map((delivery) => <div key={delivery.delivery_id}><span><strong>{delivery.site_id}</strong><Status value={delivery.state} /></span>{delivery.last_error && <small className="error-text">{delivery.failed_action}: {delivery.last_error}</small>}<time>{formatTime(delivery.updated_at)}</time></div>)}</div></div>;
}

function Contract({ manifest }: { manifest: Json }) {
  const artifactTypes = Array.isArray(manifest.artifact_types) ? manifest.artifact_types as Json[] : [];
  const taskTypes = Array.isArray(manifest.task_types) ? manifest.task_types as Json[] : [];
  return <section className="contract"><div><p className="eyebrow">Declared capabilities</p><h2>应用契约</h2><dl><div><dt>Schema</dt><dd className="mono">{String(manifest.schema_version)}</dd></div><div><dt>Adapter</dt><dd className="mono">{String(manifest.adapter_protocol)}</dd></div><div><dt>Artifact types</dt><dd>{artifactTypes.length}</dd></div><div><dt>Task types</dt><dd>{taskTypes.length}</dd></div></dl><h3>Artifact Types</h3>{artifactTypes.map((item) => <div className="type-row" key={String(item.type)}><code>{String(item.type)}</code><span>{String(item.purpose || "contribution")} · {String(item.media_type)} · format v{String(item.format_version)}</span></div>)}<h3>Task Types</h3>{taskTypes.map((item) => <div className="type-row" key={String(item.type)}><code>{String(item.type)}</code><span>version {String(item.version)}</span></div>)}{!taskTypes.length && <p className="hint">未声明本地任务类型。</p>}</div><pre>{JSON.stringify(manifest, null, 2)}</pre></section>;
}

export default function App() {
  const { path, navigate } = usePath();
  return <Shell path={path} navigate={navigate} />;
}
