export type EvaluationInput = {
  site_id: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type EvaluationRow = {
  key: string;
  roundId: string;
  siteId: string;
  baseline: number | null;
  candidate: number | null;
  retrievalCases: number | null;
  sampleSize: number | null;
  createdAt: string;
};

export function groupEvaluationResults(items: EvaluationInput[]) {
  const grouped = new Map<string, EvaluationRow>();
  for (const item of items) {
    const roundId = String(item.metadata.round_id || "—");
    const key = `${roundId}:${item.site_id}`;
    const row = grouped.get(key) || {
      key,
      roundId,
      siteId: item.site_id,
      baseline: null,
      candidate: null,
      retrievalCases: null,
      sampleSize: null,
      createdAt: item.created_at,
    };
    if (typeof item.metadata.baseline_accuracy === "number") row.baseline = item.metadata.baseline_accuracy;
    if (typeof item.metadata.candidate_accuracy === "number") row.candidate = item.metadata.candidate_accuracy;
    if (typeof item.metadata.retrieval_cases === "number") row.retrievalCases = item.metadata.retrieval_cases;
    if (typeof item.metadata.sample_size === "number") row.sampleSize = item.metadata.sample_size;
    if (item.created_at > row.createdAt) row.createdAt = item.created_at;
    grouped.set(key, row);
  }
  return Array.from(grouped.values());
}
