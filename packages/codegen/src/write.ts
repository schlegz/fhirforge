import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GeneratedFiles } from './generate.js';

/**
 * Writes generated files into `outDir`, replacing whatever was there so
 * removed types don't linger. Only touches `outDir`.
 */
export async function writeGenerated(outDir: string, generated: GeneratedFiles): Promise<number> {
  await mkdir(outDir, { recursive: true });
  for (const entry of await readdir(outDir)) {
    await rm(join(outDir, entry), { recursive: true, force: true });
  }
  for (const [path, contents] of generated.files) {
    const full = join(outDir, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }
  return generated.files.size;
}
