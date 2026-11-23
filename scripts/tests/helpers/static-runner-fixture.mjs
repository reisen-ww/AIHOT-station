// Real snapshot/release formats with tiny synthetic data; no subprocess, network or database.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { publicFixture } from '../../../apps/web/tests/helpers/static-fixture.ts';
import { createStaticFiles } from '../../static-files.ts';
import { composeStaticSites } from '../../static-compose.ts';
import { digest, staticInventory } from '../../static-validate.ts';
import { PUBLIC_SITE_URL, STATIONS } from '../../static-runner-core.mjs';

export async function put(directory, name, body) {
  const file = path.join(directory, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
}

export async function writeRunnerSnapshot(directory, station, change = () => {}) {
  const fixture = publicFixture(3);
  fixture.manifest.station = fixture.catalog.station = station;
  change(fixture);
  const writer = await createStaticFiles(directory, PUBLIC_SITE_URL + '/' + station);
  for (const [file, body] of fixture.media) await put(directory, file, body);
  for (const [key, value] of fixture.data) {
    if (typeof value === 'string') await writer.sink.text(key, value);
    else await writer.sink.json(key, value);
  }
  const { files: _files, ...metadata } = fixture.manifest;
  return writer.finish(metadata);
}

export async function sealRunnerStation(directory, station) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'data/manifest.json'), 'utf8'));
  const files = {}; let bytes = 0;
  for (const file of (await staticInventory(directory)).filter((entry) => entry !== 'static-release.json')) {
    const body = await readFile(path.join(directory, file));
    files[file] = digest(body); bytes += body.length;
  }
  await put(directory, 'static-release.json', JSON.stringify({ schemaVersion: 1, station, revision: manifest.revision, asOf: manifest.asOf, files, bytes, routes: manifest.routes.length, poster: 'browser-png' }));
}

export async function writeRunnerStation(directory, station, change) {
  const manifest = await writeRunnerSnapshot(path.join(directory, 'data'), station, change);
  await put(directory, 'index.html', '<!doctype html><html><head><meta name="static-revision" content="' + manifest.revision + '"/>'
    + '<link rel="canonical" href="' + PUBLIC_SITE_URL + '/' + station + '/"/><meta property="og:url" content="' + PUBLIC_SITE_URL + '/' + station + '/"/>'
    + '</head><body><script src="/hot-pages/' + station + '/assets/main.js"></script></body></html>');
  await put(directory, '404.html', '<!doctype html><p>Historical address shell</p>');
  await put(directory, 'assets/main.js', '/* synthetic fixture */');
  await sealRunnerStation(directory, station);
}

export async function writeRunnerCombined(root, change) {
  const sites = {};
  for (const station of STATIONS) {
    sites[station] = path.join(root, station);
    await writeRunnerStation(sites[station], station, change);
  }
  const directory = path.join(root, 'combined');
  await composeStaticSites(sites, directory, PUBLIC_SITE_URL, 1_000_000);
  return directory;
}
