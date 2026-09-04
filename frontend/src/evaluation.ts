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
  sampleSize: number | null;
  createdAt: string;
};

export type EvaluationTrend = {
  rounds: Array<{ roundId: string; createdAt: string }>;
  siteIds: string[];
  valuesBySite: Record<string, Array<number | null>>;
  totals: Array<number | null>;
};

export type SiteTrackEvent = {
  at: string;
  kind: "upload" | "distribute" | "adopt" | "rollback";
  releaseId: string | null;
};

export function groupEvaluationResults(items: EvaluationInput[]) {
  const grouped = new Map<string, EvaluationRow>();
  for (const item of items) {
    const roundId = String(item.metadata.round_id || "—");
    const explicitExperiment = typeof item.metadata.experiment_id === "string" ? item.metadata.experiment_id : null;
    // ponytail: legacy demo rounds encode the experiment in "*-rN"; remove after all apps send experiment_id.
    const inferredExperiment = roundId.match(/^(.*)-r\d+$/)?.[1] || null;
    const key = `${roundId}:${item.site_id}`;
    const row = grouped.get(key) || {
      key,
      roundId,
      experimentId: explicitExperiment || inferredExperiment,
      siteId: item.site_id,
      baseline: null,
      candidate: null,
      sampleSize: null,
      createdAt: item.created_at,
    };
    if (typeof item.metadata.baseline_accuracy === "number") row.baseline = item.metadata.baseline_accuracy;
    if (typeof item.metadata.candidate_accuracy === "number") row.candidate = item.metadata.candidate_accuracy;
    if (typeof item.metadata.sample_size === "number") row.sampleSize = item.metadata.sample_size;
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

function weighted(rows: EvaluationRow[], field: "baseline" | "candidate") {
  const available = rows.filter((row) => row[field] !== null);
  if (available.length === 0) return null;
  const weight = (row: EvaluationRow) => row.sampleSize && row.sampleSize > 0 ? row.sampleSize : 1;
  const denominator = available.reduce((sum, row) => sum + weight(row), 0);
  return available.reduce((sum, row) => sum + (row[field] || 0) * weight(row), 0) / denominator;
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
  const firstRoundRows = rounds.length === 0 ? [] : rows.filter((row) => row.roundId === rounds[0].roundId);
  return {
    rounds,
    siteIds,
    valuesBySite,
    totals: [weighted(firstRoundRows, "baseline"), ...rounds.map(({ roundId }) => (
      weighted(rows.filter((row) => row.roundId === roundId), "candidate")
    ))],
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
  releaseDates: Record<string, string>,
) {
  const tracks = Object.fromEntries(siteIds.map((siteId) => [siteId, [] as SiteTrackEvent[]]));
  const append = (siteId: string, event: SiteTrackEvent) => { if (tracks[siteId]) tracks[siteId].push(event); };

  for (const activity of activities.slice().reverse()) {
    if ((activity.action === "submission.accepted" || activity.action === "evaluation.received") && activity.site_id) {
      append(activity.site_id, { at: activity.created_at, kind: "upload", releaseId: null });
      continue;
    }
    if (activity.action === "release.stage.requested") {
      const targets = Array.isArray(activity.detail?.site_ids) ? activity.detail.site_ids : [];
      for (const siteId of targets) {
        if (typeof siteId === "string") append(siteId, { at: activity.created_at, kind: "distribute", releaseId: activity.target_id });
      }
      continue;
    }
    if (activity.action !== "site.version.reported" || !activity.site_id) continue;
    const previous = typeof activity.detail?.previous_release_id === "string" ? activity.detail.previous_release_id : null;
    const current = typeof activity.detail?.reported_release_id === "string" ? activity.detail.reported_release_id : activity.target_id === "none" ? null : activity.target_id;
    const rolledBack = previous !== null && (
      current === null || (releaseDates[previous] && releaseDates[current || ""] && releaseDates[current || ""] < releaseDates[previous])
    );
    append(activity.site_id, { at: activity.created_at, kind: rolledBack ? "rollback" : "adopt", releaseId: current });
  }
  return siteIds.map((siteId) => ({ siteId, events: tracks[siteId].slice(-8) }));
}
