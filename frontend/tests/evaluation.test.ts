import assert from "node:assert/strict";
import test from "node:test";
import { buildEvaluationTrend, buildSiteTracks, groupEvaluationResults, latestEvaluationRows } from "../src/evaluation.ts";

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

test("distinguishes missing input, selective delivery, adoption and rollback", () => {
  const tracks = buildSiteTracks(["site-a", "site-b", "site-c"], [
    { created_at: "2026-01-01T01:00:00Z", action: "generation.requested", site_id: null, target_id: "job-1", detail: { round_id: "trial-r1", submission_ids: ["submission-a1"] } },
    { created_at: "2026-01-02T01:00:00Z", action: "release.stage.requested", site_id: null, target_id: "release-1", detail: { site_ids: ["site-a", "site-b"] } },
    { created_at: "2026-01-02T02:00:00Z", action: "site.version.reported", site_id: "site-a", target_id: "release-1", detail: { reported_release_id: "release-1" } },
    { created_at: "2026-01-02T03:00:00Z", action: "evaluation.received", site_id: "site-a", target_id: "evaluation-1", detail: { artifact_metadata: { candidate_release_id: "release-1" } } },
    { created_at: "2026-01-03T01:00:00Z", action: "generation.requested", site_id: null, target_id: "job-2", detail: { round_id: "trial-r2", submission_ids: ["submission-a2"] } },
    { created_at: "2026-01-04T01:00:00Z", action: "release.stage.requested", site_id: null, target_id: "release-2", detail: { site_ids: ["site-a"] } },
    { created_at: "2026-01-04T02:00:00Z", action: "site.version.reported", site_id: "site-a", target_id: "release-2", detail: { reported_release_id: "release-2" } },
    { created_at: "2026-01-05T00:00:00Z", action: "site.version.reported", site_id: "site-a", target_id: "release-1", detail: { reported_release_id: "release-1" } },
  ], [
    { release_id: "release-1", created_at: "2026-01-02T00:00:00Z", version_label: "trial-r1", deliveries: [{ site_id: "site-a", state: "staged" }, { site_id: "site-b", state: "staged" }, { site_id: "site-c", state: "pending" }] },
    { release_id: "release-2", created_at: "2026-01-04T00:00:00Z", version_label: "trial-r2", deliveries: [{ site_id: "site-a", state: "active" }, { site_id: "site-b", state: "pending" }, { site_id: "site-c", state: "pending" }] },
  ], {
    "site-a": { releaseId: "release-1", reportedAt: "2026-01-05T00:00:00Z" },
    "site-b": { releaseId: null, reportedAt: "2026-01-03T00:00:00Z" },
    "site-c": { releaseId: null, reportedAt: null },
  }, [
    { submission_id: "submission-a1", site_id: "site-a", purpose: "contribution", created_at: "2026-01-01T00:00:00Z", metadata: { round_id: "trial-r1" } },
    { submission_id: "submission-b1", site_id: "site-b", purpose: "contribution", created_at: "2026-01-01T00:10:00Z", metadata: { round_id: "trial-r1" } },
    { submission_id: "submission-a2", site_id: "site-a", purpose: "contribution", created_at: "2026-01-03T00:00:00Z", metadata: { round_id: "trial-r2" } },
  ]);

  assert.deepEqual(tracks[0].nodes.map((node) => node.state), ["included", "received", "using", "returned", "included", "received", "rolled_back", "waiting"]);
  assert.deepEqual(tracks[1].nodes.slice(0, 4).map((node) => node.state), ["available", "received", "kept_previous", "waiting"]);
  assert.deepEqual(tracks[2].nodes.slice(0, 4).map((node) => node.state), ["missing", "not_selected", "not_applicable", "not_applicable"]);
});
