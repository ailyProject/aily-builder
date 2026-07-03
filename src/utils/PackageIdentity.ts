export function extractPackageIdentityFromPath(rawPath?: string, fallbackName?: string): string {
  if (!rawPath) {
    return '';
  }

  const segments = rawPath.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    const identity = extractPackageIdentityFromSegment(segments[i]);
    if (identity) {
      return identity;
    }
  }

  const versionSegment = segments[segments.length - 1] || '';
  const nameSegment = fallbackName || segments[segments.length - 2] || '';
  if (nameSegment && isVersionLike(versionSegment)) {
    return `${nameSegment}@${versionSegment}`;
  }

  return '';
}

export function collectPackageIdentitiesFromPaths(paths: Array<string | undefined>): string[] {
  const identities = new Set<string>();
  for (const rawPath of paths) {
    const identity = extractPackageIdentityFromPath(rawPath);
    if (identity) {
      identities.add(identity);
    }
  }
  return Array.from(identities).sort();
}

function extractPackageIdentityFromSegment(segment: string): string {
  const atMatch = /^(.+?)@(.+)$/.exec(segment);
  if (atMatch && atMatch[1] && atMatch[2]) {
    return `${atMatch[1]}@${atMatch[2]}`;
  }

  const combinedMatch = /^(.+?)[_-]v?(\d+(?:[._-]\d+)+(?:[-._A-Za-z0-9]*)?)$/.exec(segment);
  if (combinedMatch && combinedMatch[1] && combinedMatch[2]) {
    return `${combinedMatch[1]}@${combinedMatch[2]}`;
  }

  return '';
}

function isVersionLike(value: string): boolean {
  return /^\d+(?:[._-]\d+)+(?:[-._A-Za-z0-9]*)?$/.test(value);
}
