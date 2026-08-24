/**
 * Record a canvas into a video file, one frame at a time.
 *
 * `captureStream(0)` produces a track that emits a frame only when asked, so
 * the recording advances at whatever speed the drawing can manage and still
 * comes out at `fps`. A slow machine gets a slower export, not a stuttering
 * video.
 */

/**
 * Containers worth trying, best first.
 *
 * MP4 leads because X does not accept WebM, and an export that cannot be
 * posted is not an export. Chrome and Safari record MP4 directly; Firefox
 * cannot and falls back to WebM, which the caller reports so nobody is left
 * wondering why the file will not upload.
 */
const CONTAINERS = [
  { mime: "video/mp4;codecs=avc1.42E01E", ext: "mp4" },
  { mime: "video/mp4", ext: "mp4" },
  { mime: "video/webm;codecs=vp9", ext: "webm" },
  { mime: "video/webm", ext: "webm" },
] as const;

export function bestContainer(): { mime: string; ext: string } | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of CONTAINERS) {
    if (MediaRecorder.isTypeSupported(c.mime)) return { mime: c.mime, ext: c.ext };
  }
  return null;
}

export interface RecordOptions {
  width: number;
  height: number;
  fps: number;
  /** Paint one frame. */
  frame: (ctx: CanvasRenderingContext2D) => void;
  /** True once the last frame worth keeping has been drawn. */
  done: () => boolean;
  /** Stop early without saving. */
  cancelled?: () => boolean;
  onProgress?: (fraction: number) => void;
  /** Never record longer than this, whatever `done` says. */
  maxSeconds?: number;
  /** Mixed into the file, so the clip carries the sound the page played. */
  audio?: MediaStreamTrack | null;
}

export async function record(
  opts: RecordOptions,
): Promise<{ blob: Blob; ext: string } | null> {
  const container = bestContainer();
  if (!container) return null;

  const canvas = document.createElement("canvas");
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return null;

  // 0 means "only the frames I ask for".
  const stream = canvas.captureStream(0);
  if (opts.audio) stream.addTrack(opts.audio);
  const track = stream.getVideoTracks()[0] as
    | (MediaStreamTrack & { requestFrame?: () => void })
    | undefined;
  if (!track) return null;

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, {
    mimeType: container.mime,
    videoBitsPerSecond: 8_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const finished = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  const frameMs = 1_000 / opts.fps;
  const limit = (opts.maxSeconds ?? 300) * opts.fps;

  for (let i = 0; i < limit; i += 1) {
    if (opts.cancelled?.()) break;
    opts.frame(ctx);
    track.requestFrame?.();
    if (opts.done()) break;
    /**
     * Paced to real time even though frames are pushed by hand: MediaRecorder
     * timestamps what it receives by the wall clock, so pushing as fast as
     * possible produces a video a fraction of a second long.
     */
    await new Promise((r) => setTimeout(r, frameMs));
    opts.onProgress?.(i / limit);
  }

  recorder.stop();
  await finished;
  track.stop();
  // The audio track belongs to the page, not to this recording.
  if (opts.audio) stream.removeTrack(opts.audio);

  if (chunks.length === 0) return null;
  return { blob: new Blob(chunks, { type: container.mime }), ext: container.ext };
}

/** Hand a finished recording to the browser as a download. */
export function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked late: some browsers read the blob after the click returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
