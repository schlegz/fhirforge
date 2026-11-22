import type { DefinitionSource } from '../src/index.js';

/**
 * Where tests get R4 definitions. Defaults to hl7.fhir.r4.core@4.0.1 from the
 * registry (downloaded once into ~/.fhir/packages). Set FHIRFORGE_R4_SOURCE to
 * a local folder to run offline.
 */
export const r4Source: DefinitionSource = process.env.FHIRFORGE_R4_SOURCE
  ? { kind: 'directory', path: process.env.FHIRFORGE_R4_SOURCE }
  : { kind: 'package', name: 'hl7.fhir.r4.core', version: '4.0.1' };
