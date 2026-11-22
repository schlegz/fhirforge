import { describe, expect, it } from 'vitest';
import { alreadyPublished } from './publish-errors.mjs';

describe('alreadyPublished', () => {
  it("recognizes npm's duplicate-version errors", () => {
    expect(
      alreadyPublished(
        'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@fhirforge%2fr4 - ' +
          'You cannot publish over the previously published versions: 0.2.0.',
      ),
    ).toBe(true);
    expect(alreadyPublished('npm error code EPUBLISHCONFLICT\nnpm error publish fail Cannot publish over existing version.')).toBe(true);
  });

  it('does not treat other publish failures as success', () => {
    for (const output of [
      'npm error code E403\nnpm error 403 403 Forbidden - PUT https://registry.npmjs.org/@fhirforge%2fpg - OIDC permission denied for this action',
      "npm error code E404\nnpm error 404 The requested resource '@fhirforge/definitions@0.2.0' could not be found or you do not have permission to access it.",
      'npm error code ENEEDAUTH',
      '',
    ]) {
      expect(alreadyPublished(output), output).toBe(false);
    }
  });
});
