export type VersionSite = { site_id: string; display_name: string };
export type VersionSubmission = {
  submission_id: string;
  site_id: string;
  purpose: string;
  created_at: string;
  artifact_digest: string;
  metadata: Record<string, unknown>;
};

export function siteContributionRows(
  sites: VersionSite[],
  submissions: VersionSubmission[],
  releasedAt: string | null,
) {
  const latest = new Map<string, VersionSubmission>();
  for (const submission of submissions) {
    if (submission.purpose !== "contribution") continue;
    const current = latest.get(submission.site_id);
    if (!current || Date.parse(submission.created_at) > Date.parse(current.created_at)) {
      latest.set(submission.site_id, submission);
    }
  }
  const cutoff = releasedAt ? Date.parse(releasedAt) : null;
  return sites.map((site) => {
    const submission = latest.get(site.site_id) || null;
    return {
      ...site,
      submission,
      state: !submission
        ? "missing"
        : cutoff === null || Date.parse(submission.created_at) > cutoff
          ? "new"
          : "included",
    } as const;
  });
}
