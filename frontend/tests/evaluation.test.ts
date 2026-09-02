import assert from "node:assert/strict";
import test from "node:test";
import { groupEvaluationResults } from "../src/evaluation.ts";

test("combines baseline and candidate reports per round and site", () => {
  const rows = groupEvaluationResults([
    { site_id: "site-a", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6 } },
    { site_id: "site-a", created_at: "2026-01-01T00:01:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6, candidate_accuracy: 0.8, retrieval_cases: 3, sample_size: 10 } },
    { site_id: "site-b", created_at: "2026-01-01T00:02:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.7 } },
  ]);

  assert.deepEqual(rows, [
    { key: "round-1:site-a", roundId: "round-1", siteId: "site-a", baseline: 0.6, candidate: 0.8, retrievalCases: 3, sampleSize: 10, createdAt: "2026-01-01T00:01:00Z" },
    { key: "round-1:site-b", roundId: "round-1", siteId: "site-b", baseline: 0.7, candidate: null, retrievalCases: null, sampleSize: null, createdAt: "2026-01-01T00:02:00Z" },
  ]);
});
