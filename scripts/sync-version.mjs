#!/usr/bin/env node
//
// Mirrors package.json's version into wails.json's info.productVersion.
//
// Changesets owns the *decision* — which bump, and why, from the .changeset
// files a PR carries. But wails.json is what the build actually reads:
// build/linux/package-deb.sh sed-parses productVersion for the .deb version, the
// Makefile passes it to -ldflags, and CI compares it against the tag. Rather
// than teach changesets about a second file format, `bun run version` runs
// `changeset version` and then this.
//
// Run standalone with `bun run sync-version` after hand-editing package.json.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wailsPath = join(root, 'wails.json');

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!version) {
  throw new Error('package.json has no version field');
}

const source = readFileSync(wailsPath, 'utf8');

// A regex rather than JSON.parse + JSON.stringify: round-tripping would reformat
// the whole file and drop the key order, turning every release into a diff that
// touches every line. This rewrites exactly the one value.
const field = /("productVersion"\s*:\s*")([^"]*)(")/;
if (!field.test(source)) {
  // Loud rather than appending a second field — a wails.json without this key
  // would silently produce a 0.0.0 .deb, and the Go test would then fail with a
  // less obvious message than this one.
  throw new Error(`wails.json has no info.productVersion field to update (${wailsPath})`);
}

const previous = source.match(field)[2];
const updated = source.replace(field, `$1${version}$3`);

if (updated === source) {
  console.log(`wails.json already at ${version}`);
} else {
  writeFileSync(wailsPath, updated);
  console.log(`wails.json productVersion ${previous} -> ${version}`);
}
