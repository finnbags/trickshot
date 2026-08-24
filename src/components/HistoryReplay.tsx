"use client";

import { useCallback, useState } from "react";
import {
  fetchBoard,
  fetchBuiltTokens,
  fetchHistory,
  type BuiltToken,
  type HistoryTrader,
  type TokenHistory,
  type TraderBoard,
} from "@/lib/replay";
import { usdCompact } from "@/lib/format";
import { WalletReplay } from "./WalletReplay";
import { Copy, cx, Label, Panel, PlayButton } from "./ui";

/**
 * Replay for any token, reconstructed on demand.
 *
 * Two steps rather than one form: a mint alone rebuilds the token and shows who
 * made and lost the most, because the useful question is usually "who won
 * here?" before "show me this wallet". Naming a wallet skips straight to it.
 *
 * The chart and the board are fetched SEPARATELY and drawn as they arrive.
 * They cost an order of magnitude apart — the chart is windows read across the
 * token's life, the board is a couple of hundred wallets read in full — and
 * waiting for the second to show the first meant a blank page for minutes on a
 * token that had been drawable in seconds.
 */
export function HistoryReplay({
  /** Rendered on the server so the gallery is there on first paint. */
  initialTokens = [],
  /** True when this deployment serves a curated set and builds nothing new. */
  readOnly = false,
}: {
  initialTokens?: BuiltToken[];
  readOnly?: boolean;
}) {
  const [mint, setMint] = useState("");
  const [wallet, setWallet] = useState("");
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<TokenHistory | null>(null);
  const [board, setBoard] = useState<TraderBoard | null>(null);
  const [ranking, setRanking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [query, setQuery] = useState("");
  const [playing, setPlaying] = useState<{ wallet: string; label?: string } | null>(
    null,
  );
  const [built, setBuilt] = useState<BuiltToken[]>(initialTokens);

  const load = useCallback(async function load(override?: string) {
    const target = (override ?? mint).trim();
    if (!target) return;
    if (override) setMint(override);
    setLoading(true);
    setHistory(null);
    setBoard(null);
    setPlaying(null);
    try {
      const h = await fetchHistory(target, wallet.trim() || undefined);
      setHistory(h);
      if (h && !h.error) {
        if (wallet.trim()) {
          setPlaying({ wallet: wallet.trim(), label: h.walletName });
        }
        // Deliberately not awaited: the board arrives into the page it belongs
        // to rather than holding up the chart that is already drawn.
        setRanking(true);
        void fetchBoard(target)
          .then(setBoard)
          .finally(() => setRanking(false));
      }
    } finally {
      setLoading(false);
      void fetchBuiltTokens().then(setBuilt);
    }
  }, [mint, wallet]);

  /**
   * Rows the filter keeps. Matched against the address and the name, so both
   * "HDix" and "latentfish" find the same wallet.
   */
  const q = query.trim().toLowerCase();
  const keep = (r: HistoryTrader) =>
    !q ||
    r.wallet.toLowerCase().includes(q) ||
    (r.name ?? "").toLowerCase().includes(q);
  const top = (board?.top ?? []).filter(keep);
  const bottom = (board?.bottom ?? []).filter(keep);
  const found = top.length + bottom.length;

  /**
   * Back to the gallery. State rather than a navigation, so the overview
   * comes back instantly and the tokens it already has are not refetched.
   */
  function back() {
    setHistory(null);
    setBoard(null);
    setPlaying(null);
    setQuery("");
    setWallet("");
  }

  return (
    <>
      {/*
        The header lives here rather than in the page so the wordmark can clear
        the open token. A link to `/` cannot: it is the same route, so the state
        holding the token survives the navigation.
      */}
      <header className="mb-7">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={back}
            title="Back to all tokens"
            className="cursor-pointer font-display text-[34px] leading-none font-semibold tracking-[-0.025em] text-tx transition-colors hover:text-tx2"
          >
            <h1>Trickshot</h1>
          </button>
          <a
            href="https://github.com/nathanliow/trickshot"
            target="_blank"
            rel="noreferrer"
            aria-label="Trickshot on GitHub"
            title="Source on GitHub"
            className="text-tx3 transition-colors hover:text-tx"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-[19px] w-[19px]"
              fill="currentColor"
            >
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
        <p className="mt-2.5 max-w-[62ch] text-[14.5px] leading-relaxed text-tx2">
          {readOnly
            ? "Solana tokens rebuilt from the chain. Pick one, then play back what any wallet did on it."
            : "Rebuild any Solana token from the chain, then play back what a wallet did on it."}
        </p>
      </header>

      {playing && history && (
        <WalletReplay
          mint={mint.trim()}
          wallet={playing.wallet}
          label={playing.label}
          /** The wallet typed into the form was already fetched with the chart;
           *  opening its replay should not fetch the same thing again. */
          preloaded={history.wallet === playing.wallet ? history : undefined}
          canCompute={!readOnly}
          onClose={() => setPlaying(null)}
        />
      )}

      {/*
        The form only exists where it can do something. On a curated
        deployment a visitor has the gallery and the boards, and a mint box
        would only ever answer "that token is not on this site yet".
      */}
      {!readOnly && (
      <Panel className="p-4 sm:p-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
          className="flex flex-col gap-4 sm:flex-row sm:items-end"
        >
          <label className="flex min-w-0 flex-[3] flex-col gap-1.5">
            <span className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
              Token mint
            </span>
            <input
              value={mint}
              onChange={(e) => setMint(e.target.value)}
              placeholder={
                readOnly ? "paste a mint that is on this site" : "paste a mint address"
              }
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 rounded-xs border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:border-amber/50 focus:outline-none"
            />
          </label>
          <label className="flex min-w-0 flex-[3] flex-col gap-1.5">
            <span className="flex items-baseline gap-2 font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
              Wallet
              <span className="tracking-normal normal-case">optional</span>
            </span>
            <input
              value={wallet}
              onChange={(e) => setWallet(e.target.value)}
              placeholder="skip straight to one wallet's replay"
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 rounded-xs border border-line-strong bg-ink-900 px-3 py-2.5 font-mono text-[12px] text-tx placeholder:text-tx3 focus:border-amber/50 focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={loading || !mint.trim()}
            className="shrink-0 cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-5 py-2.5 font-mono text-[10px] tracking-[0.12em] text-amber uppercase hover:bg-amber/20 disabled:cursor-default disabled:opacity-40"
          >
            {loading ? "loading…" : readOnly ? "open" : "build"}
          </button>
        </form>

        {loading && (
          <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-tx3">
            Finding the busiest pool, then reading windows across the
            token&rsquo;s whole life. About ten seconds the first time, then
            it&rsquo;s cached.
          </p>
        )}
        {history?.error && (
          <p className="mt-4 border-t border-line pt-3 font-mono text-[11px] text-signal">
            {history.error}
          </p>
        )}
      </Panel>
      )}

      {readOnly && (loading || history?.error) && (
        <Panel className="p-4">
          {loading && (
            <p className="font-mono text-[11px] text-tx3">Loading.</p>
          )}
          {history?.error && (
            <p className="font-mono text-[11px] text-signal">{history.error}</p>
          )}
        </Panel>
      )}

      {built.length > 0 && !history && (
        <section className="mt-8">
          <div className="mb-3 flex items-baseline justify-between">
            <Label>Already built</Label>
            <span className="font-mono text-[10.5px] text-tx3">
              redraws from cache in about two seconds
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {built.map((t) => (
              <button
                key={t.mint}
                type="button"
                onClick={() => void load(t.mint)}
                title={t.mint}
                className="group flex cursor-pointer items-center gap-3 rounded-md border border-line bg-ink-800 p-3 text-left transition-colors hover:border-line-strong hover:bg-ink-700 focus-visible:border-amber/50 focus-visible:outline-none"
              >
                <TokenMark image={t.image} symbol={t.symbol ?? t.name} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="truncate font-display text-[15px] font-semibold text-tx">
                      {t.name ?? t.symbol ?? "Unnamed"}
                    </span>
                    {t.symbol && t.name && (
                      <span className="shrink-0 font-mono text-[10.5px] tracking-[0.08em] text-tx3">
                        {t.symbol}
                      </span>
                    )}
                  </span>
                  {/* Numbers a trader actually scans: how much happened, over
                      how long, at what resolution it was drawn. */}
                  <span className="tnum flex flex-wrap gap-x-3 font-mono text-[10.5px] text-tx3">
                    <span>{compact(t.swaps)} swaps</span>
                    <span>{duration(t.lastTs - t.firstTs)}</span>
                    <span>{duration(t.interval)} bars</span>
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {history && !history.error && (
        <>
          {(history.name || history.symbol) && (
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                onClick={back}
                aria-label="Back to all tokens"
                title="Back to all tokens"
                className="-ml-1 cursor-pointer rounded-xs p-1 text-tx3 transition-colors hover:text-tx"
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M10 3 5 8l5 5" />
                </svg>
              </button>
              <span className="font-display text-[18px] font-semibold text-tx">
                {history.name ?? history.symbol}
              </span>
              {history.name && history.symbol && (
                <span className="font-mono text-[12px] text-tx3">
                  {history.symbol}
                </span>
              )}
            </div>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="Swaps" value={compact(history.swaps ?? 0)} />
            <Stat label="Candles" value={history.candles.length.toLocaleString()} />
            <Stat label="Bar" value={duration(history.interval)} />
            <Stat label="Span" value={duration(history.lastTs - history.firstTs)} />
            <Stat
              label="Bars from"
              value={history.exact ? "every trade" : "sampled"}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Label>Traders</Label>
            <span className="font-mono text-[11px] text-tx3">
              {board?.builtAt
                ? `updated ${ago(board.builtAt)} ago`
                : ranking
                  ? "reading…"
                  : "not read yet"}
            </span>
            {!readOnly && (
            <button
              type="button"
              onClick={() => {
                setUpdating(true);
                void fetchBoard(mint.trim(), true)
                  .then(setBoard)
                  .finally(() => setUpdating(false));
              }}
              disabled={updating || ranking}
              className="cursor-pointer rounded-xs border border-line-strong px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-tx2 uppercase hover:text-tx disabled:opacity-40"
            >
              {updating ? "updating…" : "update"}
            </button>
            )}
            {updating && (
              <span className="font-mono text-[11px] text-tx3">
                reading each ranked wallet&rsquo;s new trades — a minute or so
              </span>
            )}
          </div>

          <div className="mt-3">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter by address or name"
              spellCheck={false}
              className="w-full rounded-xs border border-line-strong bg-ink-900 px-3 py-2 font-mono text-[12px] text-tx placeholder:text-tx3"
            />
            {query.trim() && found === 0 && (
              /**
               * A wallet absent from the board is not a wallet without a
               * history — the board is a shortlist, and plenty of real traders
               * never make it onto one. Replaying works for any address, so an
               * empty search offers that rather than a dead end.
               */
              <div className="mt-2 flex flex-wrap items-center gap-3 rounded-xs border border-line px-3 py-2">
                <span className="font-mono text-[11px] text-tx3">
                  {isAddress(query.trim())
                    ? "Not on this board — it may not have been among the wallets read."
                    : "No match on this board."}
                </span>
                {isAddress(query.trim()) && (
                  <button
                    type="button"
                    onClick={() => setPlaying({ wallet: query.trim() })}
                    className="cursor-pointer rounded-xs border border-amber/40 bg-amber/10 px-2.5 py-1 font-mono text-[10px] tracking-[0.12em] text-amber uppercase"
                  >
                    replay it anyway
                  </button>
                )}
              </div>
            )}
          </div>

          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <Board
              title="Made the most"
              rows={top}
              loading={ranking}
              tone="mint"
              onPlay={(w, n) => setPlaying({ wallet: w, label: n })}
            />
            <Board
              title="Lost the most"
              rows={bottom}
              loading={ranking}
              tone="signal"
              onPlay={(w, n) => setPlaying({ wallet: w, label: n })}
            />
          </div>
          {board?.truncated && (
            <p className="mt-2 font-mono text-[10px] tracking-[0.1em] text-amber uppercase">
              Top traders and worst traders list may be inaccurate — demo
              purposes only
            </p>
          )}
        </>
      )}
    </>
  );
}

/** Helius mirrors token art here; the original is embedded in the path. */
const CDN = "https://cdn.helius-rpc.com/cdn-cgi/image//";

/**
 * A gateway that will actually serve the file.
 *
 * Most Solana token art lives on IPFS and most of it is addressed through
 * `ipfs.io`, which rate-limits hard. MEASURED across the tokens on this site:
 * every image that failed to load was an `ipfs.io` URL answering 403, and
 * every one that loaded was hosted somewhere else. `dweb.link` is the same
 * operator and fails with it; Cloudflare's gateway is gone. Pinata and
 * Filebase both serve the same CIDs.
 */
const IPFS_FALLBACK = "https://gateway.pinata.cloud/ipfs/";

/** Rewrite an IPFS URL onto a gateway that answers. */
function viaGateway(url: string): string | null {
  const cid = url.match(/\/ipfs\/([A-Za-z0-9]+)/)?.[1];
  return cid ? IPFS_FALLBACK + cid : null;
}

/**
 * The token's own artwork, which is how anyone actually recognises one.
 *
 * Two sources are tried, because one is not reliable enough. Helius mirrors
 * the file, which is what makes hotlink-protected hosts work at all; but the
 * mirror has to fetch from wherever the creator put it — often an IPFS gateway
 * — and that can fail or time out. The original is embedded in the mirror's
 * own path, so the fallback needs nothing stored alongside it.
 *
 * `referrerPolicy="no-referrer"` matters more than it looks: at least one host
 * here serves the image to a bare request and answers 403 when a browser sends
 * a Referer, so sending none is what makes the direct URL usable at all.
 *
 * A plain `img` rather than `next/image`: these come from whatever host the
 * creator used, and `next/image` would need every one declared up front.
 */
function TokenMark({ image, symbol }: { image?: string; symbol?: string }) {
  const [attempt, setAttempt] = useState(0);
  const initials = (symbol ?? "?").replace(/[^A-Za-z0-9]/g, "").slice(0, 3);

  /**
   * The mirror, then a working IPFS gateway, then the original.
   *
   * In that order deliberately: the mirror handles hosts that refuse to serve
   * anyone else, the gateway handles the mirror failing to reach a rate-limited
   * `ipfs.io`, and the original covers whatever neither anticipated.
   */
  const origin = image?.startsWith(CDN) ? image.slice(CDN.length) : image;
  const sources = [image, origin ? viaGateway(origin) : null, origin]
    .filter((u): u is string => Boolean(u))
    .filter((u, i, all) => all.indexOf(u) === i);
  const src = sources[attempt];

  if (!src) {
    return (
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-line bg-ink-900 font-mono text-[11px] font-bold tracking-[0.04em] text-tx3 uppercase">
        {initials || "?"}
      </span>
    );
  }
  return (
    /* eslint-disable-next-line @next/next/no-img-element --
       remote hosts are unknowable at build time; see TokenMark. */
    <img
      key={src}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setAttempt((n) => n + 1)}
      className="h-11 w-11 shrink-0 rounded-sm border border-line bg-ink-900 object-cover"
    />
  );
}

/** Base58, 32-44 characters — the same shape the API insists on. */
function isAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** 1.8M, 12.4K — a swap count nobody wants to read digit by digit. */
function compact(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return String(Math.round(v));
}

/** "4h", "12m" — how long ago a unix timestamp was. */
function ago(at: number): string {
  return duration(Math.max(Math.floor(Date.now() / 1000) - at, 0));
}

function duration(sec: number): string {
  if (sec >= 86_400) return `${(sec / 86_400).toFixed(1)}d`;
  if (sec >= 3_600) return `${(sec / 3_600).toFixed(sec % 3_600 ? 1 : 0)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-sm border border-line bg-ink-800 px-3 py-2.5">
      <div className="font-mono text-[9px] tracking-[0.14em] text-tx3 uppercase">
        {label}
      </div>
      <div className="tnum mt-1 font-mono text-[15px] font-bold text-tx">{value}</div>
    </div>
  );
}

function Board({
  title,
  rows,
  loading,
  tone,
  onPlay,
}: {
  title: string;
  rows: HistoryTrader[];
  loading: boolean;
  tone: "mint" | "signal";
  onPlay: (wallet: string, name?: string) => void;
}) {
  return (
    <Panel className="overflow-hidden">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <Label>{title}</Label>
        {rows.length > 0 && (
          <span className="tnum font-mono text-[10px] text-tx3">{rows.length}</span>
        )}
      </div>
      {loading && rows.length === 0 && (
        <p className="px-4 py-6 font-mono text-[11px] text-tx3">
          reading every candidate wallet&rsquo;s full history on this mint…
        </p>
      )}
      {!loading && rows.length === 0 && (
        <p className="px-4 py-6 font-mono text-[11px] text-tx3">
          no wallets with a known cost basis
        </p>
      )}
      <div className="max-h-[420px] overflow-y-auto">
      {rows.map((r, i) => (
        /* A row, not a button: the address needs to be selectable and to carry
           its own copy control, and a button inside a button is invalid markup
           the browser resolves by dropping one of them. */
        <div
          key={r.wallet}
          /* Two lines on a phone, one on a desktop. Seven things competing for
             one row left nothing for the address, which is the only part that
             identifies the wallet. */
          className="flex w-full flex-col gap-1.5 border-b border-line px-4 py-2.5 last:border-b-0 hover:bg-ink-700 sm:flex-row sm:items-center sm:gap-2"
        >
          <span className="flex min-w-0 items-center gap-2 sm:flex-1">
            <span className="tnum w-5 shrink-0 font-mono text-[11px] text-tx3">
              {i + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              {r.name && (
                <span
                  title={r.category ?? r.name}
                  className="truncate font-mono text-[11.5px] font-medium text-tx"
                >
                  {r.name}
                </span>
              )}
              {/*
                The clipping lives on this BLOCK, not on the address inside it.
                `truncate` needs a box with a width to clip against, and an
                inline element has neither — so the full address rendered at
                its natural width and ran straight through the copy button and
                the figures beside it.
              */}
              <span
                title={r.wallet}
                className={cx(
                  "block min-w-0 truncate font-mono",
                  r.name ? "text-[10px] text-tx3" : "text-[11.5px] text-tx2",
                )}
              >
                {/* Ends only where there is no room for the middle. The copy
                    button is what people actually use to take the address. */}
                <span className="sm:hidden">
                  {r.wallet.slice(0, 6)}…{r.wallet.slice(-6)}
                </span>
                <span className="hidden select-all sm:inline">{r.wallet}</span>
              </span>
            </span>
            <Copy value={r.wallet} label="wallet address" />
          </span>

          <span className="flex items-center gap-3 pl-7 sm:shrink-0 sm:gap-2 sm:pl-0">
            <span
              title="First trade to last — or to now, if still holding"
              className="tnum shrink-0 font-mono text-[10.5px] text-tx3"
            >
              {r.heldSec ? `held ${duration(r.heldSec)}` : "—"}
            </span>
            <span className="tnum shrink-0 font-mono text-[10.5px] text-tx3">
              {r.trades} trades
            </span>
            <span
              className={cx(
                "tnum ml-auto text-right font-mono text-[12.5px] font-bold sm:ml-0 sm:w-24",
                tone === "mint" ? "text-mint" : "text-signal",
              )}
            >
              {r.total >= 0 ? "+" : "−"}
              {usdCompact(Math.abs(r.total))}
            </span>
            <PlayButton
              onClick={() => onPlay(r.wallet, r.name)}
              label={`Replay ${r.name ?? r.wallet}`}
            />
          </span>
        </div>
      ))}
      </div>
    </Panel>
  );
}
