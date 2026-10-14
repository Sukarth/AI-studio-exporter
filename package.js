/**
 * Build the Chrome Web Store package: dist/ai-studio-exporter-<version>.zip
 *
 *   npm run package
 *
 * What ships is worked out, not listed. The walk starts at manifest.json and
 * follows every file it names (scripts, pages, icons), then every script,
 * stylesheet and image those pages load, every url() in those stylesheets,
 * and every importScripts() in the service worker. So:
 *
 *   - a file something refers to but that does not exist fails the build,
 *     instead of failing for a user after install;
 *   - nothing that is not loaded ships: no tests, docs, sources, build
 *     tooling, or the README's demo gif.
 *
 * LICENSE and THIRD-PARTY.md ship too: the bundled libraries' licences require
 * their notices to travel with them.
 *
 * Then it checks the result the way the store will see it: the manifest
 * parses and declares only permissions the code can be shown to use, no file
 * loads remote code, and the archive has no duplicate or absolute paths.
 *
 * Uses the JSZip already vendored for the extension, so it needs no
 * dependencies of its own.
 *
 * @license MIT
 */
'use strict';

const fs = require('fs');
const path = require('path');
const JSZip = require('./libs/jszip.min.js');

const ROOT = __dirname;
const OUT = path.join(ROOT, 'dist');

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const problems = [];

/* --- walk the references ------------------------------------------------- */

const files = new Set(['manifest.json', 'LICENSE', 'THIRD-PARTY.md']);
const queue = [];

function add(ref, from) {
  if (!ref || /^(https?:|data:|chrome:|#|mailto:)/.test(ref)) return;
  const clean = ref.split(/[?#]/)[0];
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), clean)).replace(/^\.\//, '');
  if (rel.startsWith('..')) {
    problems.push(`${from} refers outside the extension: ${ref}`);
    return;
  }
  if (!fs.existsSync(path.join(ROOT, rel))) {
    problems.push(`${from} refers to ${rel}, which does not exist`);
    return;
  }
  if (!files.has(rel)) {
    files.add(rel);
    queue.push(rel);
  }
}

// The manifest's own references.
const icons = Object.values(manifest.icons || {}).concat(Object.values((manifest.action || {}).default_icon || {}));
for (const icon of icons) add(icon, 'manifest.json');
add((manifest.action || {}).default_popup, 'manifest.json');
add(manifest.options_page, 'manifest.json');
add((manifest.background || {}).service_worker, 'manifest.json');
for (const script of manifest.content_scripts || []) {
  for (const js of script.js || []) add(js, 'manifest.json');
  for (const css of script.css || []) add(css, 'manifest.json');
}

// Then whatever those load, transitively.
while (queue.length) {
  const file = queue.shift();
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/<(?:script|img|source)\b[^>]*\bsrc="([^"]+)"/g)) add(m[1], file);
    for (const m of text.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)) add(m[1], file);
  } else if (file.endsWith('.css')) {
    for (const m of text.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1], file);
  } else if (file.endsWith('.js')) {
    for (const call of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
      for (const m of call[1].matchAll(/['"]([^'"]+)['"]/g)) add(m[1], file);
    }
  }
}

/* --- check what the store checks ---------------------------------------- */

// Every permission must be traceable to code that needs it; an unused one is
// among the commonest reasons for a rejected submission.
const shipped = [...files].filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
const USES = {
  downloads: /chrome\.downloads\./,
  storage: /chrome\.storage\./,
  alarms: /chrome\.alarms\./,
  activeTab: /chrome\.(tabs|scripting)\./,
  scripting: /chrome\.scripting\./,
  tabs: /chrome\.tabs\./,
};
for (const permission of manifest.permissions || []) {
  const use = USES[permission];
  if (!use) problems.push(`no usage check for the "${permission}" permission; add one to USES`);
  else if (!use.test(shipped)) problems.push(`"${permission}" is requested but nothing in the package uses it`);
}

// Manifest V3 forbids remote code. A script tag pointing off-site, or a fetch
// of a script, would fail review.
for (const file of files) {
  if (!/\.(html|js)$/.test(file)) continue;
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (/<script\b[^>]*\bsrc="https?:/i.test(text)) problems.push(`${file} loads a remote script`);
}

// Store limits on the manifest's text fields. The store's listing title and
// summary come from name and description, so these are the store's limits.
if (manifest.name.length > 75) problems.push(`name is ${manifest.name.length} characters; the limit is 75`);
if (manifest.description.length > 132) problems.push(`description is ${manifest.description.length} characters; the limit is 132`);

if (problems.length) {
  console.error(`Not packaged:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}

/* --- write the archive ---------------------------------------------------- */

async function main() {
  const zip = new JSZip();
  const ordered = [...files].sort();
  let bytes = 0;
  for (const file of ordered) {
    const data = fs.readFileSync(path.join(ROOT, file));
    bytes += data.length;
    // A fixed date keeps the archive identical between runs of the same
    // source, so two packages of one version can be compared by hash.
    zip.file(file, data, { date: new Date('2026-01-01T00:00:00Z') });
  }
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 }, platform: 'UNIX' });

  fs.mkdirSync(OUT, { recursive: true });
  const name = `ai-studio-exporter-${manifest.version}.zip`;
  fs.writeFileSync(path.join(OUT, name), archive);

  console.log(`${manifest.name} ${manifest.version}`);
  console.log(`  permissions: ${(manifest.permissions || []).join(', ')}`);
  console.log(`  hosts: ${(manifest.host_permissions || []).join(', ')}`);
  console.log(`  ${ordered.length} files, ${(bytes / 1024).toFixed(0)} KB unpacked, ${(archive.length / 1024).toFixed(0)} KB zipped`);
  if (process.argv.includes('--list')) for (const file of ordered) console.log(`    ${file}`);
  console.log(`  dist/${name}`);

  if (process.argv.includes('--check')) await check(archive);
}

/**
 * Unpack the archive that was just written and run the browser suites
 * against that copy, not the source tree: a file the walk missed would pass
 * every test run from the repository and break only for people who install
 * from the store.
 */
async function check(archive) {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aise-package-'));
  try {
    const unpacked = await JSZip.loadAsync(archive);
    for (const [name, entry] of Object.entries(unpacked.files)) {
      if (entry.dir) continue;
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async('nodebuffer'));
    }
    console.log(`\nChecking the package, unpacked at ${dir}`);
    const failed = [];
    for (const suite of ['test/ui.js', 'test/ui-export.js', 'test/ui-fallback.js', 'test/ui-alarm.js']) {
      console.log(`\n${suite}`);
      const run = spawnSync(process.execPath, [suite], {
        cwd: ROOT,
        env: { ...process.env, AISE_EXTENSION_DIR: dir },
        stdio: 'inherit',
      });
      if (run.status !== 0) failed.push(suite);
    }
    if (failed.length) {
      console.error(`\nThe package failed: ${failed.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('\nThe package passes every browser suite.');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
