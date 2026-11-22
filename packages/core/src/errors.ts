/** FHIR issue type codes used by fhirforge (a subset of http://hl7.org/fhir/issue-type). */
export type IssueCode =
  | 'invalid'
  | 'not-found'
  | 'deleted'
  | 'conflict'
  | 'not-supported'
  | 'duplicate'
  | 'exception'
  | 'forbidden';

/** A minimal OperationOutcome, shaped like the FHIR resource so HTTP adapters can return it as-is. */
export interface OperationOutcomeLike {
  resourceType: 'OperationOutcome';
  issue: Array<{ severity: 'fatal' | 'error' | 'warning' | 'information'; code: IssueCode; diagnostics?: string }>;
}

/**
 * An error with an HTTP status and a FHIR OperationOutcome. Every failure the
 * store reports on purpose is a FhirError; anything else is a bug or an
 * infrastructure problem (e.g. the database is down).
 */
export class FhirError extends Error {
  override readonly name = 'FhirError';

  constructor(
    readonly status: number,
    readonly code: IssueCode,
    message: string,
  ) {
    super(message);
  }

  get outcome(): OperationOutcomeLike {
    return {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: this.code, diagnostics: this.message }],
    };
  }

  static invalid(message: string): FhirError {
    return new FhirError(400, 'invalid', message);
  }

  static notSupported(message: string): FhirError {
    return new FhirError(400, 'not-supported', message);
  }

  static notFound(resourceType: string, id: string, versionId?: string): FhirError {
    const what = versionId ? `${resourceType}/${id}/_history/${versionId}` : `${resourceType}/${id}`;
    return new FhirError(404, 'not-found', `${what} not found`);
  }

  static gone(resourceType: string, id: string): FhirError {
    return new FhirError(410, 'deleted', `${resourceType}/${id} has been deleted`);
  }

  static duplicate(resourceType: string, id: string): FhirError {
    return new FhirError(409, 'duplicate', `${resourceType}/${id} already exists`);
  }

  static forbidden(message: string): FhirError {
    return new FhirError(403, 'forbidden', message);
  }

  /** If-Match / expected version did not match the current version. */
  static versionConflict(resourceType: string, id: string, expected: string, actual: string | undefined): FhirError {
    return new FhirError(
      412,
      'conflict',
      `${resourceType}/${id}: expected version ${expected}, current version is ${actual ?? 'none'}`,
    );
  }
}

export function isFhirError(err: unknown): err is FhirError {
  return err instanceof FhirError;
}
