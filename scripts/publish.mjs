#!/usr/bin/env node
/**
 * Publishes every public workspace package whose current version isn't on npm yet.
 *
 *   node scripts/publish.mjs [--dry-run] [--tag <dist-tag>]
 *
 * Each package is packed with pnpm (which turns `workspace:*` into real versions),
 * checked, and published with npm (which supports trusted publishing from
 * GitHub Actions: no npm token, automatic provenance). Run `pnpm build` first;
 * `pnpm release` does both.
 *
 * Safety checks before anything is published:
 * - the tarball holds only package.json, README.md, LICENSE and dist/
 * - no `workspace:` version is left in the packed package.json
 * - the git working tree is clean (skipped with --dry-run)
 *
 * Safe to re-run after a partial failure: published versions are skipped, also
 * when npm doesn't serve them yet and refuses the publish as a duplicate.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alreadyPublished } from './publish-errors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const tagIndex = args.indexOf('--tag');
const distTag = tagIndex === -1 ? undefined : args[tagIndex + 1];
const inCi = process.env.GITHUB_ACTIONS === 'true';

// Dependency order: a package is published after everything it depends on.
const ORDER = ['definitions', 'core', 'codegen', 'r4', 'pg', 'pglite', 'fhirforge'];
const ALLOWED = [/^package\/package\.json$/, /^package\/README\.md$/, /^package\/LICENSE$/, /^package\/dist\//];

const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });

function onNpm(name, version) {
  try {
    return run('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'ignore'] }).trim() === version;
  } catch {
    return false; // 404: not published
  }
}

if (!dryRun && run('git', ['status', '--porcelain'], { cwd: root }).trim() !== '') {
  console.error('Refusing to publish from a dirty working tree. Commit or stash first.');
  process.exit(1);
}

const out = join(root, '.release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

let published = 0;
for (const dir of ORDER) {
  const pkgDir = join(root, 'packages', dir);
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  if (pkg.private) continue;
  const id = `${pkg.name}@${pkg.version}`;

  if (onNpm(pkg.name, pkg.version)) {
    console.log(`skip ${id} (already on npm)`);
    continue;
  }
  if (!existsSync(join(pkgDir, 'dist'))) {
    console.error(`${id}: no dist/ folder. Run pnpm build first.`);
    process.exit(1);
  }

  run('pnpm', ['pack', '--pack-destination', out], { cwd: pkgDir });
  const tarball = join(out, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
  if (!existsSync(tarball)) {
    console.error(`${id}: expected ${tarball} after pnpm pack`);
    process.exit(1);
  }

  const files = run('tar', ['-tzf', tarball]).split('\n').filter(Boolean);
  const unexpected = files.filter((f) => !f.endsWith('/') && !ALLOWED.some((re) => re.test(f)));
  if (unexpected.length) {
    console.error(`${id}: unexpected files in the package:\n  ${unexpected.join('\n  ')}`);
    process.exit(1);
  }
  for (const required of ['package/README.md', 'package/LICENSE']) {
    if (!files.includes(required)) {
      console.error(`${id}: ${required.slice('package/'.length)} is missing from the package`);
      process.exit(1);
    }
  }
  const packed = run('tar', ['-xzOf', tarball, 'package/package.json']);
  if (packed.includes('workspace:')) {
    console.error(`${id}: packed package.json still contains a workspace: version`);
    process.exit(1);
  }

  // Always pass the dist-tag explicitly. npm won't implicitly tag a version
  // `latest` when a higher one exists, and `fhirforge` has a 1.0.0 name
  // placeholder (deprecated) above the 0.x releases.
  const publishArgs = ['publish', tarball, '--access', 'public', '--tag', distTag ?? 'latest'];
  if (dryRun) publishArgs.push('--dry-run');
  // In GitHub Actions, npm uses trusted publishing (OIDC) and adds provenance automatically.
  console.log(`${dryRun ? 'would publish' : 'publish'} ${id} (${files.filter((f) => !f.endsWith('/')).length} files)${inCi ? ' via trusted publishing' : ''}`);
  // Show npm's output as it runs, and keep stderr to recognize a duplicate-version refusal.
  const result = spawnSync('npm', publishArgs, { encoding: 'utf8', stdio: ['inherit', 'inherit', 'pipe'] });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (!dryRun && alreadyPublished(result.stderr ?? '')) {
      // Published by an earlier attempt, but not visible to `npm view` yet. Its tag was pushed
      // then (or will be by `git push --tags`), so don't tag or count it again.
      console.log(`skip ${id} (already published; npm doesn't serve it yet)`);
      continue;
    }
    console.error(`${id}: npm publish failed (exit code ${result.status})`);
    process.exit(1);
  }

  if (!dryRun) {
    run('git', ['tag', id], { cwd: root });
    // changesets/action reads these lines to create GitHub releases.
    console.log(`New tag: ${id}`);
  }
  published++;
}

rmSync(out, { recursive: true, force: true });
console.log(published ? `${dryRun ? 'Checked' : 'Published'} ${published} package(s).` : 'Nothing to publish.');
