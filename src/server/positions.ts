/**
 * Per-token PnL: the leaderboard, and the replay curve behind it.
 *
 * Two accountings are kept side by side on purpose.
 *
 *   cash-flow   pnl = cash + qty × price. Pure sums, so it is order-
 *               independent and immune to replayed or out-of-order fills.
 *               This is the number the leaderboard ranks on.
 *
 *   avg-cost    splits that total into realized and unrealized. Order-
 *               dependent, so it can only be folded here in the worker where
 *               stream order is known.
 *
 * They must agree. `basisDrift` reports where they do not, which is how we
 * catch tokens arriving by transfer rather than by purchase — a wallet that
 * sells what it never bought has no cost basis, and would otherwise show up on
 * the board as a fabricated winner.
 */

export interface Fill {
  ts: number;
  isBuy: boolean;
  base: number;
  usd: number;
  /**
   * Whether money changed hands.
   *
   * A transfer moves tokens with no price attached — an airdrop, a bundler
   * distributing to its wallets, someone consolidating their own funds. It
   * must move `qty`, because the position is real and the chain says so, and
   * it must NOT create a cost basis, because none was paid. Booking transfers
   * as buys at the prevailing price is how a wallet that was given 32 million
   * tokens ends up on a leaderboard as its biggest winner.
   */
  kind?: "swap" | "transfer";
}

export interface Position {
  wallet: string;
  qty: number;
  /** Signed cash flow: negative when net spent. */
  cash: number;
  /** Cost basis of the currently held qty. */
  costBasis: number;
  realized: number;
  buys: number;
  sells: number;
  /**
   * Lifetime traded totals, kept as running sums rather than derived from
   * `fills` — that array is capped at MAX_FILLS_PER_POSITION, so a busy wallet
   * would silently lose the earliest half of its history.
   */
  boughtUsd: number;
  boughtBase: number;
  soldUsd: number;
  soldBase: number;
  firstTs: number;
  lastTs: number;
  /**
   * Tokens, and dollars, sold with no cost basis behind them.
   *
   * Summed rather than flagged. A single boolean made any unmatched sell
   * disqualifying however small, and small is the normal case: MEASURED, a
   * wallet up $487,000 was kept off the board because the first thing it ever
   * did on the mint was sell 503 tokens for $2.34. Airdrop dust, a bundler
   * distribution, a transfer in from another wallet — all of them trip it, and
   * none of them means the wallet's PnL is fiction.
   */
  unknownBase: number;
  unknownUsd: number;
  fills: Fill[];
}

export interface PnlRow {
  wallet: string;
  /** A human name, when Helius knows one. See `identity.ts`. */
  name?: string;
  category?: string;
  qty: number;
  /** Lifetime USD in and out. */
  boughtUsd: number;
  soldUsd: number;
  /**
   * Size-weighted execution price per side, or 0 when that side never traded.
   * Multiply by supply for the average market cap they bought or sold at —
   * the client already knows supply, and this keeps the worker unit-agnostic.
   */
  avgBuyPrice: number;
  avgSellPrice: number;
  realized: number;
  unrealized: number;
  total: number;
  trades: number;
  unknownBasis: boolean;
  /** |cash-flow total − (realized+unrealized)|. Should be ~0. */
  basisDrift: number;
}

export interface ReplayPoint {
  minute: number;
  qty: number;
  price: number;
  realized: number;
  unrealized: number;
  total: number;
  /** Cash in and out UP TO this point, so the replay can show them growing. */
  boughtUsd: number;
  soldUsd: number;
}

/**
 * Fills kept per wallet, for the replay.
 *
 * MEASURED, and this is where the memory actually goes: a position holding 2
 * fills is 400 bytes, one holding 500 is 48KB — 120x for history nothing reads.
 * The PnL figures do not depend on it (buys, sells and the traded totals are
 * running sums), so trimming this costs only the tail of a heavy wallet's
 * replay, and 60 fills is already more trades than a replay can legibly mark.
 */
const MAX_FILLS_PER_POSITION = Number(process.env.MAX_FILLS_PER_POSITION ?? 60);

/**
 * Wallets kept per token.
 *
 * Every wallet that trades gets a position, and a position with a full fill
 * ring is ~20KB — MEASURED at 592 wallets on one ordinary token, so a launch
 * that actually runs would carry tens of thousands and hundreds of megabytes
 * with it.
 *
 * What the product asks of this data is the two ENDS: who made the most and
 * who lost the most. The middle — a wallet that bought $9 and sold $9 — is
 * never read. So the book is bounded and the middle is what gets dropped.
 *
 * Four hundred rather than twenty, even though only ten are displayed. The
 * ranking is not static: a wallet sitting fortieth becomes first the moment it
 * sells, and an evicted wallet loses its cost basis for good — it comes back as
 * `unknownBasis` and can never rank again. Keeping only what is currently
 * displayed would produce "the top ten of the twenty we happened to keep".
 * MEASURED at ~600 bytes a position once the fill ring is bounded, 400 wallets
 * is a quarter of a megabyte per token.
 */
const MAX_WALLETS_PER_MINT = Number(process.env.MAX_WALLETS_PER_MINT ?? 400);

/**
 * How much of a wallet may be unaccounted for before its PnL is not worth
 * showing.
 *
 * A ratio, not a flag. Below this the unexplained tokens move the total by less
 * than the noise already in it; above it, the number on screen is mostly a
 * guess about where the tokens came from.
 */
const UNKNOWN_BASIS_RATIO = Number(process.env.UNKNOWN_BASIS_RATIO ?? 0.05);

function unknownBasis(p: Position): boolean {
  /**
   * Measured in TOKENS as well as dollars.
   *
   * The dollar test only sees tokens sold without a basis. A wallet that was
   * handed its whole position and has not sold yet has no unexplained dollars
   * at all, and its unrealized "profit" is the entire mark-to-market value of
   * a gift. MEASURED on this token's number-one wallet: 32.2M tokens in by
   * transfer, 0.37 SOL ever spent, ranked at +$4.66M.
   */
  const position = p.qty + p.soldBase;
  if (position > 0 && p.unknownBase / position > UNKNOWN_BASIS_RATIO) return true;
  const flow = Math.max(p.boughtUsd, p.soldUsd);
  return flow <= 0 ? p.unknownUsd > 0 : p.unknownUsd / flow > UNKNOWN_BASIS_RATIO;
}
/** Trim to this many, so the sort runs occasionally rather than per fill. */
const TRIM_TO = Math.floor(MAX_WALLETS_PER_MINT * 0.75);

export class PositionBook {
  /** mint -> wallet -> position */
  private readonly byMint = new Map<string, Map<string, Position>>();

  /**
   * The default bound suits a book holding hundreds of wallets. A book holding
   * ONE — the wallet being replayed — should keep everything: the replay curve
   * is drawn from these fills while the headline PnL is drawn from running
   * sums, so truncating them made the curve stop moving partway through while
   * the number beside it carried on.
   */
  constructor(private readonly maxFills: number = MAX_FILLS_PER_POSITION) {}

  apply(
    mint: string,
    wallet: string,
    fill: Fill,
  ): void {
    let wallets = this.byMint.get(mint);
    if (!wallets) {
      wallets = new Map();
      this.byMint.set(mint, wallets);
    }

    let p = wallets.get(wallet);
    if (!p) {
      p = {
        wallet,
        qty: 0,
        cash: 0,
        costBasis: 0,
        realized: 0,
        buys: 0,
        sells: 0,
        boughtUsd: 0,
        boughtBase: 0,
        soldUsd: 0,
        soldBase: 0,
        firstTs: fill.ts,
        lastTs: fill.ts,
        unknownBase: 0,
        unknownUsd: 0,
        fills: [],
      };
      wallets.set(wallet, p);
    }

    p.lastTs = Math.max(p.lastTs, fill.ts);
    if (p.fills.length < this.maxFills) p.fills.push(fill);
    // The fill's own execution price: the freshest mark available here, and
    // trimming is the only thing that needs one.
    if (wallets.size > MAX_WALLETS_PER_MINT) {
      this.trim(wallets, fill.base > 0 ? fill.usd / fill.base : 0);
    }

    if (fill.kind === "transfer") {
      // Tokens in with no basis, or out with no proceeds. Counted in the
      // position and excluded from every price-derived figure.
      if (fill.isBuy) {
        p.qty += fill.base;
        p.unknownBase += fill.base;
      } else {
        const sent = Math.min(fill.base, p.qty);
        if (sent > 0 && p.qty > 0) {
          p.costBasis -= (p.costBasis / p.qty) * sent;
          p.qty -= sent;
        }
      }
      return;
    }

    if (fill.isBuy) {
      p.qty += fill.base;
      p.cash -= fill.usd;
      p.costBasis += fill.usd;
      p.buys += 1;
      p.boughtUsd += fill.usd;
      p.boughtBase += fill.base;
      return;
    }

    p.cash += fill.usd;
    p.sells += 1;
    p.soldUsd += fill.usd;
    p.soldBase += fill.base;

    // Weighted-average realisation over the portion we can account for.
    const sold = Math.min(fill.base, p.qty);
    if (sold > 0) {
      const avgCost = p.costBasis / p.qty;
      const proceeds = fill.usd * (sold / fill.base);
      p.realized += proceeds - avgCost * sold;
      p.costBasis -= avgCost * sold;
      p.qty -= sold;
    }
    const unmatched = fill.base - sold;
    if (unmatched > 1e-9) {
      // Sold tokens that never arrived as a tracked buy: airdrop, dev alt,
      // bundler distribution. Proceeds are pure profit but the basis is a
      // fiction, so record how much of the wallet is fiction rather than
      // condemning the whole of it.
      p.unknownBase += unmatched;
      p.unknownUsd += fill.usd * (unmatched / fill.base);
    }
  }

  /** Ranked by cash-flow total PnL at the given price. */
  leaderboard(
    mint: string,
    price: number,
    limit = 10,
    includeUnknownBasis = false,
  ): { top: PnlRow[]; bottom: PnlRow[]; wallets: number } {
    const wallets = this.byMint.get(mint);
    if (!wallets) return { top: [], bottom: [], wallets: 0 };

    const rows: PnlRow[] = [];
    for (const p of wallets.values()) {
      const unknown = unknownBasis(p);
      if (unknown && !includeUnknownBasis) continue;
      const unrealized = p.qty * price - p.costBasis;
      const total = p.cash + p.qty * price;
      rows.push({
        wallet: p.wallet,
        qty: p.qty,
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
        realized: p.realized,
        unrealized,
        total,
        trades: p.buys + p.sells,
        unknownBasis: unknown,
        basisDrift: Math.abs(total - (p.realized + unrealized)),
      });
    }

    rows.sort((a, b) => b.total - a.total);
    return {
      top: rows.slice(0, limit),
      bottom: rows.slice(-limit).reverse(),
      wallets: rows.length,
    };
  }

  /** Every wallet with an open position, largest first. */
  openPositions(mint: string, price: number, limit = 100): PnlRow[] {
    const wallets = this.byMint.get(mint);
    if (!wallets) return [];
    return [...wallets.values()]
      .filter((p) => p.qty > 0)
      .map((p) => ({
        wallet: p.wallet,
        qty: p.qty,
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
        realized: p.realized,
        unrealized: p.qty * price - p.costBasis,
        total: p.cash + p.qty * price,
        trades: p.buys + p.sells,
        unknownBasis: unknownBasis(p),
        basisDrift: 0,
      }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, limit);
  }

  /**
   * Minute-by-minute PnL for one wallet on one token.
   *
   * Re-folds the wallet's fills against the token's 1m closes, so realized and
   * unrealized are both correct as of each minute rather than back-projected
   * from the current position.
   */
  /**
   * Drop the wallets nobody will ever ask about.
   *
   * Ranked by how likely a row is to be READ: anything still holding stays,
   * because an open position is what "who is in this token" means and its PnL
   * is still moving. Everything closed is ranked by the size of what it moved
   * — `cash`, the signed net flow — so the biggest winners and the biggest
   * losers are both at the top of that ordering and the noise is at the bottom.
   *
   * A trimmed wallet that trades again starts fresh with `unknownBasis`, so it
   * is excluded from the rankings rather than appearing with a fabricated cost
   * basis. That is the cost of the bound, and it only ever lands on wallets
   * that were too small to rank in the first place.
   */
  private trim(wallets: Map<string, Position>, price: number): void {
    /**
     * Ranked by what the wallet is WORTH, not only by what it has moved.
     *
     * Cash alone evicts the most interesting wallet on the board: someone who
     * spent $50 and is riding it to a hundred times that has tiny cash flow
     * until the moment they sell. Adding the mark-to-market value of what they
     * still hold keeps them, which is the whole reason anyone reads this table.
     */
    const worth = (p: Position) => Math.abs(p.cash) + p.qty * price;
    const ranked = [...wallets.values()].sort((a, b) => worth(b) - worth(a));
    for (const p of ranked.slice(TRIM_TO)) wallets.delete(p.wallet);
  }

  /** A wallet's own fills on one token, oldest first. */
  fillsFor(mint: string, wallet: string): Fill[] {
    const p = this.byMint.get(mint)?.get(wallet);
    return p ? [...p.fills].sort((a, b) => a.ts - b.ts) : [];
  }

  replay(
    mint: string,
    wallet: string,
    closesByBucket: Map<number, number>,
    /** Bucket width. 60 when walking minutes, 15 for the fine-grained replay. */
    intervalSec = 60,
  ): ReplayPoint[] {
    const p = this.byMint.get(mint)?.get(wallet);
    if (!p || p.fills.length === 0) return [];

    const minutes = [...closesByBucket.keys()].sort((a, b) => a - b);
    if (minutes.length === 0) return [];

    const fills = [...p.fills].sort((a, b) => a.ts - b.ts);
    let i = 0;
    let qty = 0;
    let costBasis = 0;
    let realized = 0;
    let lastPrice = 0;
    // Running totals rather than the position's lifetime figures: the replay
    // is a moment in time, so what was spent and taken must be as of that bar.
    let boughtUsd = 0;
    let soldUsd = 0;
    const out: ReplayPoint[] = [];

    for (const minute of minutes) {
      const cutoff = minute + intervalSec;
      while (i < fills.length && fills[i]!.ts < cutoff) {
        const f = fills[i]!;
        if (f.isBuy) {
          qty += f.base;
          costBasis += f.usd;
          boughtUsd += f.usd;
        } else {
          soldUsd += f.usd;
          const sold = Math.min(f.base, qty);
          if (sold > 0 && qty > 0) {
            const avgCost = costBasis / qty;
            const proceeds = f.usd * (sold / f.base);
            realized += proceeds - avgCost * sold;
            costBasis -= avgCost * sold;
            qty -= sold;
          }
        }
        i += 1;
      }

      const price = closesByBucket.get(minute) ?? lastPrice;
      lastPrice = price;
      const unrealized = qty * price - costBasis;
      out.push({
        minute,
        qty,
        price,
        realized,
        unrealized,
        total: realized + unrealized,
        boughtUsd,
        soldUsd,
      });
    }

    return out;
  }

  /**
   * MEASURED at 133.7 MB of a 178 MB snapshot — 75% of it — across 221,454
   * wallets and 820,364 stored fills. The median token has 13 wallets and the
   * largest has 4,688, so the weight is a long tail of one-trade wallets that
   * no view ever reads: the leaderboard shows 10 each way and openPositions
   * caps at 100.
   *
   * So the tail is dropped rather than persisted. Wallets still holding rank
   * first, then by cash flow, which is what the board orders by. `fills` are
   * kept only for the top slice — they are half the remaining bytes and only
   * feed the per-wallet replay chart, which is opened for a named wallet, not
   * for all 4,688 of them.
   */
  /**
   * Persisted positions.
   *
   * `maxPerMint` matches the live cap on purpose. It used to be 100 against a
   * live book of 400, so every restart deleted three quarters of the field —
   * MEASURED, 4 of 18 tracked tokens were over 100 wallets, and their all-time
   * rankings were being drawn from whatever survived the last deploy. Fills are
   * still kept for only the first few, since those are for the replay and cost
   * far more than the figures do.
   */
  toJSON(keep?: Set<string>, maxPerMint = 400, withFills = 20): [string, Position[]][] {
    return [...this.byMint]
      .filter(([mint]) => !keep || keep.has(mint))
      .map(([mint, w]) => {
        const ranked = [...w.values()].sort((a, b) => {
          const open = Number(b.qty > 0) - Number(a.qty > 0);
          return open !== 0 ? open : Math.abs(b.cash) - Math.abs(a.cash);
        });
        const kept = ranked.slice(0, maxPerMint).map((p, i) =>
          i < withFills ? p : { ...p, fills: [] },
        );
        return [mint, kept] as [string, Position[]];
      });
  }

  load(rows: [string, Position[]][]): void {
    for (const [mint, positions] of rows) {
      this.byMint.set(
        mint,
        new Map(
          positions.map((p) => [
            p.wallet,
            // Positions written before the traded totals existed have no such
            // fields; left undefined they propagate NaN through every average
            // computed from them. Their history is genuinely unknown, so they
            // start at zero and rebuild from subsequent fills.
            {
              ...p,
              boughtUsd: p.boughtUsd ?? 0,
              boughtBase: p.boughtBase ?? 0,
              soldUsd: p.soldUsd ?? 0,
              soldBase: p.soldBase ?? 0,
            },
          ]),
        ),
      );
    }
  }

  /**
   * Lifetime buy/sell flow per wallet, keyed by wallet.
   *
   * The holders view is a balance snapshot from the RPC, which knows nothing
   * about how those tokens were acquired. Joining this on gives each holder
   * the same bought/sold columns the traders board has — for wallets we have
   * seen trade; a wallet that only ever received a transfer has no entry.
   */
  flows(mint: string): Map<string, {
    boughtUsd: number;
    soldUsd: number;
    avgBuyPrice: number;
    avgSellPrice: number;
  }> {
    const wallets = this.byMint.get(mint);
    if (!wallets) return new Map();
    const out = new Map<string, {
      boughtUsd: number;
      soldUsd: number;
      avgBuyPrice: number;
      avgSellPrice: number;
    }>();
    for (const p of wallets.values()) {
      out.set(p.wallet, {
        boughtUsd: p.boughtUsd,
        soldUsd: p.soldUsd,
        avgBuyPrice: p.boughtBase > 0 ? p.boughtUsd / p.boughtBase : 0,
        avgSellPrice: p.soldBase > 0 ? p.soldUsd / p.soldBase : 0,
      });
    }
    return out;
  }

  /** Called when a token is evicted from tracking. */
  drop(mint: string): void {
    this.byMint.delete(mint);
  }

  get tokens(): number {
    return this.byMint.size;
  }

  get positions(): number {
    let n = 0;
    for (const w of this.byMint.values()) n += w.size;
    return n;
  }

  /**
   * Every position on a mint, in a shape that survives a round trip to storage.
   *
   * The fill ring is deliberately left out: it is the only unbounded part of a
   * position and nothing that reads a restored book needs it. A replay is
   * always built from the wallet's own freshly-read history, never from here.
   */
  snapshot(mint: string): Record<string, StoredPosition> {
    const wallets = this.byMint.get(mint);
    if (!wallets) return {};
    const out: Record<string, StoredPosition> = {};
    for (const [address, p] of wallets) {
      const { wallet, fills, ...rest } = p;
      void wallet;
      void fills;
      out[address] = rest;
    }
    return out;
  }

  /**
   * Put a stored book back, so an update can carry on from where it stopped.
   *
   * This is what makes refreshing a token cheap. Average-cost accounting is
   * order-dependent, so without the position in hand the whole history has to
   * be read again to price one new sell; with it, only what happened since the
   * last build matters.
   */
  restore(mint: string, stored: Record<string, StoredPosition>): void {
    const wallets = new Map<string, Position>();
    for (const [address, p] of Object.entries(stored)) {
      wallets.set(address, { wallet: address, ...p, fills: [] });
    }
    this.byMint.set(mint, wallets);
  }

}

/** A position without its fill ring. See `PositionBook.snapshot`. */
export type StoredPosition = Omit<Position, "wallet" | "fills">;
