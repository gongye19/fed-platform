export function latestReleaseGroup<T extends { created_at: string; version_label?: string | null }>(releases: T[]) {
  const grouped = releases.filter((release) => release.version_label?.match(/^(.*)-r\d+$/));
  if (grouped.length === 0) return releases;
  const latest = grouped.reduce((current, release) => release.created_at > current.created_at ? release : current);
  const group = latest.version_label?.match(/^(.*)-r\d+$/)?.[1];
  const cutoff = grouped
    .filter((release) => release.version_label?.match(/^(.*)-r\d+$/)?.[1] === group)
    .reduce((earliest, release) => release.created_at < earliest ? release.created_at : earliest, latest.created_at);
  return releases.filter((release) => release.created_at >= cutoff);
}

export function releaseCode(releaseId: string) {
  return releaseId.replaceAll("-", "").slice(0, 8).toUpperCase();
}

export function releaseLabels(releases: Array<{ release_id: string }>) {
  return new Map(releases.map((release) => [release.release_id, releaseCode(release.release_id)]));
}

export function contributionBatchNumbers(submissions: Array<{
  submission_id: string;
  site_id: string;
  purpose: string;
  created_at: string;
}>) {
  const counts = new Map<string, number>();
  const numbers = new Map<string, number>();
  submissions
    .filter((submission) => submission.purpose === "contribution")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.submission_id.localeCompare(b.submission_id))
    .forEach((submission) => {
      const number = (counts.get(submission.site_id) || 0) + 1;
      counts.set(submission.site_id, number);
      numbers.set(submission.submission_id, number);
    });
  return numbers;
}
