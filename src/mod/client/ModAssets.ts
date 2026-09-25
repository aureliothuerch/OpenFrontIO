/**
 * The one central list of assets our features use. Feature code only refers
 * to these names, so a placeholder is swapped for the real file here without
 * touching any feature.
 *
 * Paths are relative to resources/ and go through assetUrl() (CDN aware).
 * Real mod assets belong in resources/mod/; that folder then also has to be
 * added to the patterns in src/server/PublicAssetManifest.ts (next to the
 * "sounds" pattern), and each file's source and license recorded in
 * CREDITS.md under "## Mod Assets".
 */
export const MOD_ASSETS = {
  // PLACEHOLDER – ASSET NEEDED: defcon-alarm.mp3, a short alarm/klaxon
  // (~1.5–2 s) played on every DEFCON change (see docs/mod/TODO.md). Until
  // then: an upstream sound OpenFront itself does not use (CC BY-SA 4.0, not
  // from proprietary/).
  defconAlarm: "sounds/effects/warship-lost.mp3",
} as const;
