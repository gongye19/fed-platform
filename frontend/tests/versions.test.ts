import assert from "node:assert/strict";
import test from "node:test";
import { contributionBatchNumbers, dataCodes, federationCodes, latestReleaseGroup, latestReleaseInstances, siteCodes } from "../src/versions.ts";

test("builds app-scoped site, data, and federation codes", () => {
  const sites = [{ site_id: "site-c" }, { site_id: "site-a" }, { site_id: "site-b" }];
  const submissions = [
    { submission_id: "a-1", site_id: "site-a", purpose: "contribution", created_at: "2026-01-01T00:00:00Z" },
    { submission_id: "b-eval", site_id: "site-b", purpose: "evaluation", created_at: "2026-01-01T00:01:00Z" },
    { submission_id: "b-1", site_id: "site-b", purpose: "contribution", created_at: "2026-01-01T00:02:00Z" },
    { submission_id: "c-1", site_id: "site-c", purpose: "contribution", created_at: "2026-01-01T00:03:00Z" },
  ];
  const data = dataCodes(submissions, sites);
  const releases = [{ release_id: "internal-uuid", inputs: [{ submission_id: "c-1" }, { submission_id: "a-1" }, { submission_id: "b-1" }] }];

  assert.deepEqual(Array.from(siteCodes(sites)), [["site-a", "S-01"], ["site-b", "S-02"], ["site-c", "S-03"]]);
  assert.deepEqual(Array.from(data), [["a-1", "D-01001"], ["b-1", "D-02001"], ["c-1", "D-03001"]]);
  assert.equal(federationCodes(releases, data).get("internal-uuid"), "F-01001-02001-03001");
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

test("keeps the newest release when the same inputs are generated again", () => {
  const releases = [
    { release_id: "new", created_at: "2026-01-02T00:00:00Z", inputs: [{ submission_id: "a" }, { submission_id: "b" }] },
    { release_id: "other", created_at: "2026-01-03T00:00:00Z", inputs: [{ submission_id: "c" }] },
    { release_id: "old", created_at: "2026-01-01T00:00:00Z", inputs: [{ submission_id: "b" }, { submission_id: "a" }] },
  ];

  assert.deepEqual(latestReleaseInstances(releases).map((release) => release.release_id), ["new", "other"]);
});
