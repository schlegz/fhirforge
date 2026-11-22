# @fhirforge/definitions

Build-time loader for official FHIR packages (e.g. `hl7.fhir.r4.core@4.0.1`): downloads from packages.fhir.org into the standard `~/.fhir/packages` cache, indexes StructureDefinitions, ValueSets, CodeSystems and SearchParameters, and builds element trees.

```ts
import { loadDefinitions, buildElementTree } from '@fhirforge/definitions';

const defs = await loadDefinitions({ kind: 'package', name: 'hl7.fhir.r4.core', version: '4.0.1' });
const patient = buildElementTree(defs.getStructureDefinition('Patient')!);
```

Used by `@fhirforge/codegen`. Apps don't need it at runtime.

Part of [fhirforge](https://github.com/schlegz/fhirforge), an embeddable FHIR storage library for Node and TypeScript. Early development: expect breaking changes in 0.x releases.

License: Apache-2.0. FHIR® is a registered trademark of HL7; this project is not affiliated with or endorsed by HL7.
