import { config } from "./config";
import { countSwaps, expectedSwaps, type Density } from "./density";
import { accountKeys, tradeFilter, type TokenBalanceRow, type Venue } from "./pool";
import { QUOTE_MINTS, WSOL_MINT } from "./mints";
import type { SolPriceHistory } from "./solPrice";

/**
 * Candles, priced from the pool's own vaults.
 *
 * Nothing here decodes an instruction. A swap is two balances moving in
 * opposite directions inside one pool, and the transaction states both: what
 * the base vault gained, what the quote vault lost, and therefore what was
 * paid per token. That is venue-agnostic in a way a decoder can never be —
 * MEASURED on this token, 45 of 50 sampled transactions were submitted by a
 * router (`6MWVTis8…`) that none of this app's decoders know, and every one of
 * them prices correctly from balances.
 *
 * Checked against the two things that could go wrong. Execution price against
 * the pool's post-trade reserve ratio: 0.46% median difference over 200
 * consecutive swaps. Implied market cap against a public aggregator's: $78.4M
 * both.
 *
 * Execution price is the one used, not the reserve ratio, because a
 * concentrated-liquidity book (Meteora DLMM, Raydium CLMM) prices at its
 * active bin and its vault ratio means nothing.
 */

/** One bar. Matches the shape the chart draws and the worker used to store. */
export interface Candle {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** USD volume. */
  v: number;
  /** Base-token volume. */
  vb: number;
  /** Trade count. */
  n: number;
}

/** Transactions read per request when sampling. Two per sub-window. */
const PER_SUB = 2;
/**
 * Sub-windows per candle, and the number that matters most for how a bar looks.
 *
 * A candle needs a high and a low, and where the samples fall inside the bucket
 * decides whether it gets them. MEASURED against ground truth — every swap in
 * the bucket read and the true range computed — for evenly spread samples:
 *
 *      samples      busy bucket (5,254 swaps)    quiet bucket (1,223 swaps)
 *         2               2% of true range              78%
 *         4              49%                            78%
 *         8              70%                            88%
 *        16              86%                            91%
 *        32              84%                            99%
 *
 * The old code took its samples from the two ENDS of the bucket, which is the
 * k=2 row: it recovered 2% of the range on a busy bar and drew the rest as a
 * flat body. Eight sub-windows at two transactions each lands on the knee.
 */
const SUBS = Number(process.env.HISTORY_SUBS ?? 8);
/**
 * Requests in flight, across every bar at once.
 *
 * Measured: 350 windowed reads complete in 2.2s at 40 in flight. They are
 * pooled flat rather than per bar — a bar's nine sub-windows finish at nine
 * different times, and waiting for the slowest before starting the next bar
 * left most of the pool idle.
 */
const CONCURRENCY = Number(process.env.HISTORY_CONCURRENCY ?? 64);
/**
 * Swaps a window may hold and still be read exactly rather than sampled.
 *
 * The limit is bandwidth, not credits: MEASURED, a full transaction from this
 * endpoint averages ~20KB, so three thousand of them is already 60MB to
 * transfer and parse inside one request. Past that the window is sampled.
 */
const EXACT_MAX = Number(process.env.HISTORY_EXACT_MAX ?? 1_200);
/**
 * Swaps a single BAR may hold and still be read whole.
 *
 * One request returns up to a thousand transactions, so anything under that is
 * cheaper read than sampled — nine calls become one, and the bar gets a real
 * high, low and volume rather than an estimated one. Held below the page limit
 * so that a bucket the density map underestimated still fits.
 */
const EXACT_BUCKET = Number(process.env.HISTORY_EXACT_BUCKET ?? 40);

export interface Swap {
  ts: number;
  priceUsd: number;
  /** Base tokens that changed hands, positive. */
  base: number;
  usd: number;
  isBuy: boolean;
  /**
   * Who traded, when the balances say so unambiguously.
   *
   * Only ever used to NOMINATE wallets worth reading in full — never for a
   * number on screen. See `exactBoard`.
   */
  wallet?: string;
}

export interface RawTx {
  blockTime?: number;
  transaction?: {
    message?: {
      accountKeys?: (string | { pubkey: string })[];
      header?: { numRequiredSignatures?: number };
    };
    signatures?: string[];
  };
  meta?: {
    preTokenBalances?: TokenBalanceRow[];
    postTokenBalances?: TokenBalanceRow[];
    preBalances?: number[];
    postBalances?: number[];
    loadedAddresses?: { writable?: string[]; readonly?: string[] };
  };
}

async function read(
  pool: string,
  mint: string,
  opts: {
    from: number;
    to: number;
    limit: number;
    order?: "asc" | "desc";
    paginationToken?: string;
  },
): Promise<{ data: RawTx[]; paginationToken?: string; ok: boolean }> {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "candles",
        method: "getTransactionsForAddress",
        params: [
          pool,
          {
            transactionDetails: "full",
            sortOrder: opts.order ?? "asc",
            limit: opts.limit,
            maxSupportedTransactionVersion: 0,
            filters: { ...tradeFilter(mint), blockTime: { gte: opts.from, lt: opts.to } },
            ...(opts.paginationToken ? { paginationToken: opts.paginationToken } : {}),
          },
        ],
      }),
    });
    if (!res.ok) return { data: [], ok: false };
    const body = (await res.json()) as {
      result?: { data?: RawTx[]; paginationToken?: string };
      error?: unknown;
    };
    /**
     * An empty answer and a failed one are NOT the same thing, and conflating
     * them is how a chart grows flat bars. A window that genuinely had no
     * trades is a flat bar; a window whose request failed is a hole, and the
     * difference has to survive up to the caller so it can retry and refuse to
     * cache what it could not read.
     */
    if (body.error) return { data: [], ok: false };
    return {
      data: body.result?.data ?? [],
      paginationToken: body.result?.paginationToken,
      ok: true,
    };
  } catch {
    return { data: [], ok: false };
  }
}

/**
 * One transaction to one priced swap, or null if it did not move this pool.
 *
 * Both vaults are matched by ADDRESS. Matching by owner instead looks tempting
 * and breaks on Raydium v4, whose pools all share one global authority — every
 * book on that program would be summed into one.
 */
export function priceSwap(
  raw: RawTx,
  venue: Venue,
  mint: string,
  sol: SolPriceHistory,
): Swap | null {
  const ts = raw.blockTime ?? 0;
  if (ts <= 0) return null;
  const keys = accountKeys(raw);
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];

  let base = 0;
  let quote = 0;

  for (const after of post) {
    const address = keys[after.accountIndex];
    if (address !== venue.baseVault && address !== venue.quoteVault) continue;
    const before = pre.find((p) => p.accountIndex === after.accountIndex);
    const decimals = after.uiTokenAmount.decimals;
    const delta =
      (Number(after.uiTokenAmount.amount) -
        Number(before?.uiTokenAmount.amount ?? 0)) /
      10 ** decimals;
    if (address === venue.baseVault) base = delta;
    else quote = delta;
  }

  // A bonding curve keeps its SOL as lamports on the pool account itself, so
  // the quote leg is not a token balance at all.
  if (quote === 0 && venue.nativeQuote) {
    const index = keys.indexOf(venue.pool);
    if (index >= 0) {
      quote =
        ((raw.meta?.postBalances?.[index] ?? 0) -
          (raw.meta?.preBalances?.[index] ?? 0)) /
        1e9;
    }
  }

  if (base === 0 || quote === 0) return null;
  // The two legs must move in opposite directions. Same sign is a deposit or a
  // withdrawal of liquidity, which has no execution price.
  if (Math.sign(base) === Math.sign(quote)) return null;

  const quoteMint = venue.quoteMint ?? WSOL_MINT;
  const quoteUsd =
    quoteMint === WSOL_MINT
      ? sol.at(ts)
      : QUOTE_MINTS.has(quoteMint)
        ? 1
        : 0;
  if (quoteUsd <= 0) return null;

  const baseAbs = Math.abs(base);
  const quoteAbs = Math.abs(quote);
  return {
    ts,
    priceUsd: (quoteAbs / baseAbs) * quoteUsd,
    base: baseAbs,
    usd: quoteAbs * quoteUsd,
    // The pool losing base means the user received it.
    isBuy: base < 0,
    wallet: traderOf(raw, keys, mint, venue) ?? undefined,
  };
}

/**
 * The wallet on the other side of the pool.
 *
 * From balances rather than from the instruction, because most of this token's
 * volume arrives through routers that name nobody. An account whose holding of
 * the mint changed and which is not the pool's own vault took the other side;
 * where several did, the one that signed is the trader and the rest are
 * intermediaries a router moved tokens through.
 *
 * The fee payer is NOT used as a fallback. MEASURED on the live stream it is
 * the real trader only 85% of the time, and the other 15% are bots submitting
 * for other people — enough to collapse thousands of traders into a handful of
 * wallets. An unattributable swap still prices its candle; it just names nobody.
 */
function traderOf(
  raw: RawTx,
  keys: string[],
  mint: string,
  venue: Venue,
): string | null {
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];
  const signerCount = raw.transaction?.message?.header?.numRequiredSignatures ?? 1;
  const signers = new Set(keys.slice(0, signerCount));

  const moved: string[] = [];
  for (const after of post) {
    if (after.mint !== mint) continue;
    const address = keys[after.accountIndex];
    if (address === venue.baseVault) continue;
    const before = pre.find((p) => p.accountIndex === after.accountIndex);
    if (after.uiTokenAmount.amount === (before?.uiTokenAmount.amount ?? "0")) continue;
    if (after.owner) moved.push(after.owner);
  }

  const signer = moved.find((owner) => signers.has(owner));
  if (signer) return signer;
  return moved.length === 1 ? (moved[0] as string) : null;
}

/** Bucket swaps into bars, carrying each open from the last close. */
function toCandles(swaps: Swap[], from: number, to: number, interval: number): Candle[] {
  const buckets = new Map<number, Swap[]>();
  for (const s of swaps) {
    const t = Math.floor(s.ts / interval) * interval;
    const held = buckets.get(t);
    if (held) held.push(s);
    else buckets.set(t, [s]);
  }

  const out: Candle[] = [];
  let last = 0;
  const start = Math.floor(from / interval) * interval;
  for (let t = start; t < to; t += interval) {
    const held = buckets.get(t);
    if (!held || held.length === 0) {
      // A period with nothing in it is a flat bar at the last price, which is
      // what happened and what every chart draws. Before the first trade there
      // is no price to draw, so nothing is emitted.
      if (last > 0) out.push({ t, o: last, h: last, l: last, c: last, v: 0, vb: 0, n: 0 });
      continue;
    }
    held.sort((a, b) => a.ts - b.ts);
    const prices = held.map((s) => s.priceUsd);
    /**
     * The open is the PREVIOUS close, not the first sample.
     *
     * With samples rather than every trade, the first one seen inside a bucket
     * is not the first trade in it, so using it as the open left a gap between
     * every bar and the one before. Carrying the close forward is both what a
     * continuous market did and what makes the bars join up.
     */
    const close = prices[prices.length - 1] as number;
    const o = last > 0 ? last : (prices[0] as number);
    out.push({
      t,
      o,
      h: Math.max(o, ...prices),
      l: Math.min(o, ...prices),
      c: close,
      v: held.reduce((sum, s) => sum + s.usd, 0),
      vb: held.reduce((sum, s) => sum + s.base, 0),
      n: held.length,
    });
    last = close;
  }
  return out;
}

async function pool<T>(jobs: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      const job = jobs[i];
      if (!job) return;
      out[i] = await job();
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every swap in a window, paged until it runs out.
 *
 * Used wherever the window is small enough to afford it, which after the
 * filter is most replay windows: MEASURED, 300 seconds of this token is 45
 * swaps at mid-life and 310 at its busiest — one request either way. A replay
 * built this way has no sampling in it at all, so its bars are exact and its
 * volume is real.
 */
export async function exactSwaps(
  venue: Venue,
  mint: string,
  from: number,
  to: number,
  sol: SolPriceHistory,
): Promise<{ swaps: Swap[]; complete: boolean }> {
  const swaps: Swap[] = [];
  let token: string | undefined;
  let complete = false;

  const pages = Math.ceil(EXACT_MAX / 1_000) + 1;
  for (let page = 0; page < pages; page += 1) {
    const res = await read(venue.pool, mint, {
      from,
      to,
      limit: 1_000,
      paginationToken: token,
    });
    for (const raw of res.data) {
      const swap = priceSwap(raw, venue, mint, sol);
      if (swap) swaps.push(swap);
    }
    token = res.paginationToken;
    if (!token || res.data.length === 0) {
      complete = true;
      break;
    }
  }

  swaps.sort((a, b) => a.ts - b.ts);
  /**
   * `complete` is the whole point of this return shape.
   *
   * Running out of pages does not mean the window ended; it means the window
   * was bigger than the budget. Treated as complete, those swaps become the
   * FIRST few thousand of the window and every bar after them draws flat — a
   * chart that looks finished and is missing its second half. The density map
   * is only a probe grid and can be fifty-fold wrong on a token whose activity
   * swings, so this is the check that actually decides, not the estimate.
   */
  return { swaps, complete };
}

/**
 * Every read a bar needs, as jobs rather than as a call.
 *
 * Returned instead of executed so that ALL the bars' requests can be run from
 * one pool. Running them a bar at a time left the pool half idle: a bar does
 * not finish until its slowest sub-window does, and nine requests have a slow
 * one more often than not.
 *
 * A bar is either read whole or sampled, decided from the density map before
 * anything is fetched:
 *
 *   whole     when it holds fewer swaps than sampling it would fetch anyway.
 *             One request instead of nine, and a true high, low and volume
 *             rather than estimates. The ceiling is deliberately low — a full
 *             transaction is ~20KB, so reading a busy bar whole costs tens of
 *             megabytes to avoid one estimate.
 *
 *   sampled   otherwise: SUBS sub-windows spread across the bar, plus one
 *             descending read for its true close. See SUBS for what the
 *             spreading buys.
 */
function bucketJobs(
  venue: Venue,
  mint: string,
  t: number,
  interval: number,
  density: Density,
): { jobs: (() => Promise<{ data: RawTx[]; ok: boolean }>)[]; exact: boolean } {
  if (expectedSwaps(density, t, t + interval) <= EXACT_BUCKET) {
    return {
      jobs: [
        async () => {
          /**
           * Ask for one more than the bar is allowed to hold, not a full page.
           *
           * The point of this branch is that the bar is small. Asking for a
           * thousand transactions to find that out costs ~20MB when the
           * density map guesses low — and a coarse map over a short window
           * guesses low often. MEASURED: it turned an 828ms rebuild of six
           * cached-out bars into 2,272ms. One over the threshold answers the
           * same question for 800KB.
           */
          const page = await read(venue.pool, mint, {
            from: t,
            to: t + interval,
            limit: EXACT_BUCKET + 1,
          });
          // Not full means we have the whole bar.
          if (page.data.length <= EXACT_BUCKET) return page;
          const spread = await pool(
            sampleJobs(venue, mint, t, interval),
            SUBS + 1,
          );
          return {
            data: spread.flatMap((p) => p.data),
            ok: spread.every((p) => p.ok),
          };
        },
      ],
      exact: true,
    };
  }

  return { jobs: sampleJobs(venue, mint, t, interval), exact: false };
}

/** SUBS sub-windows spread across the bar, plus one read for its true close. */
function sampleJobs(
  venue: Venue,
  mint: string,
  t: number,
  interval: number,
): (() => Promise<{ data: RawTx[]; ok: boolean }>)[] {
  const width = interval / SUBS;
  const jobs = Array.from({ length: SUBS }, (_, i) => () =>
    read(venue.pool, mint, {
      from: Math.floor(t + i * width),
      to: Math.floor(t + (i + 1) * width),
      limit: PER_SUB,
    }),
  );
  // The bar's true close, which no ascending sample can reach.
  jobs.push(() =>
    read(venue.pool, mint, { from: t, to: t + interval, limit: 1, order: "desc" }),
  );
  return jobs;
}

export interface CandleWindow {
  candles: Candle[];
  /** True when every swap in the window was read; false when bars are sampled. */
  exact: boolean;
  /**
   * The swaps behind the bars.
   *
   * Carried out so the trader board can nominate from them. Every one is a
   * real trade at a real price, which the mint-wide sample it replaces was not.
   */
  swaps: Swap[];
  /** Swaps actually read, and how many the density map says happened. */
  read: number;
  estimated: number;
  /**
   * Bucket times that could not be read even after a retry. Safe to draw,
   * never safe to cache.
   */
  suspect: number[];
}

/**
 * Candles for a window, read exactly when that is affordable and sampled when
 * it is not.
 *
 * The decision is made from the density map rather than from the span, because
 * span says nothing: an hour of this token is 700 swaps in its third week and
 * 27,000 in its first.
 */
const DEBUG = process.env.HISTORY_DEBUG === "1";

export async function buildCandles(
  venue: Venue,
  mint: string,
  from: number,
  to: number,
  interval: number,
  sol: SolPriceHistory,
  density: Density,
): Promise<CandleWindow> {
  const estimated = expectedSwaps(density, from, to);

  if (DEBUG) {
    console.log(
      `[candles] window ${(to - from) / interval} bars estimated=${Math.round(estimated)}`,
    );
  }
  /**
   * Ask before fetching, and only when the estimate says it is worth asking.
   *
   * A window is read whole only when it is KNOWN to fit, not when the density
   * map guesses it might — being wrong that way is tens of megabytes of full
   * transactions fetched and discarded.
   *
   * Signature pages are cheap in credits and NOT free in time — pagination is
   * sequential, so confirming "too many" costs a round trip per thousand.
   * MEASURED on the still-open bar of a live token: an estimate of 5,029
   * against a ceiling of 3,000 spent 786ms paging to conclude the obvious,
   * which was most of the latency of clicking a wallet.
   */
  if (estimated <= EXACT_MAX) {
    const t0 = Date.now();
    const counted = await countSwaps(venue.pool, mint, from, to, EXACT_MAX);
    if (DEBUG) {
      console.log(
        `[candles] counted=${counted.count} complete=${counted.complete} in ${Date.now() - t0}ms`,
      );
    }
    if (counted.complete && counted.count > 0 && counted.count <= EXACT_MAX) {
      const t1 = Date.now();
      const read = await exactSwaps(venue, mint, from, to, sol);
      if (DEBUG) console.log(`[candles] exact read ${read.swaps.length} swaps in ${Date.now() - t1}ms`);
      if (read.complete && read.swaps.length > 0) {
        return {
          candles: toCandles(read.swaps, from, to, interval),
          exact: true,
          swaps: read.swaps,
          read: read.swaps.length,
          estimated: counted.count,
          suspect: [],
        };
      }
    }
  }

  const buckets: number[] = [];
  for (let t = Math.floor(from / interval) * interval; t < to; t += interval) {
    buckets.push(t);
  }

  // Volume is only scaled where a bar was actually sampled; a bar read whole
  // already has its real volume and must not be multiplied.
  const sampledBuckets = new Set<number>();

  /**
   * Read every bucket, then read again the ones that came back wrong.
   *
   * A bucket is wrong when its requests failed, or when it returned nothing
   * while the density map expected a busy window. MEASURED on `ApZuxdpz`: one
   * build hit a run of nineteen consecutive empty bars across a stretch that
   * really held a thousand swaps each — the price froze for five hours of the
   * replay and then jumped 4.5x on the final bar. Rebuilt from a clean cache
   * the same window came back complete, twice, so the failures were transient.
   * What made them permanent was CACHING them: only the newest bar is ever
   * refetched, so a hole written into the series could never heal.
   */
  const swaps: Swap[] = [];
  const seen = new Set<string>();
  const found = new Map<number, number>();
  const failed = new Set<number>();

  const sweep = async (todo: number[]) => {
    const jobs: (() => Promise<{ data: RawTx[]; ok: boolean }>)[] = [];
    const owner: number[] = [];
    for (const t of todo) {
      const planned = bucketJobs(venue, mint, t, interval, density);
      if (!planned.exact) sampledBuckets.add(t);
      for (const job of planned.jobs) {
        jobs.push(job);
        owner.push(t);
      }
    }

    const started = Date.now();
    const pages = await pool(jobs, CONCURRENCY);
    if (DEBUG) {
      console.log(`[candles] ${jobs.length} requests in ${Date.now() - started}ms`);
    }

    pages.forEach((page, i) => {
      const t = owner[i] as number;
      if (!page.ok) failed.add(t);
      for (const raw of page.data) {
        // Both ends of a quiet bar can be the same transaction; counting it
        // twice would double that bar's volume and trade count.
        const signature = raw.transaction?.signatures?.[0] ?? "";
        if (signature && seen.has(signature)) continue;
        if (signature) seen.add(signature);
        const swap = priceSwap(raw, venue, mint, sol);
        if (!swap) continue;
        swaps.push(swap);
        found.set(t, (found.get(t) ?? 0) + 1);
      }
    });
  };

  await sweep(buckets);

  /** A bar the density says should be busy, that came back with nothing. */
  const suspicious = (t: number) =>
    failed.has(t) ||
    ((found.get(t) ?? 0) === 0 && expectedSwaps(density, t, t + interval) >= 4);

  const retry = buckets.filter(suspicious);
  if (retry.length > 0) {
    failed.clear();
    if (DEBUG) console.log(`[candles] retrying ${retry.length} empty buckets`);
    await sweep(retry);
  }

  /**
   * Still empty after a retry: reported, not stored. The caller keeps these
   * out of the cache so the next request tries again rather than serving a
   * hole for ever.
   */
  const suspect = buckets.filter(suspicious);
  if (DEBUG && suspect.length > 0) {
    console.log(`[candles] ${suspect.length} buckets unresolved`);
  }

  swaps.sort((a, b) => a.ts - b.ts);
  const candles = toCandles(swaps, from, to, interval);

  /**
   * Volume is scaled, and says so.
   *
   * A sampled bar saw seventeen of its several thousand trades, so summing
   * their dollars would under-report volume by two orders of magnitude and
   * draw a histogram that means nothing. The sampled mean trade size times the
   * bar's expected trade count is an estimate, but it is the right size. The
   * PRICES are never scaled — every one of them is a trade that happened.
   */
  for (const bar of candles) {
    if (bar.n === 0 || !sampledBuckets.has(bar.t)) continue;
    const expected = expectedSwaps(density, bar.t, bar.t + interval);
    if (expected <= bar.n) continue;
    const scale = expected / bar.n;
    bar.v *= scale;
    bar.vb *= scale;
    bar.n = Math.round(expected);
  }

  return {
    candles,
    exact: sampledBuckets.size === 0,
    swaps,
    read: swaps.length,
    estimated,
    suspect,
  };
}

/**
 * What the token is worth right now, from the last swap on its book.
 *
 * The board marks every open position to a price, and it used to take that
 * price from whatever chart happened to be sitting in memory. When the board
 * was asked for first — which is exactly what the page does, since the chart
 * and the board are fetched separately — there was no chart, the price was
 * zero, and every wallet still holding was reported at a total loss. MEASURED
 * on the wallet at the top of this token's board: +$1,516,848 became -$414,126.
 *
 * One request, and it does not depend on anything else having run.
 */
export async function spotPrice(
  venue: Venue,
  mint: string,
  sol: SolPriceHistory,
): Promise<number> {
  const page = await read(venue.pool, mint, {
    from: 0,
    to: Math.floor(Date.now() / 1000) + 60,
    limit: 8,
    order: "desc",
  });
  for (const raw of page.data) {
    const swap = priceSwap(raw, venue, mint, sol);
    if (swap && swap.priceUsd > 0) return swap.priceUsd;
  }
  return 0;
}
