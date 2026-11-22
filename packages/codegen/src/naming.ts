/** FHIR primitive → TypeScript type for its JSON value. */
const NUMERIC = new Set(['integer', 'unsignedInt', 'positiveInt', 'decimal', 'integer64']);

export function primitiveJsType(code: string): 'boolean' | 'number' | 'string' {
  if (code === 'boolean') return 'boolean';
  if (NUMERIC.has(code)) return 'number';
  return 'string';
}

/** `dateTime` → `FhirDateTime`. Primitive names would otherwise clash with TS keywords. */
export function primitiveAlias(code: string): string {
  return `Fhir${capitalize(code)}`;
}

export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `Patient.contact` → `PatientContact`; `Observation.referenceRange` → `ObservationReferenceRange`. */
export function nestedTypeName(path: string): string {
  return path
    .split('.')
    .map((segment) => capitalize(segment.replace('[x]', '')))
    .join('');
}

const FHIRPATH_SYSTEM = 'http://hl7.org/fhirpath/System.';

/** Maps FHIRPath system types (used for Element.id, Extension.url, ...) to a FHIR primitive. */
export function systemTypeToPrimitive(code: string): string | undefined {
  if (!code.startsWith(FHIRPATH_SYSTEM)) return undefined;
  switch (code.slice(FHIRPATH_SYSTEM.length)) {
    case 'Boolean':
      return 'boolean';
    case 'Integer':
      return 'integer';
    case 'Decimal':
      return 'decimal';
    case 'Date':
      return 'date';
    case 'DateTime':
      return 'dateTime';
    case 'Time':
      return 'time';
    default:
      return 'string';
  }
}

export function jsDoc(text: string | undefined, indent = ''): string[] {
  if (!text) return [];
  const clean = text.replace(/\*\//g, '*\\/').replace(/\s+/g, ' ').trim();
  return [`${indent}/** ${clean} */`];
}

/** A property name that needs quoting in TS. FHIR names never do, but be safe. */
export function propName(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}
