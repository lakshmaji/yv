import {expect, test} from 'bun:test';

import {
  decodeBuildId,
  encodeBuildId,
  fetchReleases,
  fetchReleasesPage,
  formatPublished,
  installerFor,
  osOf,
  type Release,
} from './releases';

// The names build.yml actually uploads, with the version swapped for a made-up
// one — the point of the fixture is that nothing here depends on which version
// it is. Pinned as literals rather than derived from a pattern, for the same
// reason internal/updater/updater_test.go pins them: a derived list would only
// prove the code agrees with itself.
const V = 'v1.2.3';
const NAMES = [
  `yv-macos-arm64-${V}.dmg`,
  `yv-windows-amd64-${V}-setup.exe`,
  `yv-windows-amd64-${V}.zip`,
  `yv-linux-x86_64-${V}.AppImage`,
  `yv-linux-amd64-${V}.tar.gz`,
  `yv_1.2.3_amd64.deb`,
];

const release: Release = {
  tag: V,
  published: '2026-01-01T00:00:00Z',
  assets: NAMES.map((name) => ({name, url: `https://x/${name}`, size: 1})),
};

test('osOf classifies every artifact a release carries', () => {
  expect(NAMES.map(osOf)).toEqual([
    'macos',
    'windows',
    'windows',
    'ubuntu',
    'ubuntu',
    'ubuntu',
  ]);
  expect(osOf('some-unrelated-file.txt')).toBeNull();
});

test('installerFor picks the shape a person can install', () => {
  // Not the .zip, which exists for the in-app updater; not the .deb or the
  // tarball, neither of which can replace itself.
  expect(installerFor(release, 'macos')?.name).toBe(`yv-macos-arm64-${V}.dmg`);
  expect(installerFor(release, 'windows')?.name).toBe(
    `yv-windows-amd64-${V}-setup.exe`,
  );
  expect(installerFor(release, 'ubuntu')?.name).toBe(
    `yv-linux-x86_64-${V}.AppImage`,
  );
});

test('fetchReleases folds sidecars away and drops prereleases', async () => {
  const ghAssets = [...NAMES, ...NAMES.flatMap((n) => [`${n}.sha256`, `${n}.sig`])];
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          tag_name: V,
          published_at: '2026-01-01T00:00:00Z',
          draft: false,
          prerelease: false,
          assets: ghAssets.map((name) => ({
            name,
            browser_download_url: `https://x/${name}`,
            size: 1,
          })),
        },
        {
          tag_name: 'v1.3.0-rc.1',
          published_at: '2026-02-01T00:00:00Z',
          draft: false,
          prerelease: true,
          assets: [],
        },
      ]),
    )) as typeof fetch;

  const [only, ...rest] = await fetchReleases();
  expect(rest).toHaveLength(0);
  expect(only.assets.map((a) => a.name)).toEqual(NAMES);
  expect(only.assets[0].sha256Url).toBe(`https://x/yv-macos-arm64-${V}.dmg.sha256`);
});

test('fetchReleasesPage reads hasMore off the Link header', async () => {
  const body = JSON.stringify([
    {tag_name: V, published_at: '2026-01-01T00:00:00Z', draft: false, prerelease: false, assets: []},
  ]);
  globalThis.fetch = (async () =>
    new Response(body, {
      headers: {Link: '<https://api.github.com/x?page=2>; rel="next"'},
    })) as typeof fetch;
  expect((await fetchReleasesPage(1)).hasMore).toBe(true);

  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  expect((await fetchReleasesPage(2)).hasMore).toBe(false);
});

test('encodeBuildId/decodeBuildId round-trip, and reject garbage', () => {
  const id = encodeBuildId(V, 'windows');
  expect(decodeBuildId(id)).toEqual({tag: V, os: 'windows'});
  expect(decodeBuildId(null)).toBeNull();
  expect(decodeBuildId('not-a-real-token')).toBeNull();
});

test('formatPublished renders a stable, locale-formatted date', () => {
  expect(formatPublished('2026-01-01T00:00:00Z')).toContain('2026');
});
