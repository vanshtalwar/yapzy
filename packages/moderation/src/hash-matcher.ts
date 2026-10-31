export type HashMatch =
  | { matched: false }
  | {
      matched: true;
      /** Which hash list matched (e.g. "ncmec"). */
      list: string;
      /** The provider's reference for the matched hash (never the image). */
      reference: string;
    };

/**
 * Known-CSAM hash matching, run before any classifier.
 *
 * Production: Microsoft PhotoDNA (perceptual hashes via the PhotoDNA Cloud Service), Thorn
 * Safer, or hash lists from NCMEC's hash-sharing programme — always under an agreement with
 * the provider. A match must be preserved as evidence and reported to NCMEC's CyberTipline
 * (US providers: 18 U.S.C. § 2258A) through a documented process (see
 * docs/PRODUCTION_CHECKLIST.md). Never add, download or generate real abusive material for
 * testing — providers supply test hashes/images for integration testing.
 */
export interface HashMatcher {
  match(jpeg: Uint8Array): Promise<HashMatch>;
}

/** Development/test matcher: never matches. */
export class NoopHashMatcher implements HashMatcher {
  match(): Promise<HashMatch> {
    return Promise.resolve({ matched: false });
  }
}
