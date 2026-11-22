/**
 * Type-checks FHIR JSON examples against the generated types.
 *
 *   tsx packages/r4/scripts/check-examples.ts [folder...]
 *
 * With no folder, checks packages/r4/test/examples. Point it at the official
 * examples package (hl7.fhir.r4.examples, extracted into ~/.fhir/packages)
 * for the full suite of several thousand spec examples.
 *
 * Each example becomes `const x: ResourceTypeMap['<type>'] = <json>;` in a
 * temporary file, then tsc checks them all in one run.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '../..');
const folders = process.argv.slice(2).length ? process.argv.slice(2) : [join(pkgRoot, 'test/examples')];

const resourceTypes = new Set(
  readdirSync(join(pkgRoot, 'src/generated/resources')).map((f) => f.replace(/\.ts$/, '')),
);

function listJson(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listJson(full);
    return name.endsWith('.json') && name !== 'package.json' && name !== '.index.json' ? [full] : [];
  });
}

// Inside the package so the temp files resolve @fhirforge/* through its node_modules.
mkdirSync(join(pkgRoot, '.examples-tmp'), { recursive: true });
const work = mkdtempSync(join(pkgRoot, '.examples-tmp', 'run-'));
const sources = new Map<string, string>(); // temp file → example path
let skipped = 0;
for (const file of folders.flatMap(listJson)) {
  let json: { resourceType?: string };
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    skipped++;
    continue;
  }
  if (!json.resourceType || !resourceTypes.has(json.resourceType)) {
    skipped++;
    continue;
  }
  const ts = join(work, `ex${sources.size}.ts`);
  const index = relative(work, join(pkgRoot, 'src/index.js')).replace(/\\/g, '/');
  writeFileSync(
    ts,
    `import type { ResourceTypeMap } from '${index.startsWith('.') ? index : './' + index}';\n` +
      `export const example: ResourceTypeMap['${json.resourceType}'] = ${JSON.stringify(json, null, 1)};\n`,
  );
  sources.set(ts, file);
}

writeFileSync(
  join(work, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    },
    include: ['*.ts'],
  }),
);

let output = '';
try {
  execFileSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', work], {
    cwd: work,
    encoding: 'utf8',
    stdio: 'pipe',
  });
} catch (err) {
  output = String((err as { stdout?: string }).stdout ?? err);
}

const failures = new Map<string, string[]>();
for (const line of output.split('\n')) {
  const m = /^(ex\d+\.ts)\(\d+,\d+\): (error .*)$/.exec(line.trim());
  if (!m) continue;
  const example = sources.get(join(work, m[1]!))!;
  const list = failures.get(example) ?? [];
  list.push(m[2]!);
  failures.set(example, list);
}
rmSync(work, { recursive: true, force: true });

if (output && failures.size === 0) {
  // tsc failed for a reason not tied to one example (bad config, missing types).
  process.stdout.write(output);
  process.exit(1);
}

for (const [file, errors] of failures) {
  process.stdout.write(`FAIL ${file}\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
}
process.stdout.write(
  `${sources.size - failures.size}/${sources.size} examples type-check` + (skipped ? ` (${skipped} files skipped)` : '') + '\n',
);
process.exit(failures.size ? 1 : 0);
