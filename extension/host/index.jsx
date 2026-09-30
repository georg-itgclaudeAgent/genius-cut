/*
 * Genius Cut — ExtendScript host.
 *
 * Every function is prefixed `gcut`: ExtendScript has one global namespace shared by
 * every CEP panel in Premiere (PR Extension included), so unprefixed names can clash.
 *
 * Phase C (Tasks 9-11) adds gcutFindClip, gcutApplyCuts, gcutRestoreOriginal and
 * gcutCloseTrailingGap. Until then only the version probe exists, and the panel shows
 * timeline actions as "not available yet".
 */

// eslint-disable-next-line no-unused-vars
function gcutHostVersion() {
    return "0.1.0-no-timeline";
}
