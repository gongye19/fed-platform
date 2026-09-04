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
  complete: boolean;
  releaseId: string;
};

export function groupEvaluationResults(items: EvaluationInput[]) {
  const grouped = new Map<string, EvaluationRow>();
  for (const item of items) {
    const roundId = String(item.metadata.round_id || "—");
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
  releases: Array<{ release_id: string; created_at: string; version_label?: string | null }>,
  currentReleases: Record<string, string | null>,
) {
  const ordered = releases.slice().sort((left, right) => left.created_at.localeCompare(right.created_at));
  const inWindow = (activity: ActivityInput, after: string | null, before: string | null) => (
    (!after || activity.created_at > after) && (!before || activity.created_at < before)
  );
  const metadataValue = (activity: ActivityInput, key: string) => {
    const metadata = activity.detail?.artifact_metadata;
    return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>)[key] : undefined;
  };

  return siteIds.map((siteId) => {
    if (ordered.length === 0) return { siteId, nodes: [] as SiteTrackNode[] };
    const siteActivity = activities.filter((activity) => activity.site_id === siteId);
    const nodes: SiteTrackNode[] = [];

    for (const release of ordered) {
      const index = ordered.findIndex((item) => item.release_id === release.release_id);
      const previousAt = ordered[index - 1]?.created_at || null;
      const nextAt = ordered[index + 1]?.created_at || null;
      const distribution = activities.some((activity) => activity.action === "release.stage.requested" && activity.target_id === release.release_id && Array.isArray(activity.detail?.site_ids) && activity.detail.site_ids.includes(siteId));
      const reports = siteActivity
        .filter((activity) => activity.action === "site.version.reported" && inWindow(activity, release.created_at, nextAt))
        .sort((left, right) => right.created_at.localeCompare(left.created_at));
      const reportedRelease = reports.length === 0
        ? (nextAt ? null : currentReleases[siteId])
        : typeof reports[0].detail?.reported_release_id === "string" ? reports[0].detail.reported_release_id : reports[0].target_id === "none" ? null : reports[0].target_id;
      nodes.push(
        { kind: "contribution", complete: siteActivity.some((activity) => activity.action === "submission.accepted" && (release.version_label ? metadataValue(activity, "round_id") === release.version_label : inWindow(activity, previousAt, release.created_at))), releaseId: release.release_id },
        { kind: "distribute", complete: distribution, releaseId: release.release_id },
        { kind: "update", complete: reportedRelease === release.release_id, releaseId: release.release_id },
        { kind: "evaluation", complete: siteActivity.some((activity) => activity.action === "evaluation.received" && metadataValue(activity, "candidate_release_id") === release.release_id), releaseId: release.release_id },
      );
    }
    return { siteId, nodes };
  });
}
