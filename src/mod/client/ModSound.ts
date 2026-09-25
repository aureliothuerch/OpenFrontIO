import type { Howl } from "howler";
import { assetUrl } from "../../core/AssetUrls";
import { MOD_ASSETS } from "./ModAssets";

/**
 * Sounds of our features, played on upstream's "alerts" channel so they
 * follow the player's volume sliders and mute settings.
 *
 * howler and the AudioMixer are loaded with a dynamic import(): this module is
 * part of GameRenderer's static import graph, and pulling howler into it
 * would load an audio stack into every test that builds a renderer (see the
 * comment in src/client/sound/CuePlayer.ts).
 */

/** The one alarm Howl, created on first use. */
let defconAlarm: Promise<Howl> | null = null;

/** The alarm on a DEFCON change. Never throws; silent without a mixer. */
export async function playDefconAlarm(): Promise<void> {
  try {
    const { audioMixer } = await import("../../client/sound/AudioMixer");
    const mixer = audioMixer();
    if (mixer === null || !mixer.isAudible("alerts")) return;
    defconAlarm ??= loadDefconAlarm();
    const howl = await defconAlarm;
    // Same pattern as AudioMixer.play: the Howl starts silent and the channel
    // level is set on the id that is starting.
    const id = howl.play();
    howl.volume(mixer.volumeFor("alerts"), id);
  } catch (err) {
    defconAlarm = null;
    console.warn("ModSound: failed to play the DEFCON alarm", err);
  }
}

async function loadDefconAlarm(): Promise<Howl> {
  const { Howl } = await import("howler");
  const howl = new Howl({
    src: [assetUrl(MOD_ASSETS.defconAlarm)],
    volume: 0,
  });
  // A file that fails to load would stay dead in the cache: drop it, so the
  // next change tries again (same reasoning as AudioMixer.discard).
  howl.once("loaderror", () => {
    defconAlarm = null;
    try {
      howl.unload();
    } catch (err) {
      console.warn("ModSound: failed to unload the DEFCON alarm", err);
    }
  });
  return howl;
}
