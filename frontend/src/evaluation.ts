export type EvaluationInput = {
  site_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type EvaluationRow = {
  key: string;
  roundId: string;
  experimentId: string | null;
  siteId: string;
  baseline: number | null;
  candidate: number | null;
  createdAt: string;
};

export type EvaluationTrend = {
  rounds: Array<{ roundId: string; createdAt: string }>;
  siteIds: string[];
  valuesBySite: Record<string, Array<number | null>>;
};

export type SiteTrackNode = {
  kind: "contribution" | "distribute" | "update" | "evaluation";
  state:
    | "included" | "available" | "missing"
    | "not_selected" | "queued" | "received" | "failed"
    | "using" | "used" | "kept_previous" | "rolled_back" | "unknown" | "not_applicable"
    | "returned" | "waiting";
  releaseId: string;
};

export type TrackSubmission = {
  submission_id: string;
  site_id: string;
  purpose: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type TrackRelease = {
  release_id: string;
  created_at: string;
  version_label?: string | null;
  deliveries?: Array<{ site_id: string; state: string }>;
};

export function groupEvaluationResults(items: EvaluationInput[]) {
  const grouped = new Map<string, EvaluationRow>();
  for (const item of items) {
    const roundId = String(item.metadata.round_id || "未标记");
    const explicitExperiment = typeof item.metadata.experiment_id === "string" ? item.metadata.experiment_id : null;
    // ponytail: legacy rounds encode the experiment in "*-rN"; remove after all apps send experiment_id.
    const inferredExperiment = roundId.match(/^(.*)-r\d+$/)?.[1] || null;
    const key = `${roundId}:${item.site_id}`;
    const row = grouped.get(key) || {
      key,
      roundId,
      experimentId: explicitExperiment || inferredExperiment,
      siteId: item.site_id,
      baseline: null,
      candidate: null,
      createdAt: item.created_at,
    };
    if (typeof item.metadata.baseline_accuracy === "number") row.baseline = item.metadata.baseline_accuracy;
    if (typeof item.metadata.candidate_accuracy === "number") row.candidate = item.metadata.candidate_accuracy;
    if (item.created_at > row.createdAt) row.createdAt = item.created_at;
    grouped.set(key, row);
  }
  return Array.from(grouped.values());
}

export function latestEvaluationRows(rows: EvaluationRow[]) {
  const grouped = rows.filter((row) => row.experimentId !== null);
  if (grouped.length === 0) return rows;
  const latest = grouped.reduce((current, row) => row.createdAt > current.createdAt ? row : current);
  return rows.filter((row) => row.experimentId === latest.experimentId);
}

export function buildEvaluationTrend(rows: EvaluationRow[]): EvaluationTrend {
  const rounds = Array.from(new Map(rows.map((row) => [row.roundId, row.createdAt])).entries())
    .map(([roundId, createdAt]) => ({
      roundId,
      createdAt: rows.filter((row) => row.roundId === roundId).reduce(
        (earliest, row) => row.createdAt < earliest ? row.createdAt : earliest,
        createdAt,
      ),
    }))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const siteIds = Array.from(new Set(rows.map((row) => row.siteId))).sort();
  const valuesBySite = Object.fromEntries(siteIds.map((siteId) => {
    const siteRows = rows.filter((row) => row.siteId === siteId);
    const firstBaseline = rounds
      .map(({ roundId }) => siteRows.find((row) => row.roundId === roundId)?.baseline ?? null)
      .find((value) => value !== null) ?? null;
    return [siteId, [firstBaseline, ...rounds.map(({ roundId }) => (
      siteRows.find((row) => row.roundId === roundId)?.candidate ?? null
    ))]];
  }));
  return {
    rounds,
    siteIds,
    valuesBySite,
  };
}

type ActivityInput = {
  created_at: string;
  action: string;
  site_id: string | null;
  target_id: string;
  detail?: Record<string, unknown>;
};

export function buildSiteTracks(
  siteIds: string[],
  activities: ActivityInput[],
  releases: TrackRelease[],
  currentReports: Record<string, { releaseId: string | null; reportedAt: string | null }>,
  submissions: TrackSubmission[],
) {
  const ordered = releases.slice().sort((left, right) => left.created_at.localeCompare(right.created_at));
  const releaseIndex = new Map(ordered.map((release, index) => [release.release_id, index]));
  const metadataValue = (activity: ActivityInput, key: string) => {
    const metadata = activity.detail?.artifact_metadata;
    return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[key] : undefined;
  };
  const reportedRelease = (activity: ActivityInput) => {
    const reported = activity.detail?.reported_release_id;
    return typeof reported === "string" ? reported : activity.target_id === "none" ? null : activity.target_id;
  };
  const submissionSites = new Map(submissions.map((submission) => [submission.submission_id, submission.site_id]));
  for (const activity of activities) {
    if (activity.action === "submission.accepted" && activity.site_id) submissionSites.set(activity.target_id, activity.site_id);
  }

  return siteIds.map((siteId) => {
    if (ordered.length === 0) return { siteId, nodes: [] as SiteTrackNode[] };
    const siteActivity = activities.filter((activity) => activity.site_id === siteId);
    const nodes: SiteTrackNode[] = [];

    ordered.forEach((release, index) => {
      const previousAt = ordered[index - 1]?.created_at || "";
      const generation = activities
        .filter((activity) => activity.action === "generation.requested"
          && activity.detail?.round_id === release.version_label
          && activity.created_at <= release.created_at)
        .sort((left, right) => left.created_at.localeCompare(right.created_at)).at(-1);
      const selectedInputs = new Set(Array.isArray(generation?.detail?.submission_ids)
        ? generation.detail.submission_ids.filter((value): value is string => typeof value === "string")
        : []);
      const included = selectedInputs.size > 0
        ? Array.from(selectedInputs).some((id) => submissionSites.get(id) === siteId)
        : submissions.some((submission) => submission.site_id === siteId
          && submission.purpose === "contribution"
          && submission.metadata.round_id === release.version_label);
      const available = submissions.some((submission) => submission.site_id === siteId
        && submission.purpose === "contribution"
        && submission.created_at > previousAt
        && submission.created_at <= release.created_at);

      const delivery = release.deliveries?.find((item) => item.site_id === siteId);
      const requested = activities.some((activity) => activity.action === "release.stage.requested"
        && activity.target_id === release.release_id
        && Array.isArray(activity.detail?.site_ids)
        && activity.detail.site_ids.includes(siteId));
      const selectedForDistribution = requested || Boolean(delivery && delivery.state !== "pending");
      const distributionState: SiteTrackNode["state"] = !selectedForDistribution
        ? "not_selected"
        : delivery?.state === "failed"
          ? "failed"
          : !delivery || delivery.state === "pending"
            ? "queued"
            : "received";

      const versionReports = siteActivity
        .filter((activity) => activity.action === "site.version.reported" && activity.created_at >= release.created_at)
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
      const adopted = versionReports.find((activity) => reportedRelease(activity) === release.release_id);
      const rolledBack = adopted && versionReports.some((activity) => {
        if (activity.created_at <= adopted.created_at) return false;
        const next = reportedRelease(activity);
        return next === null || (releaseIndex.get(next) ?? Number.POSITIVE_INFINITY) < index;
      });
      const current = currentReports[siteId];
      let adoptionState: SiteTrackNode["state"] = "not_applicable";
      if (selectedForDistribution && distributionState !== "failed") {
        if (rolledBack) adoptionState = "rolled_back";
        else if (current?.releaseId === release.release_id) adoptionState = "using";
        else if (adopted) adoptionState = "used";
        else if (current?.reportedAt && current.reportedAt >= release.created_at) adoptionState = "kept_previous";
        else adoptionState = "unknown";
      }

      const returned = siteActivity.some((activity) => activity.action === "evaluation.received"
        && metadataValue(activity, "candidate_release_id") === release.release_id);
      nodes.push(
        { kind: "contribution", state: included ? "included" : available ? "available" : "missing", releaseId: release.release_id },
        { kind: "distribute", state: distributionState, releaseId: release.release_id },
        { kind: "update", state: adoptionState, releaseId: release.release_id },
        { kind: "evaluation", state: returned ? "returned" : selectedForDistribution && distributionState !== "failed" ? "waiting" : "not_applicable", releaseId: release.release_id },
      );
    });
    return { siteId, nodes };
  });
}
