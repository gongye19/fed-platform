import assert from "node:assert/strict";
import test from "node:test";
import { releaseLabels, siteContributionRows } from "../src/versions.ts";

test("numbers versions by creation order instead of exposing internal labels", () => {
  assert.deepEqual(Array.from(releaseLabels([
    { release_id: "new", created_at: "2026-01-02T00:00:00Z" },
    { release_id: "old", created_at: "2026-01-01T00:00:00Z" },
  ])), [["old", "版本 1"], ["new", "版本 2"]]);
});

test("shows the latest contribution from every site against the latest version", () => {
  const rows = siteContributionRows(
    [
      { site_id: "site-a", display_name: "A" },
      { site_id: "site-b", display_name: "B" },
      { site_id: "site-c", display_name: "C" },
    ],
    [
      { site_id: "site-a", purpose: "contribution", created_at: "2026-01-01T00:00:00Z", artifact_digest: "old" },
      { site_id: "site-a", purpose: "contribution", created_at: "2026-01-03T00:00:00Z", artifact_digest: "new" },
      { site_id: "site-b", purpose: "contribution", created_at: "2026-01-01T00:00:00Z", artifact_digest: "included" },
      { site_id: "site-c", purpose: "evaluation", created_at: "2026-01-04T00:00:00Z", artifact_digest: "ignored" },
    ],
    "2026-01-02T00:00:00Z",
  );

  assert.deepEqual(rows.map(({ site_id, state, submission }) => ({ site_id, state, digest: submission?.artifact_digest })), [
    { site_id: "site-a", state: "new", digest: "new" },
    { site_id: "site-b", state: "included", digest: "included" },
    { site_id: "site-c", state: "missing", digest: undefined },
  ]);
});
