import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Candle } from "./candles";
import type { Venue } from "./pool";

/**
 * Anything built from the chain, kept between requests.
 *
 * A token's past does not change. Rebuilding a month of it on every visit is
 * the one cost in this app that buys nothing — the bars before the last one
 * are the same bars they were an hour ago, and a wallet's trades from last
 * Tuesday will never be different. Keeping them turns a second visit from a
 * full reconstruction into a read plus whatever happened since.
 *
 * Two backends, chosen by what is configured rather than by a flag. Supabase
 * when its two environment variables are set, which is the deployed case and
 * is shared across serverless instances; otherwise a file on disk, which needs
 * no setup and is enough for `next dev` and for one long-lived server. Both
 * are caches: losing either costs time, never correctness — which is why every
 * failure here is swallowed rather than raised.
 */

const TABLE = process.env.SUPABASE_TABLE ?? "trickshot_cache";
/**
 * Where the file cache lives.
 *
 * Project-local rather than the OS temp directory. Temp is cleaned out
 * periodically by the system, and it takes the gallery of built tokens and the
 * trader boards with it — boards cost minutes to build, so losing them to a
 * housekeeping job is expensive. Deployments that mount a read-only filesystem
 * set the Supabase variables instead; the write below already fails quietly.
 */
const DIR =
  process.env.TRICKSHOT_CACHE_DIR ?? path.join(process.cwd(), ".trickshot-cache");

/**
 * The Supabase endpoint, and whichever key this instance was given.
 *
 * Deliberately not named for one key. A deployment that only serves what has
 * already been indexed wants the ANON key with a read-only policy on this one
 * table: it can read everything the site shows and cannot write, so a leak
 * costs nothing. The machine doing the indexing wants the service key. Same
 * code, different reach.
 *
 * `SUPABASE_SERVICE_ROLE_KEY` is still read as a fallback so an existing
 * setup keeps working.
 */
function supabase(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url: url.replace(/\/$/, ""), key } : null;
}

/** Hashed, so a key may contain anything and still be a filename. */
function fileFor(key: string): string {
  return path.join(DIR, `${createHash("sha256").update(key).digest("hex")}.json`);
}

export async function loadBlob<T>(key: string): Promise<T | null> {
  const remote = supabase();
  if (remote) {
    try {
      const res = await fetch(
        `${remote.url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(key)}&select=payload`,
        {
          headers: { apikey: remote.key, authorization: `Bearer ${remote.key}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (res.ok) {
        const rows = (await res.json()) as { payload?: T }[];
        /**
         * A MISS is an answer, and the answer is no.
         *
         * Falling through to disk here looked harmless and quietly broke
         * publishing: a token already built locally answered from the file
         * cache, so the indexer returned early and never wrote it upstream.
         * It reported success and the deployment saw nothing. Disk is the
         * fallback for when Supabase is ABSENT or DOWN, never a second place
         * to look when it has already said no.
         */
        return rows[0]?.payload ?? null;
      }
    } catch {
      // Unreachable, not empty. Disk may still have it, and a cache that is
      // down is a slow request rather than an error.
    }
  }

  try {
    return JSON.parse(await readFile(fileFor(key), "utf8")) as T;
  } catch {
    return null;
  }
}

export async function saveBlob(key: string, value: unknown): Promise<void> {
  const remote = supabase();
  if (remote) {
    try {
      await fetch(`${remote.url}/rest/v1/${TABLE}`, {
        method: "POST",
        headers: {
          apikey: remote.key,
          authorization: `Bearer ${remote.key}`,
          "content-type": "application/json",
          prefer: "resolution=merge-duplicates",
        },
        signal: AbortSignal.timeout(10_000),
        // `updated_at` is sent rather than left to its default so it moves on
        // an upsert too, which is when it is actually interesting.
        body: JSON.stringify({
          id: key,
          payload: value,
          updated_at: new Date().toISOString(),
        }),
      });
    } catch {
      // Best effort, as above.
    }
  }

  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(fileFor(key), JSON.stringify(value));
  } catch {
    // A read-only filesystem is the normal deployed case when Supabase is
    // configured, so this is not worth reporting.
  }
}

export interface Series {
  mint: string;
  interval: number;
  venue: Venue;
  /** Ascending, one per interval, gaps already filled. */
  candles: Candle[];
  /**
   * True only if every bar in here was built from every swap in its window.
   *
   * Stored rather than recomputed because a cached series outlives the request
   * that built it: a window served three-quarters from cache reported itself
   * exact on the strength of the one fresh bar, which is how a chart sampled
   * from 1.8 million swaps came back labelled "every trade".
   */
  exact: boolean;
  /** When the newest bar was built, so a live token can be topped up. */
  builtAt: number;
}

export const loadSeries = (mint: string, interval: number) =>
  loadBlob<Series>(`series:${mint}:${interval}`);

export const saveSeries = (series: Series) =>
  saveBlob(`series:${series.mint}:${series.interval}`, series);

/**
 * Where a token has bars finer than its own chart, so a replay can zoom in.
 *
 * Its own blob, and a tiny one, because it is read on the REQUEST path — every
 * wallet replay asks whether this mint can be zoomed. Deriving it from the
 * fine series instead means pulling that whole series to look at its first and
 * last bar: MEASURED, 1.18MB for five days of one-minute bars.
 */
export interface ZoomIndex {
  mint: string;
  /** Bar width of the fine series, seconds. */
  interval: number;
  /**
   * The CONTIGUOUS spans it covers, unix seconds, ascending.
   *
   * Ranges rather than one from/to, because a token can be built over two
   * stretches that do not touch — its launch and its best day a fortnight
   * later. Collapsed to first-bar-to-last-bar, the empty fortnight between
   * them would be advertised as zoomable, and asking for a section inside it
   * would put a live build on the request path, which is the one thing this
   * index exists to prevent.
   */
  ranges: { from: number; to: number }[];
}

export const loadZoom = (mint: string) => loadBlob<ZoomIndex>(`zoom:${mint}`);

export const saveZoom = (zoom: ZoomIndex) => saveBlob(`zoom:${zoom.mint}`, zoom);

/**
 * Which parts of a window the cache cannot answer.
 *
 * Returned as whole intervals so the caller fetches bar-aligned ranges. The
 * newest cached bar is always refetched: it was built while its own interval
 * was still open, so it is the one bar that can still change.
 */
export function missingRanges(
  series: Series | null,
  from: number,
  to: number,
  interval: number,
): { from: number; to: number }[] {
  const start = Math.floor(from / interval) * interval;
  const end = Math.ceil(to / interval) * interval;
  if (!series || series.candles.length === 0) return [{ from: start, to: end }];

  const have = new Set(series.candles.map((c) => c.t));
  const newest = series.candles[series.candles.length - 1]?.t ?? 0;
  have.delete(newest);

  const gaps: { from: number; to: number }[] = [];
  let open: { from: number; to: number } | null = null;
  for (let t = start; t < end; t += interval) {
    if (have.has(t)) {
      if (open) {
        gaps.push(open);
        open = null;
      }
      continue;
    }
    if (open) open.to = t + interval;
    else open = { from: t, to: t + interval };
  }
  if (open) gaps.push(open);
  return gaps;
}

/** Newly built bars over cached ones, ascending, one per interval. */
export function mergeCandles(existing: Candle[], fresh: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of existing) byTime.set(c.t, c);
  for (const c of fresh) byTime.set(c.t, c);
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

/**
 * What has already been built, for the page to offer back.
 *
 * There is no list of "tokens you can replay" — it is any Solana mint, and
 * nothing is indexed ahead of time. What there IS is a list of tokens this
 * install has already reconstructed, and those are worth surfacing because
 * they load in a couple of seconds instead of ten.
 *
 * Kept as its own small blob rather than by scanning the cache: the file
 * backend names its files by hash, and the Supabase one would need a query per
 * key. One index, rewritten on each build, answers it either way.
 */
export interface BuiltToken {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  /** Bar width the token was last drawn at. */
  interval: number;
  bars: number;
  firstTs: number;
  lastTs: number;
  /** Swaps on the charted book over its life. */
  swaps: number;
  builtAt: number;
}

const INDEX_KEY = "index:tokens";
const INDEX_MAX = Number(process.env.TRICKSHOT_INDEX_MAX ?? 60);

export async function builtTokens(): Promise<BuiltToken[]> {
  return (await loadBlob<BuiltToken[]>(INDEX_KEY)) ?? [];
}

/**
 * Newest first, one row per mint, MERGED with whatever is already there.
 *
 * Merged rather than replaced because the three paths that build a chart know
 * different things about the token: the mint-only rebuild has its name and its
 * lifetime swap count, a wallet replay has the name but only its own window,
 * and the trader board has neither. Overwriting from whichever ran last is how
 * a token that was fully rebuilt an hour ago loses its name.
 */
export async function rememberToken(
  token: Partial<BuiltToken> & { mint: string },
): Promise<void> {
  const held = await builtTokens();
  const existing = held.find((t) => t.mint === token.mint);

  const merged: BuiltToken = {
    mint: token.mint,
    name: token.name ?? existing?.name,
    symbol: token.symbol ?? existing?.symbol,
    image: token.image ?? existing?.image,
    interval: token.interval ?? existing?.interval ?? 0,
    bars: Math.max(token.bars ?? 0, existing?.bars ?? 0),
    firstTs: Math.min(
      token.firstTs || Infinity,
      existing?.firstTs || Infinity,
    ),
    lastTs: Math.max(token.lastTs ?? 0, existing?.lastTs ?? 0),
    swaps: Math.max(token.swaps ?? 0, existing?.swaps ?? 0),
    builtAt: token.builtAt ?? existing?.builtAt ?? 0,
  };
  if (!Number.isFinite(merged.firstTs)) merged.firstTs = 0;

  const next = [merged, ...held.filter((t) => t.mint !== token.mint)].slice(
    0,
    INDEX_MAX,
  );
  await saveBlob(INDEX_KEY, next);
}
