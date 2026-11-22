import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { extract } from 'tar';

export const DEFAULT_REGISTRY = 'https://packages.fhir.org';

export interface FetchPackageOptions {
  /** Package registry base URL. Defaults to packages.fhir.org. */
  registry?: string;
  /**
   * Cache directory. Defaults to the standard FHIR package cache (~/.fhir/packages),
   * which the HL7 tooling (IG Publisher, SUSHI, Firely) shares.
   */
  cacheDir?: string;
}

export function defaultCacheDir(): string {
  return join(homedir(), '.fhir', 'packages');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes sure a FHIR package is in the local cache and returns the path of its
 * `package/` folder. Downloads the tarball from the registry only on a cache miss.
 *
 * Registry layout (FHIR NPM package spec): GET {registry}/{name}/{version} returns the .tgz.
 */
export async function ensurePackage(
  name: string,
  version: string,
  options: FetchPackageOptions = {},
): Promise<string> {
  const cacheDir = options.cacheDir ?? defaultCacheDir();
  const target = join(cacheDir, `${name}#${version}`);
  const packageDir = join(target, 'package');
  if (await exists(packageDir)) return packageDir;

  const registry = (options.registry ?? DEFAULT_REGISTRY).replace(/\/+$/, '');
  const url = `${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
  const res = await fetch(url, { headers: { accept: 'application/gzip, application/octet-stream' } });
  if (!res.ok || !res.body) {
    throw new Error(`Could not download FHIR package ${name}#${version} from ${url}: HTTP ${res.status}`);
  }

  // Download to a temp file, extract into a temp folder, then move into place,
  // so an interrupted download never leaves a half-filled cache entry.
  const work = join(tmpdir(), `fhirforge-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const tgz = join(work, 'package.tgz');
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tgz));
    const out = join(work, 'out');
    await mkdir(out, { recursive: true });
    await extract({ file: tgz, cwd: out });
    await mkdir(cacheDir, { recursive: true });
    if (!(await exists(packageDir))) {
      await rename(out, target);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  return packageDir;
}
