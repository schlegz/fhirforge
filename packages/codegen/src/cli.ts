#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { loadDefinitions, parsePackageSpec, type DefinitionSource } from '@fhirforge/definitions';
import { generateTypes } from './generate.js';
import { writeGenerated } from './write.js';

const USAGE = `Usage:
  fhirforge-codegen --package hl7.fhir.r4.core@4.0.1 --out <dir> [--registry <url>] [--cache <dir>]
  fhirforge-codegen --source <dir> --out <dir>

  --package   FHIR package from the registry (cached in ~/.fhir/packages)
  --source    local folder of FHIR JSON (an extracted package or the spec's definition bundles)
  --out       output folder; its contents are replaced
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      package: { type: 'string' },
      source: { type: 'string' },
      out: { type: 'string' },
      registry: { type: 'string' },
      cache: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help || !values.out || (!values.package && !values.source)) {
    process.stdout.write(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  let source: DefinitionSource;
  if (values.package) {
    const { name, version } = parsePackageSpec(values.package);
    source = { kind: 'package', name, version, registry: values.registry, cacheDir: values.cache };
  } else {
    source = { kind: 'directory', path: values.source! };
  }

  const started = Date.now();
  const defs = await loadDefinitions(source);
  const generated = generateTypes(defs);
  const count = await writeGenerated(values.out!, generated);
  process.stdout.write(
    `Generated ${count} files for FHIR ${defs.fhirVersion}: ${generated.resourceTypes.length} resources, ` +
      `${generated.complexTypes.length} datatypes, ${generated.primitiveTypes.length} primitives ` +
      `in ${Date.now() - started} ms → ${values.out}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
