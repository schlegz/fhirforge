/**
 * Checks FHIR JSON examples two ways: type-checks them against the generated
 * types, and runs the store's runtime validator (the generated rules) on them.
 *
 *   tsx packages/r4/scripts/check-examples.ts [--no-types] [folder...]
 *
 * With no folder, checks packages/r4/test/examples. Point it at the official
 * examples package (hl7.fhir.r4.examples, extracted into ~/.fhir/packages)
 * for the full suite of several thousand spec examples.
 *
 * Each example becomes `const x: ResourceTypeMap['<type>'] = <json>;` in a
 * temporary file, then tsc checks them all in one run. `--no-types` skips tsc
 * and runs only the runtime validation (a few seconds for the full suite).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createValidator } from '@fhirforge/core';
import { validation } from '../src/generated/validation.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '../..');
const args = process.argv.slice(2);
const checkTypes = !args.includes('--no-types');
const given = args.filter((a) => a !== '--no-types');
const folders = given.length ? given : [join(pkgRoot, 'test/examples')];

/**
 * Examples in hl7.fhir.r4.examples@4.0.1 that break the base spec. They must
 * fail runtime validation (so the validator can't quietly get laxer).
 */
const KNOWN_INVALID: Record<string, string> = {
  'Bundle-v2-valuesets.json': 'codes with trailing whitespace',
  'CodeSystem-v2-0550.json': 'codes with trailing whitespace',
  'ImplementationGuide-fhir.json': 'missing name and status',
  'ig-r4.json': 'missing name and status',
  'Questionnaire-qs1.json': 'items without linkId',
  'SearchParameter-questionnaireresponse-extensions-QuestionnaireResponse-item-subject.json': 'id longer than 64 characters',
  ...Object.fromEntries(
    ['codesystem-extensions-CodeSystem', 'valueset-extensions-ValueSet'].flatMap((prefix) =>
      ['author', 'effective', 'end', 'keyword', 'workflow'].map((p) => [`SearchParameter-${prefix}-${p}.json`, 'missing base']),
    ),
  ),
};
const validate = createValidator(validation);
const invalid = new Map<string, string[]>(); // example path → runtime issues
let validated = 0;
let knownInvalid = 0;

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
  validated++;
  const issues = validate(json).map((i) => `${i.path} ${i.message}`);
  const known = KNOWN_INVALID[basename(file)];
  if (known) {
    knownInvalid++;
    if (issues.length === 0) invalid.set(file, [`expected invalid (${known}), but it passed validation`]);
  } else if (issues.length) {
    invalid.set(file, issues);
  }
  if (!checkTypes) continue;
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
if (checkTypes) {
  try {
    execFileSync(process.execPath, [join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', work], {
      cwd: work,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    output = String((err as { stdout?: string }).stdout ?? err);
  }
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
  process.stdout.write(`FAIL types ${file}\n${errors.map((e) => `  ${e}`).join('\n')}\n`);
}
for (const [file, issues] of invalid) {
  process.stdout.write(`FAIL validation ${file}\n${issues.map((e) => `  ${e}`).join('\n')}\n`);
}
if (checkTypes) process.stdout.write(`${sources.size - failures.size}/${sources.size} examples type-check\n`);
process.stdout.write(
  `${validated - knownInvalid - invalid.size}/${validated - knownInvalid} examples pass runtime validation` +
    (knownInvalid ? ` (${knownInvalid} known-invalid spec examples rejected as expected)` : '') +
    (skipped ? ` (${skipped} files skipped)` : '') +
    '\n',
);
process.exit(failures.size || invalid.size ? 1 : 0);
