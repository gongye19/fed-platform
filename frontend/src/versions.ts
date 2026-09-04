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

export function siteCodes(sites: Array<{ site_id: string }>) {
  return new Map(
    [...new Set(sites.map((site) => site.site_id))]
      .sort()
      .map((siteId, index) => [siteId, `S-${String(index + 1).padStart(2, "0")}`]),
  );
}

export function dataCodes(
  submissions: Array<{ submission_id: string; site_id: string; purpose: string; created_at: string }>,
  sites: Array<{ site_id: string }>,
) {
  const sitesById = siteCodes(sites);
  const batches = contributionBatchNumbers(submissions);
  return new Map(submissions.flatMap((submission) => {
    const site = sitesById.get(submission.site_id);
    const batch = batches.get(submission.submission_id);
    return site && batch ? [[submission.submission_id, `D-${site.slice(2)}${String(batch).padStart(3, "0")}`] as const] : [];
  }));
}

export function federationCodes(
  releases: Array<{ release_id: string; inputs?: Array<{ submission_id: string }> }>,
  dataById: Map<string, string>,
) {
  return new Map(releases.map((release) => {
    const inputs = (release.inputs || []).map((input) => dataById.get(input.submission_id)).filter((code): code is string => Boolean(code)).sort();
    return [release.release_id, inputs.length === release.inputs?.length && inputs.length > 0 ? `F-${inputs.map((code) => code.slice(2)).join("-")}` : "数据未关联"];
  }));
}

export function latestReleaseInstances<T extends {
  release_id: string;
  created_at: string;
  inputs?: Array<{ submission_id: string }>;
}>(releases: T[]) {
  const latest = new Map<string, T>();
  releases.forEach((release) => {
    const inputIds = (release.inputs || []).map((input) => input.submission_id).sort();
    const key = inputIds.length > 0 ? inputIds.join(":") : release.release_id;
    const current = latest.get(key);
    if (!current || release.created_at > current.created_at) latest.set(key, release);
  });
  const visibleIds = new Set(Array.from(latest.values(), (release) => release.release_id));
  return releases.filter((release) => visibleIds.has(release.release_id));
}
