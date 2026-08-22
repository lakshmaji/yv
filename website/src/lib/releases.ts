// The GitHub releases feed, read in the browser.
//
// Nothing here — and nothing that renders it — writes a version down. The site
// is deployed by docs.yml, which only fires on pushes touching website/ and
// docs/, so anything resolved at build time would be stale the moment a release
// ships. The API call happens on page load instead, and the price is the same
// unauthenticated 60-per-hour budget internal/updater already lives with. Every
// caller therefore has to keep working when this throws: the fallback is a link
// to the releases page, which is exactly what the site linked to before.

export const REPO = 'lakshmaji/yv';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;
export const LATEST_URL = `${RELEASES_URL}/latest`;

export type OS = 'macos' | 'windows' | 'ubuntu';

export type Asset = {
  name: string;
  url: string;
  size: number;
  /** The `.sha256` sidecar for this artifact, when the release carries one. */
  sha256Url?: string;
};

export type Release = {
  tag: string;
  published: string;
  assets: Asset[];
};

/** Label for an OS, for buttons and filter chips. */
export const OS_LABEL: Record<OS, string> = {
  macos: 'macOS',
  windows: 'Windows',
  ubuntu: 'Ubuntu',
};

// The installer to offer per platform — the one artifact someone who just wants
// to run yv should take. Windows is the NSIS installer and not the .zip: the
// .zip exists for internal/updater, which cannot overwrite a running .exe in
// place. Linux is the AppImage for the same reason it is the only shape the
// updater accepts (see platformToken in internal/updater/updater.go) — the .deb
// lands in root-owned /usr/bin and cannot replace itself.
const INSTALLER_SUFFIX: Record<OS, string> = {
  macos: '.dmg',
  windows: '-setup.exe',
  ubuntu: '.AppImage',
};

// Sidecars, not artifacts: sign-artifact writes one of each beside every file in
// dist/, which is two thirds of a release's asset list.
const SIDECARS = ['.sha256', '.sig'];

/**
 * osOf classifies an asset by the platform infixes build.yml uploads, never by
 * its version. `.deb` gets its own arm because it is the one artifact wails
 * names without a platform token — `yv_<version>_amd64.deb`, from
 * build/linux/package-deb.sh.
 */
export function osOf(name: string): OS | null {
  if (name.includes('-macos-')) return 'macos';
  if (name.includes('-windows-')) return 'windows';
  if (name.includes('-linux-') || name.endsWith('.deb')) return 'ubuntu';
  return null;
}

/** The artifact to offer for `os`, or undefined if this release has none. */
export function installerFor(release: Release, os: OS): Asset | undefined {
  return release.assets.find(
    (a) => osOf(a.name) === os && a.name.endsWith(INSTALLER_SUFFIX[os]),
  );
}

type GhAsset = {name: string; browser_download_url: string; size: number};
type GhRelease = {
  tag_name: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
};

/**
 * fetchReleases returns the published releases, newest first.
 *
 * Drafts and prereleases are dropped, matching what the in-app updater will
 * offer — the download page and the app should never disagree about what the
 * current version is.
 */
export async function fetchReleases(limit = 30): Promise<Release[]> {
  const resp = await fetch(
    `https://api.github.com/repos/${REPO}/releases?per_page=${limit}`,
    {headers: {Accept: 'application/vnd.github+json'}},
  );
  if (!resp.ok) {
    throw new Error(`GitHub returned ${resp.status}`);
  }
  const body: GhRelease[] = await resp.json();
  return body
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({
      tag: r.tag_name,
      published: r.published_at,
      assets: toAssets(r.assets),
    }));
}

/** Folds the `.sha256`/`.sig` sidecars into the artifact they describe. */
function toAssets(assets: GhAsset[]): Asset[] {
  const hashes = new Map<string, string>();
  for (const a of assets) {
    if (a.name.endsWith('.sha256')) {
      hashes.set(a.name.slice(0, -'.sha256'.length), a.browser_download_url);
    }
  }
  return assets
    .filter((a) => !SIDECARS.some((s) => a.name.endsWith(s)))
    .map((a) => ({
      name: a.name,
      url: a.browser_download_url,
      size: a.size,
      sha256Url: hashes.get(a.name),
    }));
}

/** "42.3 MB" — release artifacts are always megabytes, so one unit is enough. */
export function formatSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
