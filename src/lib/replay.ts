/**
 * A wallet's position in one token, minute by minute.
 *
 * The worker walks that wallet's fills in order and books average-cost PnL:
 * `realized` moves only on a sell, `unrealized` is the open position marked to
 * that minute's close, and `total` is what the wallet is up or down overall.
 */
export interface ReplayPoint {
  minute: number;
  qty: number;
  price: number;
  realized: number;
  unrealized: number;
  total: number;
  /** Cash in and out up to this point in the replay, not lifetime. */
  boughtUsd: number;
  soldUsd: number;
}

/** One bar of the token's price. Its width is `Replay.interval`. */
export interface ReplayCandle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** One of the wallet's own fills, marked on the chart. */
export interface ReplayTrade {
  ts: number;
  /** Which wallet made it, when a cluster is being replayed. */
  wallet?: string | null;
  isBuy: boolean;
  base: number;
  usd: number;
  /** "transfer" when tokens moved with no money against them. */
  kind?: "swap" | "transfer";
}

/**
 * A token and one wallet's trades on it, as the chart consumes them.
 *
 * Reconstructed from the chain on demand — there is no live feed behind this
 * app, so every replay is history, however recent.
 */
export interface Replay {
  interval: number;
  /** Circulating supply. Price x supply is the market cap the chart draws. */
  supply: number;
  candles: ReplayCandle[];
  trades: ReplayTrade[];
  points: ReplayPoint[];
}

/** A wallet's standing on a reconstructed token. */
export interface HistoryTrader {
  wallet: string;
  /** A human name, when Helius knows one. */
  name?: string;
  category?: string;
  total: number;
  realized: number;
  unrealized: number;
  boughtUsd: number;
  soldUsd: number;
  trades: number;
  qty: number;
  /** First trade to last, or to now while still holding, in seconds. */
  heldSec?: number;
}

export interface TokenHistory {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  candles: ReplayCandle[];
  supply: number;
  /** Bar width in seconds. 15s for a launch, hours for a month-old token. */
  interval: number;
  fills: number;
  transactions: number;
  /** Swaps on the charted book over its whole life. */
  swaps?: number;
  /** The pool the chart was drawn from. */
  venue?: string;
  /** True when every swap in the window was read rather than sampled. */
  exact?: boolean;
  /** True when the named wallet has more history than was read. */
  partial?: boolean;
  firstTs: number;
  lastTs: number;
  /** Present only when a wallet was named. */
  wallet?: string;
  walletName?: string;
  /** Every wallet in the replay, when more than one was asked for. */
  cluster?: string[];
  trades?: ReplayTrade[];
  points?: ReplayPoint[];
  error?: string;
}

/** Who made and lost the most. Fetched separately; see `/api/board`. */
export interface TraderBoard {
  top: HistoryTrader[];
  bottom: HistoryTrader[];
  wallets: number;
  truncated: boolean;
  /** When the ranked wallets were last read, unix seconds. */
  builtAt?: number;
  /** The mark every open position is valued at. */
  price?: number;
  error?: string;
}

/**
 * Rebuild a token from the chain.
 *
 * Slow the first time — the chart is drawn from windows read across the
 * token's whole life — and served from the cache after that, since the bars
 * behind the newest one can never change.
 */
export async function fetchHistory(
  mint: string,
  wallet?: string,
  lead = 300,
  /** Wallets replayed as one position with `wallet`. */
  alongside: string[] = [],
): Promise<TokenHistory | null> {
  const query = new URLSearchParams({ mint, lead: String(lead) });
  if (wallet) query.set("wallet", wallet);
  if (alongside.length > 0) query.set("with", alongside.join(","));
  const res = await fetch(`/api/history?${query}`, { cache: "no-store" });
  const body = (await res.json()) as TokenHistory;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}

/**
 * The trader board, which is the slow half.
 *
 * Fetched on its own so the chart is not held behind it: every wallet ranked
 * here has its complete history read back, which takes an order of magnitude
 * longer than drawing the chart does.
 */
export async function fetchBoard(
  mint: string,
  /** Read every ranked wallet's new transactions before ranking. Slow. */
  update = false,
): Promise<TraderBoard | null> {
  const query = new URLSearchParams({ mint });
  if (update) query.set("update", "1");
  const res = await fetch(`/api/board?${query}`, { cache: "no-store" });
  const body = (await res.json()) as TraderBoard;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}

/** A token this install has already reconstructed. */
export interface BuiltToken {
  mint: string;
  name?: string;
  symbol?: string;
  image?: string;
  interval: number;
  bars: number;
  firstTs: number;
  lastTs: number;
  swaps: number;
  builtAt: number;
}

/**
 * What has already been built.
 *
 * There is no list of every replayable token — it is any Solana mint. This is
 * the useful subset: the ones already reconstructed, which redraw from cache.
 */
export async function fetchBuiltTokens(): Promise<BuiltToken[]> {
  try {
    const res = await fetch("/api/tokens", { cache: "no-store" });
    if (!res.ok) return [];
    return ((await res.json()) as { tokens?: BuiltToken[] }).tokens ?? [];
  } catch {
    return [];
  }
}

/** A wallet the subject moved this token, or real money, with. */
export interface RelatedWallet {
  wallet: string;
  name?: string;
  category?: string;
  kind: "linked" | "infrastructure" | "ephemeral" | "incidental";
  /** Plain sentences behind the classification. */
  why: string[];
  tokensFromSubject: number;
  tokensToSubject: number;
  solFromSubject: number;
  solToSubject: number;
  transfers: number;
  total: number;
  realized: number;
  unrealized: number;
  qty: number;
  trades: number;
}

export interface RelatedReport {
  mint: string;
  wallet: string;
  linked: RelatedWallet[];
  dismissed: RelatedWallet[];
  builtAt: number;
  error?: string;
}

/**
 * The wallets a wallet appears to be operating with.
 *
 * Opt-in: it reads a slice of the subject's non-token history to find funding
 * legs, then reads every candidate it keeps, so it is never on the path of a
 * replay. The links are inference; each carries its evidence.
 */
export async function fetchRelated(
  mint: string,
  wallet: string,
): Promise<RelatedReport | null> {
  const query = new URLSearchParams({ mint, wallet });
  const res = await fetch(`/api/related?${query}`, { cache: "no-store" });
  const body = (await res.json()) as RelatedReport;
  if (!res.ok) return { ...body, error: body.error ?? `error ${res.status}` };
  return body;
}
