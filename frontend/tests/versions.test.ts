import assert from "node:assert/strict";
import test from "node:test";
import { latestReleaseGroup, releaseLabels } from "../src/versions.ts";

test("uses stable neutral release numbers instead of semantic versions", () => {
  assert.deepEqual(Array.from(releaseLabels([
    { release_id: "new", release_number: 41, created_at: "2026-01-02T00:00:00Z" },
    { release_id: "old", release_number: 7, created_at: "2026-01-01T00:00:00Z" },
  ])), [["new", "#0041"], ["old", "#0007"]]);
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
