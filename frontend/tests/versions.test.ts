import assert from "node:assert/strict";
import test from "node:test";
import { contributionBatchNumbers, latestReleaseGroup, releaseCode, releaseLabels } from "../src/versions.ts";

test("uses stable opaque release codes without sequence semantics", () => {
  assert.equal(releaseCode("b9d463cb-b9c1-42e2-8898-6c7fbea5cc5e"), "B9D463CB");
  assert.deepEqual(Array.from(releaseLabels([
    { release_id: "b9d463cb-b9c1-42e2-8898-6c7fbea5cc5e" },
    { release_id: "8c987757-0e98-49db-a015-67ee18b0555a" },
  ])), [
    ["b9d463cb-b9c1-42e2-8898-6c7fbea5cc5e", "B9D463CB"],
    ["8c987757-0e98-49db-a015-67ee18b0555a", "8C987757"],
  ]);
});

test("keeps only the latest federation experiment releases", () => {
  const releases = [
    { release_id: "current-3", created_at: "2026-01-06T00:00:00Z", version_label: "current-r3" },
    { release_id: "current-2", created_at: "2026-01-05T00:00:00Z", version_label: "current-r2" },
    { release_id: "current-1", created_at: "2026-01-04T00:00:00Z", version_label: "current-r1" },
    { release_id: "selected-inputs", created_at: "2026-01-07T00:00:00Z", version_label: "selection-abc" },
    { release_id: "old-2", created_at: "2026-01-02T00:00:00Z", version_label: "old-r2" },
    { release_id: "old-1", created_at: "2026-01-01T00:00:00Z", version_label: "old-r1" },
  ];

  assert.deepEqual(latestReleaseGroup(releases).map((release) => release.release_id), ["current-3", "current-2", "current-1", "selected-inputs"]);
});

test("numbers contribution batches per site without counting evaluation uploads", () => {
  const numbers = contributionBatchNumbers([
    { submission_id: "a-eval", site_id: "a", purpose: "evaluation", created_at: "2026-01-02T00:00:00Z" },
    { submission_id: "a-2", site_id: "a", purpose: "contribution", created_at: "2026-01-03T00:00:00Z" },
    { submission_id: "b-1", site_id: "b", purpose: "contribution", created_at: "2026-01-02T00:00:00Z" },
    { submission_id: "a-1", site_id: "a", purpose: "contribution", created_at: "2026-01-01T00:00:00Z" },
  ]);

  assert.deepEqual(Array.from(numbers), [["a-1", 1], ["b-1", 1], ["a-2", 2]]);
});
