/**
 * Sound for the replay.
 *
 * Through Web Audio rather than `<audio>` elements for two reasons. Several
 * sells can land in the same second and each needs its own voice, which one
 * element cannot give — it would cut itself off. And the recorder needs the
 * sound as a MediaStream track to put in the file, which only an audio graph
 * can hand over.
 *
 * Everything here fails quietly. A browser that refuses to decode a clip, or
 * to start audio at all, should cost the sound and nothing else.
 */

export type Cue = "kaching" | "bandos";

const FILES: Record<Cue, string> = {
  kaching: "/sfx/kaching.mp3",
  /** QuickTime container, audio only — decoded by the platform, not the tag. */
  bandos: "/sfx/bandos.mov",
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let capture: MediaStreamAudioDestinationNode | null = null;
const buffers = new Map<Cue, AudioBuffer>();
let loading: Promise<void> | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = 0.6;
    master.connect(ctx.destination);
    // A second sink, so a recording can carry the same sound the page plays.
    capture = ctx.createMediaStreamDestination();
    master.connect(capture);
    return ctx;
  } catch {
    return null;
  }
}

/**
 * Decode both clips once.
 *
 * Called on a user gesture, because a browser will not start an AudioContext
 * without one and there is no point decoding into a context that cannot run.
 */
export function prepare(): Promise<void> {
  const audio = context();
  if (!audio) return Promise.resolve();
  if (audio.state === "suspended") void audio.resume();
  loading ??= Promise.all(
    (Object.keys(FILES) as Cue[]).map(async (cue) => {
      try {
        const res = await fetch(FILES[cue]);
        if (!res.ok) return;
        buffers.set(cue, await audio.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // A clip that will not decode simply never plays.
      }
    }),
  ).then(() => undefined);
  return loading;
}

/** Fire a cue. Overlapping calls each get their own voice. */
export function play(cue: Cue): void {
  const audio = ctx;
  const buffer = buffers.get(cue);
  if (!audio || !master || !buffer) return;
  if (audio.state === "suspended") void audio.resume();
  try {
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.connect(master);
    source.start();
  } catch {
    // Nothing to do; the replay carries on silently.
  }
}

/** The sound as a track, for the recorder to mix into the file. */
export function captureTrack(): MediaStreamTrack | null {
  context();
  return capture?.stream.getAudioTracks()[0] ?? null;
}
