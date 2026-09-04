import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationTrend, compareWithPreviousVersion, groupEvaluationResults, latestEvaluationRows } from "../src/evaluation.ts";

test("combines baseline and candidate reports per round and site", () => {
  const rows = groupEvaluationResults([
    { site_id: "site-a", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6 } },
    { site_id: "site-a", created_at: "2026-01-01T00:01:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6, candidate_accuracy: 0.8, retrieval_cases: 3, sample_size: 10 } },
    { site_id: "site-b", created_at: "2026-01-01T00:02:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.7 } },
  ]);

  assert.deepEqual(rows, [
    { key: "round-1:site-a", roundId: "round-1", experimentId: null, siteId: "site-a", baseline: 0.6, candidate: 0.8, createdAt: "2026-01-01T00:01:00Z" },
    { key: "round-1:site-b", roundId: "round-1", experimentId: null, siteId: "site-b", baseline: 0.7, candidate: null, createdAt: "2026-01-01T00:02:00Z" },
  ]);
});

test("shows only the latest experiment while retaining its federation rounds", () => {
  const rows = groupEvaluationResults([
    { site_id: "site-a", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "old-run-r1", candidate_accuracy: 0.7 } },
    { site_id: "site-a", created_at: "2026-01-02T00:00:00Z", metadata: { round_id: "current-run-r1", candidate_accuracy: 0.8 } },
    { site_id: "site-a", created_at: "2026-01-03T00:00:00Z", metadata: { round_id: "current-run-r2", candidate_accuracy: 0.9 } },
    { site_id: "site-a", created_at: "2026-01-04T00:00:00Z", metadata: { round_id: "current-run-r3", candidate_accuracy: 0.95 } },
  ]);

  assert.deepEqual(latestEvaluationRows(rows).map((row) => row.roundId), ["current-run-r1", "current-run-r2", "current-run-r3"]);
});

test("builds site trends in chronological round order", () => {
  const rows = groupEvaluationResults([
    { site_id: "site-a", created_at: "2026-01-02T00:00:00Z", metadata: { round_id: "round-2", baseline_accuracy: 0.6, candidate_accuracy: 0.9, sample_size: 10 } },
    { site_id: "site-a", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6, candidate_accuracy: 0.8, sample_size: 10 } },
    { site_id: "site-b", created_at: "2026-01-01T00:01:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.7, candidate_accuracy: 0.7, sample_size: 20 } },
    { site_id: "site-b", created_at: "2026-01-02T00:01:00Z", metadata: { round_id: "round-2", baseline_accuracy: 0.7, candidate_accuracy: 0.85, sample_size: 20 } },
  ]);
  const trend = buildEvaluationTrend(rows);

  assert.deepEqual(trend.rounds.map((round) => round.roundId), ["round-1", "round-2"]);
  assert.deepEqual(trend.valuesBySite, { "site-a": [0.6, 0.8, 0.9], "site-b": [0.7, 0.7, 0.85] });
});

test("compares each result with the site's previous federation version", () => {
  const rows = groupEvaluationResults([
    { site_id: "site-a", created_at: "2026-01-03T00:00:00Z", metadata: { round_id: "round-3", baseline_accuracy: 0.65, candidate_accuracy: 0.85 } },
    { site_id: "site-a", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "round-1", baseline_accuracy: 0.6, candidate_accuracy: 0.85 } },
    { site_id: "site-a", created_at: "2026-01-02T00:00:00Z", metadata: { round_id: "round-2", baseline_accuracy: 0.7, candidate_accuracy: 0.8 } },
  ]);

  assert.deepEqual(Array.from(compareWithPreviousVersion(rows)), [
    ["round-1:site-a", { before: 0.6, after: 0.85 }],
    ["round-2:site-a", { before: 0.85, after: 0.8 }],
    ["round-3:site-a", { before: 0.8, after: 0.85 }],
  ]);
});
