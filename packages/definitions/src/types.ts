/**
 * Minimal shapes for the FHIR conformance resources the loader reads.
 * Only the fields fhirforge uses are typed; everything else passes through.
 */

export interface ElementDefinitionType {
  code: string;
  profile?: string[];
  targetProfile?: string[];
  extension?: Extension[];
}

export interface Extension {
  url: string;
  valueString?: string;
  valueUrl?: string;
  valueUri?: string;
  valueBoolean?: boolean;
  [key: string]: unknown;
}

export interface ElementDefinitionBinding {
  strength: 'required' | 'extensible' | 'preferred' | 'example';
  valueSet?: string;
  description?: string;
  extension?: Extension[];
}

export interface ElementDefinition {
  id?: string;
  path: string;
  short?: string;
  definition?: string;
  min?: number;
  max?: string;
  type?: ElementDefinitionType[];
  contentReference?: string;
  binding?: ElementDefinitionBinding;
  isModifier?: boolean;
  isSummary?: boolean;
  sliceName?: string;
}

export interface StructureDefinition {
  resourceType: 'StructureDefinition';
  id: string;
  url: string;
  name: string;
  version?: string;
  description?: string;
  fhirVersion?: string;
  kind: 'primitive-type' | 'complex-type' | 'resource' | 'logical';
  abstract: boolean;
  type: string;
  baseDefinition?: string;
  derivation?: 'specialization' | 'constraint';
  snapshot?: { element: ElementDefinition[] };
  differential?: { element: ElementDefinition[] };
}

export interface ValueSetConcept {
  code: string;
  display?: string;
}

export interface ValueSetInclude {
  system?: string;
  version?: string;
  concept?: ValueSetConcept[];
  filter?: unknown[];
  valueSet?: string[];
}

export interface ValueSet {
  resourceType: 'ValueSet';
  id?: string;
  url: string;
  version?: string;
  name?: string;
  compose?: {
    include: ValueSetInclude[];
    exclude?: ValueSetInclude[];
  };
  expansion?: {
    contains?: Array<{ system?: string; code?: string; contains?: unknown[] }>;
  };
}

export interface CodeSystemConcept {
  code: string;
  display?: string;
  definition?: string;
  concept?: CodeSystemConcept[];
}

export interface CodeSystem {
  resourceType: 'CodeSystem';
  id?: string;
  url: string;
  version?: string;
  name?: string;
  content?: 'not-present' | 'example' | 'fragment' | 'complete' | 'supplement';
  concept?: CodeSystemConcept[];
}

export interface SearchParameter {
  resourceType: 'SearchParameter';
  id?: string;
  url: string;
  name: string;
  code: string;
  base: string[];
  type: 'number' | 'date' | 'string' | 'token' | 'reference' | 'composite' | 'quantity' | 'uri' | 'special';
  expression?: string;
  target?: string[];
  multipleOr?: boolean;
  multipleAnd?: boolean;
  modifier?: string[];
  comparator?: string[];
  chain?: string[];
}
