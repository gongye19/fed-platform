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
