import bs58 from "bs58";
import { config } from "./config";
import { normalizeTx, type NormalizedTx } from "./decode/normalizeTx";
import {
  PositionBook,
  type PnlRow,
  type ReplayPoint,
  type StoredPosition,
} from "./positions";
import { SolPriceHistory } from "./solPrice";
import type { Candle } from "./candles";
import {
  buildCandles,
  priceSwap,
  spotPrice,
  type RawTx,
  type Swap,
} from "./candles";
import { densityMap } from "./density";
import { walletGraph, type Related, type WalletGraph } from "./graph";
import { identify, tokenIdentity } from "./identity";
import {
  accountKeys,
  pickVenue,
  programOwned,
  scanHolders,
  tradeFilter,
  type Venue,
} from "./pool";
import {
  builtTokens,
  loadBlob,
  loadSeries,
  mergeCandles,
  missingRanges,
  rememberToken,
  saveBlob,
  saveSeries,
  type BuiltToken,
} from "./store";

/**
 * A token's whole life, rebuilt from archival transactions.
 *
 * The live worker only knows what it was watching. This answers the other
 * question — "show me what happened on this token, and what this wallet did" —
 * for any mint, at any age, including ones we never tracked.
 *
 * Priced from BALANCES throughout — the pool's vaults for the chart, the
 * wallet's own token account for a wallet's trades. There are no venue
 * decoders here on purpose. Per-program decoding covers only the venues
 * someone wrote code for, and most volume on a busy token arrives through
 * routers and aggregators that no such decoder knows; balances are produced by
 * every venue equally, and a wallet's own balance cannot double-count a swap
 * that was routed through several pools.
 *
 * Costs about 500 credits for a 5,000-transaction token — a quarter of a cent —
 * because getTransactionsForAddress returns 1,000 FULL transactions per call at
 * 10 credits per 100, rather than one transaction per credit.
 */

/**
 * Signatures are cheap; transactions are not.
 *
 * getSignaturesForAddress returns 1,000 at a time for a credit, and gives the
 * time of each. Full transactions cost roughly ten times that and are the only
 * slow part — so the shape of this module is: page the signatures to learn what
 * happened when, then fetch only the transactions actually needed.
 */
/**
 * Candles per chart. The chart is built one window at a time, so this bounds
 * the work rather than the span: a 27-day token is drawn at two-hour bars.
 */
const MAX_BUCKETS = Number(process.env.HISTORY_MAX_BUCKETS ?? 400);
/** Shortest chart worth playing back, in candles. */
const MIN_CANDLES = Number(process.env.HISTORY_MIN_CANDLES ?? 60);

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Where the time went, when asked.
 *
 * A reconstruction is a dozen phases with very different costs and the
 * expensive one is not the one you would guess — reading the trader board's
 * nominees turned out to dwarf drawing the chart. Off unless HISTORY_DEBUG is
 * set, so it costs nothing in a normal request.
 */
const DEBUG = process.env.HISTORY_DEBUG === "1";
async function stage<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!DEBUG) return run();
  const started = Date.now();
  try {
    return await run();
  } finally {
    console.log(`[history] ${name} ${Date.now() - started}ms`);
  }
}
const PAGE = 1_000;

/**
 * Candle width for a span.
 *
 * 15s bars over six days is 34,000 candles nobody can read and a fetch nobody
 * wants to wait for. The width follows the span the way a chart's would.
 */
export function pickInterval(spanSec: number): number {
  if (spanSec <= 60 * 60) return 15;
  if (spanSec <= 6 * 60 * 60) return 60;
  if (spanSec <= 24 * 60 * 60) return 300;
  if (spanSec <= 4 * 24 * 60 * 60) return 900;
  if (spanSec <= 10 * 24 * 60 * 60) return 3_600;
  if (spanSec <= 30 * 24 * 60 * 60) return 7_200;
  /**
   * Past a month the ladder stops guessing and just keeps the bar count
   * readable. A year at four-hour bars is 2,190 candles — more than any chart
   * shows and more windows than any request should open.
   */
  let interval = 4 * 3_600;
  while (spanSec / interval > MAX_BUCKETS) interval *= 2;
  return interval;
}

export interface HistoryFill {
  ts: number;
  /**
   * Where it traded.
   *
   * A token lives on several books at once — its bonding curve, a PumpSwap
   * pool, one or more Raydium pools — and they do not hold the same price. Bars
   * built from whichever venue happened to be sampled jumped 20% between one
   * bucket's close and the next bucket's open A SECOND LATER, which is not a
   * market moving, it is two different books being read alternately.
   */
  venue: string;
  /**
   * Who traded, when the venue says so.
   *
   * Null on Raydium/Orca/Meteora fills, which carry no trader — the live path
   * does not attribute them either. The fee payer is NOT a substitute: MEASURED
   * on the live stream, it is the actual trader only 85% of the time, and the
   * rest are Telegram bots submitting for other people, which would collapse
   * thousands of traders into a handful of wallets and corrupt the leaderboard.
   * These fills still price the candles; they just do not name anyone.
   */
  wallet: string | null;
  isBuy: boolean;
  base: number;
  usd: number;
  priceUsd: number;
  /** "transfer" when tokens moved with no money against them. */
  kind?: "swap" | "transfer";
}

export interface TokenHistory {
  mint: string;
  candles: Candle[];
  /**
   * Circulating supply, so the client can show market cap instead of price.
   *
   * Sent rather than applied: the candles stay denominated in price, which is
   * what everything else here is measured in, and the conversion is one
   * multiplication wherever it is wanted.
   */
  supply: number;
  /** Candle width chosen for this span — 15s for a launch, 30m for a week. */
  interval: number;
  fills: number;
  /** What the token is called, when its metadata says. */
  name?: string;
  symbol?: string;
  image?: string;
  /** Trades read to nominate the board. Not the token's trade count. */
  transactions: number;
  /** Swaps on the charted book over its whole life, from the density map. */
  swaps?: number;
  /** The pool the chart was drawn from. */
  venue?: string;
  /** True when every swap in the window was read rather than sampled. */
  exact?: boolean;
  /** True when the named wallet has more history than was read. */
  partial?: boolean;
  /** Every wallet in the replay, when more than the subject was asked for. */
  cluster?: string[];
  /** The named wallet's own identity, when Helius knows one. */
  walletName?: string;
  firstTs: number;
  lastTs: number;
}

/**
 * Who made and lost the most, answered separately from the chart.
 *
 * Split out because the two cost wildly different amounts and only one of them
 * is what the page is for. MEASURED on a 27-day token: drawing the chart took
 * 5.6 seconds, and ranking the traders took 81 — it reads a hundred and twenty
 * wallets' complete histories, which is 1.7GB of transactions and the only way
 * to put an honest number next to a wallet.
 *
 * Blocking the chart on that meant staring at nothing for a minute and a half
 * to see a chart that was ready in five seconds. Now the chart returns as soon
 * as it is drawn and the board arrives when it arrives.
 */
export interface TraderBoard {
  top: PnlRow[];
  bottom: PnlRow[];
  wallets: number;
  /** True when a wallet that traded the token was left unread. */
  truncated: boolean;
  /** When the ranked wallets were last read, unix seconds. */
  builtAt: number;
  /** The mark every open position is valued at. */
  price: number;
}

/**
 * What an update needs to carry on from.
 *
 * Kept beside the board rather than inside it because it is machinery, not
 * something the page reads: the candidate list so an update ranks the same
 * wallets, the books so average-cost accounting does not have to be replayed
 * from the beginning, and the cutoff so only new transactions are read.
 */
interface BoardState {
  candidates: string[];
  positions: Record<string, StoredPosition>;
  considered: number;
  lastTs: number;
  /** Wallets that must be ranked whatever nomination thinks. */
  pinned?: string[];
  /**
   * Names already looked up, kept so a read costs nothing.
   *
   * An address's identity does not change, and the lookup is a REST round trip
   * — paying it on every board read would have made re-marking, which is
   * otherwise 0.4 seconds, the slowest thing on the page.
   */
  names?: Record<string, { name?: string; category?: string }>;
}

/**
 * Comparison filters, exactly as the method documents them.
 *
 * `{ gte, lt }`, not `{ from, to }` — the wrong shape is rejected wholesale
 * with "expected end of params", which reads like the feature is unsupported.
 * It cost a detour through a third-party index before I read the spec properly.
 */
export interface ArchiveFilters {
  blockTime?: { gte?: number; lt?: number; lte?: number; gt?: number };
  tokenTransfer?: {
    mint?: string;
    with?: string;
    direction?: "in" | "out" | "any";
    /** Raw base units, not UI amount. Finds whales in one request. */
    amount?: { gt?: number; gte?: number; lt?: number; lte?: number };
  };
  status?: "succeeded" | "failed" | "any";
}

async function archive(
  address: string,
  paginationToken?: string,
  sortOrder: "asc" | "desc" = "asc",
  filters?: ArchiveFilters,
  limit = PAGE,
  /** "signatures" costs ten credits flat and a fraction of the bytes. */
  transactionDetails: "full" | "signatures" = "full",
): Promise<{ data: unknown[]; paginationToken?: string } | null> {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(25_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "history",
        method: "getTransactionsForAddress",
        // POSITIONAL params. The documented object form is rejected outright.
        params: [
          address,
          {
            transactionDetails,
            sortOrder,
            limit,
            maxSupportedTransactionVersion: 0,
            ...(filters ? { filters } : {}),
            ...(paginationToken ? { paginationToken } : {}),
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: { data: unknown[]; paginationToken?: string } };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * An archival transaction, in the shape the stream decoders expect.
 *
 * Two differences, both silent if missed. `meta` sits BESIDE `transaction`
 * rather than inside it, and loaded addresses live under
 * `meta.loadedAddresses.{writable,readonly}`.
 *
 * The third is the one that actually costs you: JSON-RPC encodes instruction
 * data as BASE58, while the stream sends raw bytes and `toBuffer` treats every
 * string as base64. Left alone, every anchor event decodes to noise and the
 * token looks like it barely traded — MEASURED, 5 fills found in 1,000
 * transactions instead of several hundred.
 */
function adapt(raw: unknown): NormalizedTx | null {
  const t = raw as {
    transaction?: { message?: { instructions?: unknown[] }; signatures?: string[] };
    meta?: Record<string, unknown>;
    slot?: number;
    blockTime?: number;
  };
  if (!t?.transaction || !t.meta) return null;

  const loaded = (t.meta.loadedAddresses ?? {}) as { writable?: string[]; readonly?: string[] };
  const inner = (t.meta.innerInstructions ?? []) as {
    index: number;
    instructions: { programIdIndex: number; data: string; stackHeight?: number }[];
  }[];

  return normalizeTx({
    transaction: {
      transaction: t.transaction,
      meta: {
        ...t.meta,
        loadedWritableAddresses: loaded.writable ?? [],
        loadedReadonlyAddresses: loaded.readonly ?? [],
        innerInstructions: inner.map((g) => ({
          index: g.index,
          instructions: g.instructions.map((ix) => ({
            ...ix,
            data: decodeBase58(ix.data),
          })),
        })),
      },
      signature: t.transaction.signatures?.[0],
    },
    slot: t.slot,
    blockTime: t.blockTime,
  });
}

/**
 * One wallet's fills, from its own balance sheet, one per transaction.
 *
 * The wallet's token delta is the size. It cannot double-count, because there
 * is only one balance, and it gives an invariant nothing else here has:
 * summed over a wallet's whole history it must equal what that wallet holds
 * now. MEASURED against the chain on this token's largest holder, exact to the
 * token, where running the venue decoders over the same history gave 2.2x — a
 * routed swap touches several pools and they emit a fill for each leg.
 *
 * A fill counts as a TRADE when the tokens came from, or went to, a pool.
 * Two cheaper tests were wrong in opposite directions and both are worth
 * remembering:
 *
 *   the wallet's own SOL moved
 *     Misses real buyers. MEASURED on `498g1rVn`: 42 of its 59 transactions
 *     route through Jupiter, PumpSwap or Meteora and buy 5.77M tokens, and in
 *     every one the wallet's SOL delta is zero or POSITIVE — it is not the fee
 *     payer, so the money leaves an account it does not own. Judged this way
 *     its entire position read as a gift.
 *
 *   the transaction invoked some non-plumbing program
 *     Catches transfers into programs. MEASURED on `HDixbrzww`: of four
 *     "sells", one really did send 1.2M tokens to the PumpSwap pool and three
 *     sent 3.7M into a lock program — booked as sales they inflated its
 *     proceeds sevenfold.
 *
 * Whether the counterparty is a pool is exactly the question, and one batched
 * `getMultipleAccounts` over the handful of counterparties a wallet ever has
 * answers it: a person's account is System-owned, a vault's is not.
 *
 * The PRICE is the token's market price at that moment rather than the SOL
 * that moved, for the same reason the first test failed — the payer is often
 * not the holder. It loses slippage within a bar, which is a rounding error
 * next to calling a wallet's position an airdrop.
 */
async function walletFills(
  txs: NormalizedTx[],
  mint: string,
  wallet: string,
  priceAt: (ts: number) => number,
): Promise<HistoryFill[]> {
  interface Move {
    ts: number;
    base: number;
    counterparties: string[];
  }

  const moves: Move[] = [];
  const seen = new Set<string>();

  for (const tx of txs) {
    const ts = tx.blockTime ?? 0;
    if (ts <= 0 || tx.failed) continue;
    // Pagination can overlap; a transaction counted twice is a position twice
    // the size it should be.
    if (seen.has(tx.signature)) continue;
    seen.add(tx.signature);

    let base = 0;
    for (const after of tx.postTokenBalances) {
      if (after.owner !== wallet || after.mint !== mint) continue;
      const before = tx.preTokenBalances.find(
        (b) => b.accountIndex === after.accountIndex,
      );
      base +=
        Number(after.amountRaw - (before?.amountRaw ?? 0n)) / 10 ** after.decimals;
    }
    /**
     * An account present before and absent after was CLOSED, which is how a
     * wallet exits a position entirely. Left out, the final sell vanishes and
     * the wallet looks like it is still holding.
     */
    for (const before of tx.preTokenBalances) {
      if (before.owner !== wallet || before.mint !== mint) continue;
      const survives = tx.postTokenBalances.some(
        (a) => a.accountIndex === before.accountIndex,
      );
      if (!survives) base -= Number(before.amountRaw) / 10 ** before.decimals;
    }
    if (base === 0) continue;

    // Whoever moved the mint the other way. A buy's counterparty gave tokens
    // up; a sell's took them on.
    const counterparties: string[] = [];
    for (const after of tx.postTokenBalances) {
      if (after.mint !== mint || after.owner === wallet || !after.owner) continue;
      const before = tx.preTokenBalances.find(
        (b) => b.accountIndex === after.accountIndex,
      );
      const delta = after.amountRaw - (before?.amountRaw ?? 0n);
      if (delta === 0n) continue;
      if (base > 0 ? delta < 0n : delta > 0n) counterparties.push(after.owner);
    }
    moves.push({ ts, base, counterparties });
  }

  const pools = programOwned(moves.flatMap((m) => m.counterparties));

  const fills: HistoryFill[] = [];
  for (const move of moves) {
    const traded = move.counterparties.some((owner) => pools.has(owner));
    const price = priceAt(move.ts);
    const baseAbs = Math.abs(move.base);
    fills.push({
      ts: move.ts,
      venue: traded ? "pool" : "transfer",
      wallet,
      isBuy: move.base > 0,
      base: baseAbs,
      usd: traded ? baseAbs * price : 0,
      priceUsd: traded ? price : 0,
      kind: traded ? "swap" : "transfer",
    });
  }

  fills.sort((a, b) => a.ts - b.ts);
  return fills;
}

/**
 * The token's price at a moment, from the bars already drawn.
 *
 * Bars are regular, so the bucket is arithmetic rather than a search. Before
 * the first bar and after the last, the nearest one stands — a wallet that
 * traded in a gap the chart does not cover is better priced approximately than
 * not at all.
 */
function priceLookup(candles: Candle[], interval: number): (ts: number) => number {
  if (candles.length === 0) return () => 0;
  const byBucket = new Map<number, number>();
  for (const c of candles) byBucket.set(c.t, c.c);
  const first = candles[0] as Candle;
  const last = candles[candles.length - 1] as Candle;

  return (ts: number) => {
    if (ts <= first.t) return first.o;
    if (ts >= last.t) return last.c;
    const bucket = Math.floor(ts / interval) * interval;
    return byBucket.get(bucket) ?? last.c;
  };
}

function decodeBase58(value: string): Buffer {
  try {
    return Buffer.from(bs58.decode(value));
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * Everything the wallet did on this token, from the WALLET's own history.
 *
 * A wallet has a few hundred transactions; a busy token has tens of thousands
 * every few minutes. MEASURED on the pair that exposed this: 463 transactions
 * for the wallet, 46 of them on the mint, against a token doing 20,000 in three
 * minutes — its trades from six days ago were unreachable from either end of
 * the token's own history, at any cap.
 *
 * So the wallet's trades come from here, exactly and cheaply, and the token's
 * history is only read for the window they span.
 */
/**
 * Pages of a wallet's history on one mint.
 *
 * MEASURED, a wallet the board nominates on this token holds 9,813 mint
 * transactions — so six pages truncated it, and a truncated wallet does not
 * give a slightly wrong PnL, it gives a fabricated one: the buys are read and
 * the sells that paid for them are not. Twelve pages covers every candidate
 * seen, and anything past it is reported rather than quietly cut.
 */
const WALLET_PAGES = Number(process.env.HISTORY_WALLET_PAGES ?? 12);

async function walletActivity(
  mint: string,
  wallet: string,
  /** Only transactions at or after this time. Used to update a stored book. */
  since = 0,
): Promise<{
  txs: NormalizedTx[];
  first: number;
  last: number;
  anchor?: string;
  /** True when the wallet has more history than was read. */
  truncated: boolean;
}> {
  const txs: NormalizedTx[] = [];
  let token: string | undefined;

  for (let page = 0; page < WALLET_PAGES; page += 1) {
    /**
     * Asked for by mint, not filtered afterwards.
     *
     * `tokenTransfer.mint` returns only the wallet's transactions that moved
     * this token — MEASURED, 45 rows in one call against 463 transactions read
     * and sifted before.
     */
    /**
     * Successful transactions only, filtered UPSTREAM.
     *
     * `walletActivity` already threw failures away after decoding them, which
     * is not the same thing as not paying for them. MEASURED on a bot that the
     * trader board nominates: 6,000 transactions returned on this mint, 5,941
     * of them failed — a hundredfold in transferred bytes for 59 usable rows,
     * and the board reads a hundred and twenty wallets like it.
     */
    const res = await archive(wallet, token, "asc", {
      ...tradeFilter(mint),
      ...(since > 0 ? { blockTime: { gte: since } } : {}),
    });
    if (!res || res.data.length === 0) break;
    for (const raw of res.data) {
      const tx = adapt(raw);
      if (tx && !tx.failed) txs.push(tx);
    }
    token = res.paginationToken;
    if (!token) break;
  }

  txs.sort((a, b) => (a.blockTime ?? 0) - (b.blockTime ?? 0));
  return {
    txs,
    first: txs[0]?.blockTime ?? 0,
    last: txs[txs.length - 1]?.blockTime ?? 0,
    anchor: txs[txs.length - 1]?.signature,
    truncated: Boolean(token),
  };
}



/** Circulating supply in whole tokens, for market cap. One standard RPC call. */
async function tokenSupply(mint: string): Promise<number> {
  const res = await rpc<{ value?: { amount?: string; decimals?: number } }>(
    "getTokenSupply",
    [mint],
  );
  const amount = Number(res?.value?.amount ?? 0);
  const decimals = res?.value?.decimals ?? 6;
  return amount > 0 ? amount / 10 ** decimals : 0;
}

async function rpc<T>(method: string, params: unknown[]): Promise<T | null> {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: "2.0", id: "history", method, params }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: T };
    return body.result ?? null;
  } catch {
    return null;
  }
}

/**
 * The book this token is charted from, looked up once per mint.
 *
 * Discovery is a handful of RPC calls and the answer barely changes — a pool
 * that is the busiest today was the busiest an hour ago — so it is worth
 * holding on to across requests about the same token.
 */
const venues = new Map<string, { at: number; venue: Venue | null }>();
/** A pool that was the busiest yesterday still is. A day is safe and useful. */
const VENUE_TTL = Number(process.env.HISTORY_VENUE_TTL ?? 24 * 3_600);

async function venueFor(mint: string): Promise<Venue | null> {
  const hit = venues.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.venue;

  const key = `venue:${mint}`;
  const stored = await loadBlob<{ at: number; venue: Venue }>(key);
  if (stored && nowSec() - stored.at < VENUE_TTL) {
    venues.set(mint, { at: Date.now(), venue: stored.venue });
    return stored.venue;
  }

  const venue = await pickVenue(mint);
  venues.set(mint, { at: Date.now(), venue });
  if (venue) await saveBlob(key, { at: nowSec(), venue });
  return venue;
}

/**
 * When this book first and last traded.
 *
 * Asked of the POOL rather than the mint, and with the trade filter on. The
 * mint's own first transaction is its creation and its last is as likely to be
 * an unrelated bot as a trade, so a span measured that way starts before there
 * was a price and ends after there stopped being one.
 */
async function poolLifespan(
  venue: Venue,
  mint: string,
): Promise<{ first: number; last: number } | null> {
  const filters = tradeFilter(mint);
  const [oldest, newest] = await Promise.all([
    archive(venue.pool, undefined, "asc", filters, 1),
    archive(venue.pool, undefined, "desc", filters, 1),
  ]);
  const first = adapt(oldest?.data?.[0])?.blockTime ?? 0;
  const last = adapt(newest?.data?.[0])?.blockTime ?? 0;
  return first > 0 && last >= first ? { first, last } : null;
}

/**
 * Candles for a window, served from the cache wherever it can be.
 *
 * A token's past does not move. Only the newest bar can still change — it was
 * built while its own interval was open — so a second look at the same token
 * refetches that one bar and reads the rest. The first build of a three-week
 * token is the expensive one; every one after it is not.
 */
async function series(
  venue: Venue,
  mint: string,
  from: number,
  to: number,
  interval: number,
  sol: SolPriceHistory,
): Promise<{ candles: Candle[]; exact: boolean }> {
  const cached = await loadSeries(mint, interval);
  const gaps = missingRanges(cached, from, to, interval);

  /**
   * SOL prices for the gaps only, not for the span.
   *
   * A cached three-week token needs one bar rebuilt; fetching three weeks of
   * minute-by-minute SOL to price it was a second of every warm request. The
   * loader remembers what it already holds, so callers that need the whole
   * span still ask for it plainly.
   */
  for (const gap of gaps) await sol.load(gap.from, Math.min(gap.to, nowSec()));
  if (DEBUG) {
    const bars = gaps.reduce((n, g) => n + (g.to - g.from) / interval, 0);
    const span = Math.round((to - from) / interval);
    console.log(`[history] gaps ${gaps.length} covering ${bars} of ${span} bars`);
  }

  let exact = true;
  const fresh: Candle[] = [];
  /** Bars to return but not store, when a window could not be read whole. */
  let drew: Candle[] = [];
  for (const gap of gaps) {
    /**
     * A density map for the gap, sized to the gap.
     *
     * Built here rather than handed in, because only the caller that needs the
     * WHOLE token mapped should pay for the whole map. A warm request is
     * usually one or two bars behind, and probing forty points across a month
     * to plan two bars was the single largest fixed cost left on that path.
     */
    const bars = Math.ceil((gap.to - gap.from) / interval);
    const density = await densityMap(
      venue.pool,
      mint,
      gap.from,
      Math.min(gap.to, nowSec()),
      Math.max(2, Math.min(bars, 40)),
    );
    const built = await buildCandles(
      venue,
      mint,
      gap.from,
      Math.min(gap.to, nowSec()),
      interval,
      sol,
      density,
    );
    if (!built.exact) exact = false;
    /**
     * Bars the builder could not read are drawn but NOT kept.
     *
     * A transient failure looks exactly like a quiet market once it is in the
     * cache — a flat bar at the last price — and the cache only ever refetches
     * the newest bar, so it would be served for ever. Leaving them out means
     * `missingRanges` sees a gap next time and tries again.
     */
    const unresolved = new Set(built.suspect);
    fresh.push(...built.candles.filter((c) => !unresolved.has(c.t)));
    if (unresolved.size > 0) drew = built.candles;
  }

  // Exact only if the cache was and this build was. One sampled range makes
  // the whole stored series sampled until it is rebuilt, which is the
  // conservative direction to be wrong in.
  exact = exact && (cached?.exact ?? true);
  const merged = mergeCandles(cached?.candles ?? [], fresh);
  if (fresh.length > 0) {
    await saveSeries({ mint, interval, venue, candles: merged, exact, builtAt: nowSec() });
  }

  const start = Math.floor(from / interval) * interval;
  // Anything unresolved is shown from this build even though it was not kept.
  const shown = mergeCandles(merged, drew);
  return { candles: shown.filter((c) => c.t >= start && c.t < to), exact };
}

/**
 * Wallets worth reading in full, from a sample of real trades.
 *
 * Kept separate from the candles so that a cached chart does not cost the board
 * its candidates. Forty windows spread across the token's life, twenty-five
 * trades each: a thousand actual fills, which is enough to name the wallets
 * that moved size and cheap enough not to matter.
 *
 * The sample is used ONLY to nominate. Every number the board shows comes from
 * reading that wallet's own history — see `exactBoard`.
 */
const NOMINATION_WINDOWS = Number(process.env.HISTORY_NOMINATION_WINDOWS ?? 60);
const NOMINATION_PER_WINDOW = Number(process.env.HISTORY_NOMINATION_PER ?? 25);

/**
 * Pools sampled for candidates, not just the one the chart is drawn from.
 *
 * A token's liquidity is spread — Catecoin trades on a PumpSwap pool and some
 * twenty-nine Meteora ones — and a trader who worked a secondary pool never
 * appeared in a sample taken from the busiest. The chart still comes from one
 * book, because interleaving prices from books that disagree is not a chart;
 * the BOARD has no such constraint and should see everyone.
 */
const NOMINATION_POOLS = Number(process.env.HISTORY_NOMINATION_POOLS ?? 8);

async function nominees(
  venue: Venue,
  mint: string,
  first: number,
  last: number,
  pools: string[],
  sol: SolPriceHistory,
): Promise<Swap[]> {
  // The charted book first, then the next largest, deduped.
  const books = [venue.pool, ...pools.filter((p) => p !== venue.pool)].slice(
    0,
    NOMINATION_POOLS,
  );
  // The window budget is shared out, so adding pools widens coverage rather
  // than multiplying the request count.
  const perPool = Math.max(4, Math.floor(NOMINATION_WINDOWS / books.length));
  const step = Math.max(1, Math.floor((last - first) / perPool));

  const pages = await Promise.all(
    books.flatMap((book) =>
      Array.from({ length: perPool }, (_, i) =>
        archive(
          book,
          undefined,
          "asc",
          { ...tradeFilter(mint), blockTime: { gte: first + i * step, lt: first + (i + 1) * step } },
          NOMINATION_PER_WINDOW,
        ),
      ),
    ),
  );

  /**
   * Priced against the charted venue's vaults where it can be, and otherwise
   * counted for its size alone.
   *
   * A nomination only needs to know WHO traded and roughly how much — every
   * number on the board comes from reading that wallet in full afterwards. So
   * a swap on a pool whose vaults are not resolved still nominates its trader,
   * using the tokens that moved rather than a price we cannot compute.
   */
  const swaps: Swap[] = [];
  for (const page of pages) {
    for (const raw of page?.data ?? []) {
      const priced = priceSwap(raw as never, venue, mint, sol);
      if (priced) {
        swaps.push(priced);
        continue;
      }
      const nominated = nominateFromBalances(raw as never, mint);
      if (nominated) swaps.push(nominated);
    }
  }
  return swaps;
}

/**
 * A trader and a size, from a transaction on a pool we have not resolved.
 *
 * Deliberately crude: `usd` here is a RANKING WEIGHT, not money. It is the
 * tokens that moved, which orders candidates within a pool correctly and is
 * never shown to anyone — `exactBoard` reads every nominee's real history.
 */
function nominateFromBalances(raw: RawTx, mint: string): Swap | null {
  const keys = accountKeys(raw);
  const pre = raw.meta?.preTokenBalances ?? [];
  const post = raw.meta?.postTokenBalances ?? [];
  const signerCount = raw.transaction?.message?.header?.numRequiredSignatures ?? 1;
  const signers = new Set(keys.slice(0, signerCount));

  let best: { owner: string; delta: number } | null = null;
  for (const after of post) {
    if (after.mint !== mint || !after.owner || !signers.has(after.owner)) continue;
    const before = pre.find((b) => b.accountIndex === after.accountIndex);
    const delta =
      (Number(after.uiTokenAmount.amount) -
        Number(before?.uiTokenAmount.amount ?? 0)) /
      10 ** after.uiTokenAmount.decimals;
    if (delta === 0) continue;
    if (!best || Math.abs(delta) > Math.abs(best.delta)) {
      best = { owner: after.owner, delta };
    }
  }
  if (!best) return null;

  return {
    ts: raw.blockTime ?? 0,
    priceUsd: 0,
    base: Math.abs(best.delta),
    usd: Math.abs(best.delta),
    isBuy: best.delta > 0,
    wallet: best.owner,
  };
}

/**
 * The biggest trades on the book, whenever they happened.
 *
 * The third nomination source, and the one that finds LOSERS. The other two
 * are structurally blind to them: a holder list ranks by what a wallet still
 * has, and someone who bought the top and dumped has nothing; a trade sample
 * ranks by how often a wallet appears in ~1,500 trades out of 1.8 million, and
 * a whale who bought $500,000 in three transactions has almost no chance of
 * appearing at all. Between them the board found 5 losers among 141 wallets,
 * which says more about who was nominated than about who lost money.
 *
 * `tokenTransfer.amount` asks the index for big trades directly. The threshold
 * has to be denominated in DOLLARS and converted per window, not fixed in
 * tokens: MEASURED, `>= 5,000,000 tokens` matches 193 transactions and every
 * one of them is inside the first two and a half hours, because $50 bought
 * five million tokens at launch and buys six hundred now. The bar's own close
 * does the conversion.
 */
/**
 * Raised from $5,000, which was not selective enough to matter. Each window
 * returns its most RECENT qualifying trades, not its biggest, so a threshold
 * that lets thousands of trades qualify hands back a recency sample of them.
 * MEASURED: a wallet that sold 2.77M tokens in one go — six figures — never
 * appeared, while $5,000 fills did.
 */
const BIG_TRADE_USD = Number(process.env.HISTORY_BIG_TRADE_USD ?? 25_000);
const BIG_TRADE_WINDOWS = Number(process.env.HISTORY_BIG_TRADE_WINDOWS ?? 60);

async function bigTrades(
  venue: Venue,
  mint: string,
  candles: Candle[],
  pools: string[],
  sol: SolPriceHistory,
): Promise<Swap[]> {
  if (candles.length === 0) return [];
  const books = [venue.pool, ...pools.filter((p) => p !== venue.pool)].slice(
    0,
    NOMINATION_POOLS,
  );
  const step = Math.max(1, Math.floor(candles.length / BIG_TRADE_WINDOWS));

  const windows: { from: number; to: number; price: number }[] = [];
  for (let i = 0; i < candles.length; i += step) {
    const slice = candles.slice(i, i + step);
    const first = slice[0];
    const last = slice[slice.length - 1];
    if (!first || !last) continue;
    // The highest close in the window, so the threshold is not set by a dip
    // and then flooded by everything around it.
    const price = Math.max(...slice.map((c) => c.c));
    if (price > 0) windows.push({ from: first.t, to: last.t + step, price });
  }

  /**
   * Across every pool, because an exit does not have to happen on the busiest
   * one. MEASURED: a wallet that bought $138,612 and sold $303,934 vanished
   * from the board entirely — it holds nothing now, so the holder list cannot
   * see it, and its sells went through Meteora, so a whale query pointed at
   * the PumpSwap pool could not either.
   */
  const pages = await Promise.all(
    books.flatMap((book) =>
      windows.map((w) =>
        archive(
          book,
          undefined,
          "desc",
          {
            ...tradeFilter(mint),
            blockTime: { gte: w.from, lt: w.to },
            tokenTransfer: {
              mint,
              // Raw units. Decimals come from the balances, so 1e6 is assumed
              // only for the threshold — an order of magnitude either way just
              // moves how many big trades come back.
              amount: { gte: Math.round((BIG_TRADE_USD / w.price) * 1e6) },
            },
          },
          20,
        ),
      ),
    ),
  );

  const swaps: Swap[] = [];
  for (const page of pages) {
    for (const raw of page?.data ?? []) {
      const priced = priceSwap(raw as never, venue, mint, sol);
      if (priced) {
        swaps.push(priced);
        continue;
      }
      const nominated = nominateFromBalances(raw as never, mint);
      if (nominated) swaps.push(nominated);
    }
  }
  return swaps;
}

/**
 * Who the board should look at, from three sources that miss different people.
 *
 * A trade sample sees whoever traded a lot and is blind to whoever bought once
 * and held — MEASURED, the fourteenth-largest holder of this token, up
 * $487,000, made 101 trades out of 1.8 million and never appeared in a
 * thousand-trade sample. A holder list is the mirror image: it sees everyone
 * still in and nobody who got out.
 *
 * Between them they cover the board's two headings, which is not a
 * coincidence — the biggest winners are usually still holding, and so are the
 * biggest losers.
 */
async function nominate(
  venue: Venue,
  mint: string,
  first: number,
  last: number,
  candles: Candle[],
  sol: SolPriceHistory,
): Promise<{ candidates: string[]; considered: number }> {
  /**
   * The holder scan runs first because it also finds every pool, and the trade
   * sample needs to know which books to read.
   */
  const scan = await stage("nominate:holders", () =>
    scanHolders(mint, BOARD_CANDIDATES),
  );
  const holders = scan.holders;
  const [sampled, big] = await Promise.all([
    stage("nominate:trades", () =>
      nominees(venue, mint, first, last, scan.pools.map((p) => p.pool), sol),
    ),
    stage("nominate:whales", () =>
      bigTrades(venue, mint, candles, scan.pools.map((p) => p.pool), sol),
    ),
  ]);

  // Ranked by the money each wallet was SEEN moving. Gross, not net: a wallet
  // that bought big and sold big is exactly who the board is looking for, and
  // netting it out would rank it alongside one that never traded.
  const gross = new Map<string, number>();
  for (const f of [...sampled, ...big]) {
    if (!f.wallet) continue;
    gross.set(f.wallet, (gross.get(f.wallet) ?? 0) + Math.abs(f.usd));
  }
  const traders = [...gross.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([w]) => w);

  // Interleaved rather than concatenated, so a cap falls on the tail of every
  // list instead of removing one of them — which is what a board with no
  // losers on it looks like.
  const candidates: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.max(traders.length, holders.length); i += 1) {
    for (const w of [traders[i], holders[i]?.owner]) {
      if (!w || seen.has(w)) continue;
      seen.add(w);
      candidates.push(w);
    }
  }
  return { candidates: candidates.slice(0, BOARD_CANDIDATES), considered: gross.size };
}

async function walletHistory(
  mint: string,
  wallet: string,
  leadSec: number,
  /**
   * Wallets to replay ALONGSIDE the subject, as one position.
   *
   * A trader's position is often split across several wallets, and replaying
   * one of them animates a fraction of the story. Booked under a single
   * identity rather than summed afterwards, which is what makes it correct:
   * a transfer between two wallets in the cluster leaves one and enters the
   * other, so as one position it cancels exactly, the way it should.
   */
  alongside: string[] = [],
): Promise<TokenHistory | null> {
  const cluster = [wallet, ...alongside.filter((w) => w !== wallet)];
  const [activities, venue] = await Promise.all([
    Promise.all(cluster.map((w) => walletActivity(mint, w))),
    venueFor(mint),
  ]);
  const activity = activities[0] as (typeof activities)[number];
  if (activity.txs.length === 0 || !venue) return null;

  // The window has to cover everyone being replayed, not just the subject.
  const firstTs = Math.min(...activities.filter((a) => a.first > 0).map((a) => a.first));
  const lastTs = Math.max(...activities.map((a) => a.last));

  /**
   * A window worth watching, not just the one the trades occupy.
   *
   * A wallet with a single buy spans zero seconds, which produced a chart three
   * candles wide — correct, and useless to record. The window is padded to a
   * readable length either side, so a replay always opens on the token in
   * motion and carries on past the last trade to show how it played out.
   */
  const traded = Math.max(lastTs - firstTs, 0);
  const interval = pickInterval(traded + leadSec);
  const pad = interval * MIN_CANDLES;
  const from = firstTs - Math.max(leadSec, pad / 2);
  const to = Math.min(lastTs + Math.max(interval, pad / 2), nowSec());

  const sol = new SolPriceHistory();
  await sol.load(from, to);

  /**
   * The replay window is read EXACTLY wherever it fits, not sampled.
   *
   * This is the whole reason a wallet's replay can look right where a
   * three-week overview cannot. A wallet usually trades over minutes, and once
   * the trade filter has removed the bot traffic, minutes are nothing —
   * MEASURED on this token, 300 seconds is 45 swaps at mid-life and 310 at its
   * busiest, which is one request either way. So the bars a recording actually
   * shows have every trade in them, with real highs, real lows and real volume.
   *
   * `buildCandles` makes that call per window from the density map. A wallet
   * that traded across three weeks gets the sampled chart, which is the honest
   * answer for a span that size.
   */
  const drawn = await stage("candles", () =>
    series(venue, mint, from, to, interval, sol),
  );

  if (drawn.candles.length === 0) return null;

  const priceAt = priceLookup(drawn.candles, interval);
  const perWallet = await Promise.all(
    cluster.map((w, i) =>
      walletFills(
        (activities[i] as (typeof activities)[number]).txs,
        mint,
        w,
        priceAt,
      ),
    ),
  );
  const fills = perWallet.flat().sort((a, b) => a.ts - b.ts);

  const book = new PositionBook(Number.POSITIVE_INFINITY);
  for (const f of fills) {
    // Every fill under the SUBJECT's identity: the cluster is one position.
    book.apply(mint, wallet, {
      ts: f.ts,
      isBuy: f.isBuy,
      base: f.base,
      usd: f.usd,
      kind: f.kind,
    });
  }
  histories.set(clusterKey(mint, cluster), { book, fills, interval });

  /**
   * Three lookups that need nothing from each other, awaited together.
   *
   * Written inline in the return object they ran in sequence — three round
   * trips stacked end to end on the path a click waits for. None of them
   * depends on another.
   */
  const [walletName, token, supply] = await Promise.all([
    identify([wallet]).then((m) => m.get(wallet)?.name),
    tokenIdentity(mint),
    tokenSupply(mint),
  ]);

  await remember(mint, interval, drawn.candles, token);

  return {
    mint,
    cluster: cluster.length > 1 ? cluster : undefined,
    walletName,
    ...token,
    candles: drawn.candles,
    supply,
    interval,
    fills: fills.length,
    transactions: activities.reduce((n, a) => n + a.txs.length, 0),
    firstTs: drawn.candles[0]?.t ?? activity.first,
    lastTs: drawn.candles[drawn.candles.length - 1]?.t ?? activity.last,
    venue: venue.pool,
    exact: drawn.exact,
    partial: activity.truncated,
  };
}

/**
 * Record a token as replayable, from whichever path just drew it.
 *
 * Every path that builds a chart calls this, because any of them can be the
 * first thing a visitor does with a token — asking for one wallet, or asking
 * for the board, both leave a cached chart behind that the page should offer.
 */
async function remember(
  mint: string,
  interval: number,
  candles: Candle[],
  extra: Partial<BuiltToken> = {},
): Promise<void> {
  if (candles.length === 0) return;
  await rememberToken({
    mint,
    interval,
    bars: candles.length,
    firstTs: candles[0]?.t ?? 0,
    lastTs: candles[candles.length - 1]?.t ?? 0,
    builtAt: nowSec(),
    ...extra,
  });
}

/** Rebuilt histories, so asking about a second wallet costs nothing. */
const cache = new Map<string, { at: number; history: TokenHistory }>();
const CACHE_MS = Number(process.env.HISTORY_CACHE_MS ?? 10 * 60_000);

/** Traders read exactly for the board. Two calls each, run in parallel. */
const BOARD_CANDIDATES = Number(process.env.HISTORY_BOARD_CANDIDATES ?? 220);
/** Linked wallets read in full. The tail of the ranking is noise anyway. */
const GRAPH_READ_LIMIT = Number(process.env.HISTORY_GRAPH_READ ?? 8);

/** Rows kept per side. The page scrolls, so this is what "many more" costs. */
const BOARD_ROWS = Number(process.env.HISTORY_BOARD_ROWS ?? 60);

/**
 * An honest trader board on a token too busy to read whole.
 *
 * A sampled book does not give a small PnL, it gives a WRONG one: a wallet
 * whose buy was sampled and whose sell was not looks like it is still holding,
 * and one with two of its forty fills sampled shows two trades and a few
 * dollars. That is what put fifteen wallets on screen all reading "2 trades"
 * on a token where people made thousands.
 *
 * So the sample is used for what a sample is good for — NOMINATING who is worth
 * looking at — and never for the numbers. Every nominee is then read exactly
 * via its own history, which is a call or two per wallet because
 * `tokenTransfer.mint` returns only the transactions that touched this token.
 * The resulting PnL is complete for every wallet shown.
 *
 * The nomination comes from a sample spanning the token's whole life, so a
 * wallet that made its money in the first minutes is a candidate on equal terms
 * with one still trading.
 */
/**
 * How many transactions a wallet has on this mint, up to a ceiling.
 *
 * Asked BEFORE reading anything, because the answer decides whether reading is
 * worth starting. A wallet past the page cap is discarded — its buys would be
 * read and its sells would not, which fabricates a winner — and discarding it
 * after fetching twelve pages of full transactions means throwing away as much
 * as 240MB. Signatures answer the same question for ten credits and a
 * rounding error of the bytes.
 */
async function walletSize(
  mint: string,
  wallet: string,
  since: number,
): Promise<number> {
  let count = 0;
  let token: string | undefined;
  for (let page = 0; page <= WALLET_PAGES; page += 1) {
    const res = await archive(
      wallet,
      token,
      "asc",
      {
        ...tradeFilter(mint),
        ...(since > 0 ? { blockTime: { gte: since } } : {}),
      },
      PAGE,
      "signatures",
    );
    const data = res?.data ?? [];
    count += data.length;
    token = res?.paginationToken;
    if (!token || data.length === 0) break;
  }
  return count;
}

async function exactBoard(
  mint: string,
  candidates: string[],
  priceAt: (ts: number) => number,
  /** Seeded book and cutoff, when updating rather than building. */
  carry?: { book: PositionBook; since: number },
): Promise<{ book: PositionBook; fills: HistoryFill[] }> {
  const since = carry?.since ?? 0;
  const fills: HistoryFill[] = [];
  const CONCURRENCY = Number(process.env.HISTORY_BOARD_CONCURRENCY ?? 60);

  /**
   * Measure every candidate first, then read only the ones worth reading.
   *
   * The probes are signature pages — cheap, small, and all in flight at once.
   * What they buy is skipping the wallets that would have been discarded
   * anyway, which are exactly the most expensive ones to fetch.
   */
  const sizes = new Map<string, number>();
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    await Promise.all(
      candidates.slice(i, i + CONCURRENCY).map(async (w) => {
        try {
          sizes.set(w, await walletSize(mint, w, since));
        } catch {
          sizes.set(w, 0);
        }
      }),
    );
  }

  const readable = candidates.filter((w) => {
    const n = sizes.get(w) ?? 0;
    return n > 0 && n <= WALLET_PAGES * PAGE;
  });
  if (DEBUG) {
    const skipped = candidates.length - readable.length;
    const total = readable.reduce((sum, w) => sum + (sizes.get(w) ?? 0), 0);
    console.log(
      `[history] board: ${readable.length} of ${candidates.length} candidates readable (${skipped} skipped), ${total.toLocaleString()} transactions`,
    );
  }

  for (let i = 0; i < readable.length; i += CONCURRENCY) {
    const batch = await Promise.all(
      readable.slice(i, i + CONCURRENCY).map(async (w) => {
        try {
          const activity = await walletActivity(mint, w, since);
          // Better absent than fabricated: a wallet whose sells were read and
          // whose buys were not ranks as a winner that never existed.
          if (activity.truncated) return [];
          return await walletFills(activity.txs, mint, w, priceAt);
        } catch {
          return [];
        }
      }),
    );
    for (const got of batch) fills.push(...got);
  }

  fills.sort((a, b) => a.ts - b.ts);
  const book = carry?.book ?? new PositionBook();
  for (const f of fills) {
    if (!f.wallet) continue;
    book.apply(mint, f.wallet, {
      ts: f.ts,
      isBuy: f.isBuy,
      base: f.base,
      usd: f.usd,
      kind: f.kind,
    });
  }
  return { book, fills };
}

export async function reconstruct(
  mint: string,
  /** When set, that wallet's own trades are read exactly, whatever the token's size. */
  wallet?: string,
  leadSec = 300,
  /** Extra wallets replayed as one position with it. See `walletHistory`. */
  alongside: string[] = [],
): Promise<TokenHistory | null> {
  /**
   * A token is rebuilt ONCE. Replaying a second wallet on it then costs only
   * that wallet's own history — a call or two — rather than the whole token
   * again, which is what makes "let me look at all the holders" usable.
   */
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS && !wallet) return hit.history;

  /**
   * With a wallet named, take the fast road.
   *
   * Its trades come from its own history — a call or two, exact, whatever the
   * token's size — and the chart is drawn only for the window they span.
   */
  if (wallet) {
    const quick = await walletHistory(mint, wallet, leadSec, alongside);
    if (quick) return quick;
  }

  /**
   * The book, then how busy it was, then the chart.
   *
   * In that order because each answer decides the next. Which pool to read
   * decides what counts as a trade; how busy it was decides whether a window
   * can be read exactly or has to be sampled; and only then is it worth
   * fetching a transaction. MEASURED, the first two steps together are about a
   * second and a half for a token with 1.8 million swaps behind it.
   */
  const venue = await stage("venue", () => venueFor(mint));
  if (!venue) return null;

  const life = await stage("lifespan", () => poolLifespan(venue, mint));
  if (!life) return null;
  const firstTs = life.first;
  const lastTs = life.last;
  const interval = pickInterval(lastTs - firstTs);

  // `series` loads the SOL prices it needs; the whole span is rarely one of
  // them, since most of a rebuilt token comes from the cache.
  const sol = new SolPriceHistory();

  // The whole-life map is worth its forty probes here: it is what tells the
  // page how many swaps the token has ever had.
  const density = await stage("density", () => densityMap(venue.pool, mint, firstTs, lastTs));
  const drawn = await stage("candles", () =>
    series(venue, mint, firstTs, Math.min(lastTs, nowSec()) + interval, interval, sol),
  );
  if (drawn.candles.length === 0) return null;

  const [token, supply] = await Promise.all([
    tokenIdentity(mint),
    tokenSupply(mint),
  ]);
  const history: TokenHistory = {
    mint,
    ...token,
    candles: drawn.candles,
    supply,
    fills: 0,
    transactions: 0,
    swaps: Math.round(density.total),
    interval,
    firstTs,
    lastTs,
    venue: venue.pool,
    exact: drawn.exact,
  };
  cache.set(mint, { at: Date.now(), history });
  // The page offers these back; a token already built redraws in ~2s.
  await remember(mint, interval, drawn.candles, {
    ...token,
    firstTs,
    lastTs,
    swaps: history.swaps ?? 0,
  });
  return history;
}

/**
 * The trader board for a token, read exactly and kept.
 *
 * Every wallet shown has its COMPLETE history on this mint behind its number.
 * A sampled book does not give a small PnL, it gives a wrong one — a wallet
 * whose buy was sampled and whose sell was not looks like it is still holding.
 * So the sample nominates and the reading decides; see `exactBoard`.
 *
 * Expensive, and cached durably for that reason: a token's finished traders do
 * not change, so this is a cost paid once rather than once per visitor.
 */
export async function traderBoard(
  mint: string,
  /**
   * Read what has happened since the last build before ranking.
   *
   * Off by default because it is the slow path and a board an hour old is
   * still a board; the page offers it as a button and says how stale it is.
   */
  update = false,
  /**
   * Wallets that must be ranked whatever nomination thinks.
   *
   * Nomination is a sample and samples miss people. When you already know a
   * wallet matters, saying so is more reliable than widening the search until
   * it happens to be caught. Kept in the stored state, so it stays pinned
   * across later builds.
   */
  pin: string[] = [],
): Promise<TraderBoard | null> {
  const key = `board:${mint}`;
  const stateKey = `boardstate:${mint}`;
  const held = await loadBlob<TraderBoard>(key);
  const state = await loadBlob<BoardState>(stateKey);

  const venue = await stage("venue", () => venueFor(mint));
  if (!venue) return held ?? null;

  /**
   * Re-marked on every read, even without an update.
   *
   * An open position's worth moves with the price whether or not its owner
   * trades, so a board served straight from cache was quoting yesterday's
   * marks. Re-pricing is one request against the stored books; it is the
   * READING of wallets that costs minutes, and that only happens on update.
   */
  const sol = new SolPriceHistory();
  await sol.load(nowSec() - 3_600, nowSec());
  const price = await spotPrice(venue, mint, sol);

  /**
   * A newly pinned wallet has to get past the cache, or pinning it does
   * nothing at all — the cached path returns before nomination is even
   * considered.
   */
  const alreadyPinned = pin.every((w) => state?.candidates.includes(w));

  if (held && state && !update && alreadyPinned) {
    if (price <= 0) return held;
    const book = new PositionBook();
    book.restore(mint, state.positions);
    const before = Object.keys(state.names ?? {}).length;
    const board = await rank(mint, book, price, state, held.builtAt);
    await saveBlob(key, board);
    // Only when the lookup actually learned something.
    if (Object.keys(state.names ?? {}).length !== before) {
      await saveBlob(stateKey, state);
    }
    return board;
  }

  const life = await stage("lifespan", () => poolLifespan(venue, mint));
  if (!life) return held ?? null;
  await sol.load(life.first, life.last);

  const interval = pickInterval(life.last - life.first);
  const drawn =
    (await loadSeries(mint, interval))?.candles ??
    (await series(venue, mint, life.first, Math.min(life.last, nowSec()) + interval, interval, sol))
      .candles;
  await remember(mint, interval, drawn);
  const priceAt = priceLookup(drawn, interval);

  /**
   * An update keeps the candidates it already has and only reads what is new.
   *
   * Re-nominating would find slightly different wallets each time and force
   * every one of them to be read from scratch — several minutes to learn that
   * almost nothing changed. MEASURED, a full build reads ~220 wallets' entire
   * histories; an update reads only the transactions since the last one, which
   * for most wallets is none.
   */
  let candidates = state?.candidates ?? [];
  let considered = state?.considered ?? 0;
  const pinned = [...new Set([...(state?.pinned ?? []), ...pin])];
  let carry: { book: PositionBook; since: number } | undefined;

  const missing = pinned.filter((w) => !candidates.includes(w));
  if (state && update && candidates.length > 0 && missing.length === 0) {
    const book = new PositionBook();
    book.restore(mint, state.positions);
    carry = { book, since: state.lastTs };
  } else if (state && candidates.length > 0 && missing.length > 0) {
    // A newly pinned wallet has to be read from the beginning; everyone else
    // carries on from where they were.
    candidates = [...candidates, ...missing];
  } else {
    const nominated = await nominate(venue, mint, life.first, life.last, drawn, sol);
    /**
     * Merged with whoever was ranked before, not replacing them.
     *
     * Nomination looks at the token as it is TODAY, so a wallet that has since
     * closed its position stops being nominated and drops off the board —
     * taking its realised profit with it. MEASURED: a wallet that made
     * $165,323 and sold out was ranked tenth one day and absent the next.
     * Once a wallet has been ranked it stays a candidate; on an update it
     * costs only the transactions it has made since.
     */
    const merged = [...nominated.candidates];
    const seen = new Set(merged);
    for (const w of state?.candidates ?? []) {
      if (!seen.has(w)) merged.push(w);
    }
    candidates = merged.slice(0, BOARD_CANDIDATES * 2);
    considered = Math.max(nominated.considered, state?.considered ?? 0);
  }
  // Pinned wallets survive the cap.
  for (const w of pinned) if (!candidates.includes(w)) candidates.push(w);
  if (candidates.length === 0) return held ?? null;

  const { book, fills } = await stage("board", () =>
    exactBoard(mint, candidates, priceAt, carry),
  );

  histories.set(`${mint}|`, { book, fills, interval });
  if (price <= 0) return held ?? null;

  const next: BoardState = {
    candidates,
    positions: book.snapshot(mint),
    considered,
    lastTs: nowSec(),
    pinned,
  };
  next.names = state?.names ?? {};
  const board = await rank(mint, book, price, next, nowSec());
  await saveBlob(key, board);
  await saveBlob(stateKey, next);
  return board;
}

/** Order a book at a price. Shared by the cached read and the fresh build. */
async function rank(
  mint: string,
  book: PositionBook,
  price: number,
  state: BoardState,
  builtAt: number,
): Promise<TraderBoard> {
  const ranked = book.leaderboard(mint, price, BOARD_ROWS);

  /**
   * Names for the rows that will actually be shown.
   *
   * After ranking, not before: identifying two hundred candidates to display
   * sixty of them is two wasted requests, and the ones cut are the ones nobody
   * reads. Only addresses not already in the stored map are asked about, so a
   * board that has been read once never asks again.
   */
  const shown = [...ranked.top, ...ranked.bottom];
  const known = (state.names ??= {});
  const missing = shown.map((r) => r.wallet).filter((w) => !(w in known));
  if (missing.length > 0) {
    const found = await identify(missing);
    // Absent is recorded too, so an unnamed wallet is not looked up forever.
    for (const wallet of missing) {
      const hit = found.get(wallet);
      known[wallet] = hit ? { name: hit.name, category: hit.category } : {};
    }
  }
  for (const row of shown) {
    const hit = known[row.wallet];
    if (hit?.name) {
      row.name = hit.name;
      row.category = hit.category;
    }
  }

  return {
    top: ranked.top.filter((r) => r.total > 0),
    /**
     * Only wallets that actually lost.
     *
     * The candidates are nominated by size, and on a token that ran 250x the
     * biggest movers are mostly winners — so the bottom of that ranking was a
     * wallet up sixty-four dollars under a heading saying "lost the most". A
     * short honest list beats a full dishonest one.
     */
    bottom: ranked.bottom.filter((r) => r.total < 0),
    wallets: ranked.wallets,
    truncated: state.considered > BOARD_CANDIDATES,
    builtAt,
    price,
  };
}

/**
 * Bars of run-up before a wallet's first trade.
 *
 * Enough that the chart is visibly moving when the replay opens, and few
 * enough that the wallet's own story is still what the clip is about.
 */
const LEAD_BARS = Number(process.env.HISTORY_LEAD_BARS ?? 8);

/** Reconstructed books, kept so a replay does not re-read the chain. */
const histories = new Map<
  string,
  { book: PositionBook; fills: HistoryFill[]; interval: number }
>();

/**
 * One wallet's replay over a reconstructed history.
 *
 * `leadSec` is the run-up: the chart starts before the wallet's first trade so
 * a recording opens on the token in motion rather than on the wallet's entry.
 */
/** The key a cluster's book is filed under. Order-independent. */
function clusterKey(mint: string, cluster: string[]): string {
  return `${mint}|${[...cluster].sort().join(",")}`;
}

export function replayFrom(
  mint: string,
  wallet: string,
  candles: Candle[],
  leadSec = 300,
  alongside: string[] = [],
): { points: ReplayPoint[]; candles: Candle[]; trades: HistoryFill[] } | null {
  /**
   * The wallet's OWN book first.
   *
   * The board keeps a second book for the same mint, holding a hundred and
   * twenty wallets with their fills bounded. Reading the replay out of
   * whichever book was written last gave a curve that stopped partway; the
   * wallet-specific one is complete by construction.
   */
  const cluster = [wallet, ...alongside.filter((w) => w !== wallet)];
  const held =
    histories.get(clusterKey(mint, cluster)) ?? histories.get(`${mint}|`);
  if (!held) return null;

  const inCluster = new Set(cluster);
  const trades = held.fills.filter((f) => f.wallet && inCluster.has(f.wallet));

  /**
   * The run-up is counted in BARS, not seconds.
   *
   * It was `leadSec`, defaulting to five minutes, which is less than one bar on
   * anything wider than a five-minute chart — so on a two-hour chart the lead
   * rounded away entirely and the replay opened on the wallet's first trade
   * with no context in front of it. A recording wants the token already in
   * motion before anyone does anything.
   *
   * Measured from the first TRADE rather than the first fill: tokens arriving
   * by transfer are not the moment the story starts, and a wallet that was
   * airdropped dust weeks earlier would otherwise begin its replay there.
   */
  const opening = trades.find((f) => f.kind !== "transfer") ?? trades[0];
  const firstTrade = opening?.ts ?? candles[0]?.t ?? 0;
  const from =
    Math.floor(firstTrade / held.interval) * held.interval -
    Math.max(leadSec, LEAD_BARS * held.interval);
  const window = candles.filter((c) => c.t >= from);
  const closes = new Map(window.map((c) => [c.t, c.c]));

  return {
    candles: window,
    trades,
    points: held.book.replay(mint, wallet, closes, held.interval),
  };
}

export const historyStats = () => ({ cached: histories.size });

/** Tokens this install has already reconstructed. See `builtTokens`. */
export async function replayable(): Promise<BuiltToken[]> {
  return builtTokens();
}

/** Whether a mint has been indexed, without building anything to find out. */
export async function indexed(mint: string): Promise<boolean> {
  const known = await builtTokens();
  return known.some((t) => t.mint === mint);
}

/** A linked wallet with its own complete PnL on this mint. */
export interface RelatedWallet extends Related {
  total: number;
  realized: number;
  unrealized: number;
  qty: number;
  boughtUsd: number;
  soldUsd: number;
  trades: number;
}

export interface RelatedReport extends Omit<WalletGraph, "linked"> {
  linked: RelatedWallet[];
}

/**
 * The wallets a wallet is operating with, and what each of them made.
 *
 * Optional and off the critical path: a replay never waits for it. Cached per
 * mint and wallet because a transfer graph is history — the edges that exist
 * today existed yesterday.
 *
 * Every linked wallet is then READ IN FULL, the same way a board candidate is,
 * so its figure is exact rather than inferred from the edge that found it. The
 * LINK is the inference; the money is not.
 */
export async function relatedWallets(
  mint: string,
  wallet: string,
  /**
   * Whether this caller may work out a graph that does not exist yet.
   *
   * False for a visitor on the hosted site: they see the graphs the owner
   * chose to compute, and asking about an uncomputed wallet says so rather
   * than reading a slice of its history to find out.
   */
  mayCompute = true,
): Promise<RelatedReport | "not computed" | null> {
  const key = `graph:${mint}:${wallet}`;
  const held = await loadBlob<RelatedReport>(key);
  if (held) return worthShowing(held);
  if (!mayCompute) return "not computed";

  const venue = await stage("venue", () => venueFor(mint));
  if (!venue) return null;

  const activity = await stage("subject", () => walletActivity(mint, wallet));
  if (activity.txs.length === 0) return null;

  const interval = pickInterval(
    Math.max(activity.last - activity.first, 0) + 300,
  );
  const pad = interval * MIN_CANDLES;
  const from = activity.first - Math.max(300, pad / 2);
  const to = Math.min(activity.last + Math.max(interval, pad / 2), nowSec());

  const sol = new SolPriceHistory();
  const drawn = await stage("candles", () =>
    series(venue, mint, from, to, interval, sol),
  );
  await remember(mint, interval, drawn.candles);
  const priceAt = priceLookup(drawn.candles, interval);

  const graph = await stage("graph", () =>
    walletGraph(mint, wallet, activity.txs, { from, to }, adapt),
  );

  /**
   * Read each linked wallet properly. Bounded, because this runs while someone
   * is waiting and the tail of the ranking is noise by construction.
   */
  const shortlist = graph.linked.slice(0, GRAPH_READ_LIMIT);
  const priced = await Promise.all(
    shortlist.map(async (related): Promise<RelatedWallet> => {
      const own = await walletActivity(mint, related.wallet);
      const fills = await walletFills(own.txs, mint, related.wallet, priceAt);
      const book = new PositionBook(Number.POSITIVE_INFINITY);
      for (const f of fills) {
        book.apply(mint, related.wallet, {
          ts: f.ts,
          isBuy: f.isBuy,
          base: f.base,
          usd: f.usd,
          kind: f.kind,
        });
      }
      const row = book.leaderboard(mint, priceAt(nowSec()), 1, true).top[0];
      return {
        ...related,
        total: row?.total ?? 0,
        realized: row?.realized ?? 0,
        unrealized: row?.unrealized ?? 0,
        qty: row?.qty ?? 0,
        boughtUsd: row?.boughtUsd ?? 0,
        soldUsd: row?.soldUsd ?? 0,
        trades: row?.trades ?? 0,
      };
    }),
  );

  const report: RelatedReport = {
    ...graph,
    linked: priced.sort((a, b) => Math.abs(b.total) - Math.abs(a.total)),
    builtAt: nowSec(),
  };
  await saveBlob(key, report);
  return worthShowing(report);
}

/**
 * Drop linked wallets that hold nothing and made nothing.
 *
 * They are real relationships — a wallet that funded the subject with SOL and
 * never touched the token is exactly that — but they add nothing to a PnL and
 * every row costs the reader attention. Filtered on the way OUT rather than
 * before caching, so the reasoning stays in the stored report.
 */
function worthShowing(report: RelatedReport): RelatedReport {
  return {
    ...report,
    linked: report.linked.filter((r) => Math.abs(r.total) >= 1 || r.qty > 0),
  };
}
