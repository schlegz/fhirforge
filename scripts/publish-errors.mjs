/**
 * Recognizes npm's "this version already exists" errors.
 *
 * Right after a publish, npm can take minutes to serve the new version, so the
 * "already on npm" check in publish.mjs (npm view) misses it. Re-running a
 * partly failed release in that window then tries to publish the same version
 * again, and npm refuses. That refusal means the version is already published,
 * which is what the re-run wanted.
 */
const PATTERNS = [
  // E403: "You cannot publish over the previously published versions: 0.2.0."
  /cannot publish over the previously published versions?/i,
  // E409: two publishes of the same version racing.
  /\bEPUBLISHCONFLICT\b/,
];

/** True when npm's output says this exact version is already on the registry. */
export function alreadyPublished(output) {
  return PATTERNS.some((re) => re.test(output));
}
