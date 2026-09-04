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

export function releaseLabels(releases: Array<{ release_id: string; release_number?: number; created_at: string }>) {
  const fallback = new Map(releases.slice().sort((left, right) => left.created_at.localeCompare(right.created_at)).map((release, index) => [release.release_id, index + 1]));
  return new Map(releases.map((release) => [release.release_id, `#${String(release.release_number || fallback.get(release.release_id)).padStart(4, "0")}`]));
}
