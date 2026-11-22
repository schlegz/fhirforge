/** Quotes a Postgres identifier. Only accepts the names fhirforge generates, so nothing user-controlled ever reaches SQL text. */
export function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Refusing unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

export function checkSchemaName(schema: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error(`Invalid schema name ${JSON.stringify(schema)}: use lowercase letters, digits and underscores`);
  }
  return schema;
}

export function checkResourceType(resourceType: string): string {
  if (!/^[A-Z][A-Za-z]{0,62}$/.test(resourceType)) {
    throw new Error(`Invalid resource type ${JSON.stringify(resourceType)}`);
  }
  return resourceType;
}

export const INDEX_KINDS = ['string', 'token', 'date', 'reference', 'number', 'quantity', 'uri'] as const;
export type IndexKind = (typeof INDEX_KINDS)[number];

export interface Tables {
  schema: string;
  current: string;
  history: string;
  /** Search index table per value kind, e.g. `"fhir"."Patient_token"`. */
  index: Record<IndexKind, string>;
}

export function tablesFor(schema: string, resourceType: string): Tables {
  checkResourceType(resourceType);
  const s = ident(schema);
  const index = Object.fromEntries(
    INDEX_KINDS.map((k) => [k, `${s}.${ident(`${resourceType}_${k}`)}`]),
  ) as Record<IndexKind, string>;
  return {
    schema: s,
    current: `${s}.${ident(resourceType)}`,
    history: `${s}.${ident(`${resourceType}_history`)}`,
    index,
  };
}
