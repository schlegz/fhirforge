/**
 * TLS enforcement for `pg` Pools. PHI must not cross a network unencrypted, so
 * a Pool that points at a non-local host must be configured for TLS.
 *
 * Only the Pool's own configuration is checked (`ssl` option or `sslmode` /
 * `ssl` in the connection string). A custom `Database` is the app's
 * responsibility: fhirforge can't see how it connects.
 */

export interface TransportOptions {
  /**
   * Allow a non-TLS connection to a non-local host. For local development
   * against a remote dev database only; never in production.
   */
  allowInsecure?: boolean;
}

interface PoolOptionsLike {
  host?: string;
  ssl?: unknown;
  connectionString?: string;
}

// WHATWG URL is global in Node, Deno, Bun and browsers; declared here so the
// package needs neither the DOM lib nor @types/node.
declare const URL: new (input: string) => { hostname: string; searchParams: { get(name: string): string | null } };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** sslmode values that guarantee TLS. `prefer`, `allow` and `disable` don't. */
const SECURE_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

export interface TransportCheck {
  host: string | undefined;
  local: boolean;
  tls: boolean;
}

export function inspectPoolTransport(pool: unknown): TransportCheck | undefined {
  const options = (pool as { options?: PoolOptionsLike })?.options;
  if (!options || typeof options !== 'object') return undefined;

  let host = options.host;
  let tls = isTlsOption(options.ssl);
  if (options.connectionString) {
    try {
      const url = new URL(options.connectionString);
      host ??= decodeURIComponent(url.hostname) || url.searchParams.get('host') || undefined;
      const sslmode = url.searchParams.get('sslmode');
      const ssl = url.searchParams.get('ssl');
      if (sslmode && SECURE_SSLMODES.has(sslmode)) tls = true;
      if (sslmode && !SECURE_SSLMODES.has(sslmode) && options.ssl === undefined) tls = false;
      if (ssl === 'true' || ssl === '1') tls = true;
    } catch {
      // Not a URL (e.g. key=value form): fall through with what the options say.
    }
  }
  // libpq defaults: no host means a Unix socket (or PGHOST, which we can't see here).
  host ??= (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.PGHOST;
  const local = host === undefined || host === '' || host.startsWith('/') || LOCAL_HOSTS.has(host);
  return { host, local, tls };
}

/** `ssl: true` or an ssl options object both mean the connection is encrypted. */
function isTlsOption(ssl: unknown): boolean {
  return ssl === true || (ssl !== null && typeof ssl === 'object');
}

/** Throws unless the Pool uses TLS, connects locally, or `allowInsecure` is set. */
export function assertSecureTransport(pool: unknown, options: TransportOptions = {}): void {
  if (options.allowInsecure) return;
  const check = inspectPoolTransport(pool);
  if (!check || check.local || check.tls) return;
  throw new Error(
    `fhirforge: refusing a non-TLS Postgres connection to ${check.host}. ` +
      `PHI must be encrypted in transit: configure the Pool with \`ssl\` (or sslmode=require / verify-full). ` +
      `For local development only, pass { allowInsecure: true }.`,
  );
}
