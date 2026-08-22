"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  fetchHistory,
  fetchRelated,
  type RelatedReport,
  type Replay,
  type ReplayPoint,
  type TokenHistory,
} from "@/lib/replay";
import { usdCompact } from "@/lib/format";
import { Copy, cx, Label, useAutoPlay, useEffects } from "./ui";

/**
 * One wallet's trades on one token, played back on the real chart.
 *
 * Built to be screen-recorded, and every choice follows from that: the same
 * lightweight-charts renderer the token page uses, so a capture matches what
 * people already recognise; a bar width chosen from the window the wallet
 * actually traded in, so a launch that runs in ninety seconds is not two
 * frames; the wallet's own buys and sells marked on the bars as they happen;
 * and playback that LOOPS, so a recording can be trimmed anywhere without
 * hunting for the start.
 *
 * The chart is fed a growing slice of the candles rather than being scrolled,
 * which is what makes the replay read as the token forming rather than as a
 * viewport moving across finished history.
 */
let lwcChunk: Promise<typeof import("lightweight-charts")> | null = null;
function loadLwc() {
  lwcChunk ??= import("lightweight-charts");
  return lwcChunk;
}

const SPEEDS = [1, 2, 4, 8] as const;
/**
 * Bar widths offered, as multiples of the one the replay was built at.
 *
 * Only coarser. Merging bars is arithmetic on data already in the browser and
 * happens between frames; a FINER bar is a different series — they are stored
 * per mint and interval — so it would mean going back to the chain and waiting.
 */
const ZOOMS = [1, 2, 4, 8] as const;

/**
 * Merge every `factor` bars into one.
 *
 * The open comes from the first bar in the group and the close from the last,
 * with the extremes carried across all of them, which is what a wider bar of
 * the same trades is. The PnL curve is sampled rather than combined: each
 * point is already the wallet's running position at that bar, so the right
 * value for a merged bar is simply the last one inside it.
 */
function coarsen(d: Replay | null, factor: number): Replay | null {
  if (!d || factor <= 1 || d.candles.length === 0) return d;
  const interval = d.interval * factor;

  const candles: Replay["candles"] = [];
  const points: Replay["points"] = [];
  let bucket = -1;

  d.candles.forEach((c, i) => {
    const t = Math.floor(c.t / interval) * interval;
    const last = candles[candles.length - 1];
    if (!last || t !== bucket) {
      bucket = t;
      candles.push({ ...c, t });
      if (d.points[i]) points.push(d.points[i]);
      return;
    }
    last.h = Math.max(last.h, c.h);
    last.l = Math.min(last.l, c.l);
    last.c = c.c;
    last.v += c.v;
    // Later point in the same bucket wins: it is the more recent position.
    if (d.points[i]) points[points.length - 1] = d.points[i];
  });

  return { ...d, interval, candles, points };
}
/** Bar width for a label: 15s, 5m, 2h. */
function barLabel(sec: number): string {
  if (sec >= 3_600) return `${(sec / 3_600).toFixed(sec % 3_600 ? 1 : 0)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  return `${Math.round(sec)}s`;
}
/** Pixels per bar. Fixed, so the replay scrolls instead of squeezing. */
const BAR_SPACING = 9;
/**
 * Real milliseconds one bar takes to form at 1x.
 *
 * Long enough that the bar visibly grows rather than blinking into place —
 * the whole point of animating it — and short enough that a token's first few
 * minutes still replay in a recordable span.
 */
const STEP_MS = 600;

type Mode = "candles" | "line";

/** One fill announcing itself over the chart. */
interface Flash {
  id: number;
  isBuy: boolean;
  usd: number;
  /** Market cap at the bar it landed on, already converted. */
  cap: number;
  /** Stacking offset, so a buy and a sell in one bar do not sit on top of
   *  each other. */
  slot: number;
  /** Which wallet, when a cluster is being replayed. */
  who?: string;
  /**
   * `enter` for one frame so the transition has somewhere to come from, then
   * `shown`, then `out` — either when its time is up or when the next fill
   * needs the space.
   */
  phase: "enter" | "shown" | "out";
  /** When it appeared, so it can retire itself. */
  bornAt: number;
}

let flashId = 0;
/** How long a label holds before it leaves of its own accord. */
const FLASH_MS = 1_400;

/**
 * Redenominate the candles from price to market cap.
 *
 * Done once at the boundary rather than at each draw: the chart, the crosshair,
 * the axis and the ATH line then all read the same number, and nothing
 * downstream has to know a conversion happened. A market cap is what anyone
 * watching a recording actually recognises — "it ran to four million" means
 * something, "it ran to 0.0000042" does not.
 *
 * Supply is constant over a replay, so scaling every OHLC value by it leaves
 * the shape of the chart untouched. With no supply figure the prices stand
 * as they are rather than collapsing the chart to zero.
 */
function toMarketCap(d: Replay): Replay {
  if (!(d.supply > 0)) return d;
  const s = d.supply;
  return {
    ...d,
    candles: d.candles.map((c) => ({
      ...c,
      o: c.o * s,
      h: c.h * s,
      l: c.l * s,
      c: c.c * s,
    })),
  };
}

/** Market cap for an axis label: $1.2M, $940K, $8.4K. */
function capLabel(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

/**
 * Market cap when we have supply, price when we do not.
 *
 * A price axis with nine decimals is unreadable at a glance and a market cap
 * axis with nine decimals is nonsense, so the format follows the units the
 * data is actually in.
 */
const capFormat = { type: "custom" as const, formatter: capLabel, minMove: 1 };
const priceFormat = { type: "price" as const, precision: 9, minMove: 1e-9 };

export function WalletReplay({
  mint,
  wallet,
  label,
  preloaded,
  canCompute = false,
  onClose,
}: {
  mint: string;
  wallet: string;
  label?: string;
  /**
   * The history this replay needs, when the page already has it.
   *
   * Opening a replay used to refetch exactly what the page had just fetched,
   * and the wallet path is not cached by mint alone, so it ran the whole
   * reconstruction a second time.
   */
  preloaded?: TokenHistory;
  /** Linked wallets are worked out where writes are possible; read anywhere. */
  canCompute?: boolean;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState<Replay | null>(null);
  const [zoom, setZoom] = useState<number>(1);
  /**
   * What the chart actually draws. `raw` is what the server sent; every bar
   * width offered is derived from it without another request.
   */
  const data = useMemo(() => coarsen(raw, zoom), [raw, zoom]);
  const [at, setAt] = useState(0);
  /**
   * Starts false and is turned on when the data lands.
   *
   * The FIRST play always happens — a replay that opens paused on an empty
   * frame reads as broken. The toggle governs what happens when it loops.
   */
  const [playing, setPlaying] = useState(false);
  /**
   * Bumped whenever the chart is rebuilt, purely to re-run the paint effect.
   *
   * This was `setAt((i) => i)`, which sets the same value — React bails out of
   * the render, so nothing repainted into the new series. The chart is rebuilt
   * exactly when the data arrives (`asCap` flips as supply becomes known), so
   * the first paint was the one being lost, and the replay sat blank until
   * some unrelated click forced a render.
   */
  const [chartBuilt, setChartBuilt] = useState(0);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(2);
  const [mode, setMode] = useState<Mode>("candles");
  const [effectsOn, setEffectsOn] = useEffects();
  /**
   * Whether the replay LOOPS. The first play always happens; this decides
   * whether it starts over at the end or holds on the final bar, which is what
   * you want once a recording is done.
   */
  const [autoPlay, setAutoPlay] = useAutoPlay();
  /**
   * Fills currently animating over the chart.
   *
   * Held in state rather than drawn into the canvas because the chart library
   * owns that canvas — anything painted there is wiped on the next update, and
   * a fill's flash has to outlive the bar that produced it.
   */
  const [flashes, setFlashes] = useState<Flash[]>([]);
  /**
   * Wallets this one appears to be operating with. Never fetched on open —
   * it reads other wallets' histories, and a replay should not wait for that.
   */
  const [related, setRelated] = useState<RelatedReport | null>(null);
  const [findingRelated, setFindingRelated] = useState(false);
  /** Null until asked; false when this wallet has no graph to show. */
  const [hasGraph, setHasGraph] = useState<boolean | null>(null);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  /** Which wallet the loaded data belongs to, so a cluster change is not
   *  mistaken for a wallet change. */
  const subject = useRef("");
  /** Whether the loaded candles are market caps. Drives the axis format, so
   *  the chart is rebuilt once when it flips on load. */
  const asCap = (data?.supply ?? 0) > 0;

  /** Sorted so the same selection in a different order is the same request. */
  const foldedKey = [...folded].sort().join(",");
  const alongside = useMemo(
    () => (foldedKey ? foldedKey.split(",") : []),
    [foldedKey],
  );

  const holder = useRef<HTMLDivElement>(null);
  const api = useRef<{
    chart: {
      remove(): void;
      timeScale(): { scrollToRealTime(): void };
    };
    series: { setData(rows: unknown[]): void; update(row: unknown): void };
    markers: { setMarkers(m: unknown[]): void } | null;
    lwc: typeof import("lightweight-charts");
    /** Index already painted into THIS series, so a step can append instead of
     *  rebuilding. Lives on the handle because it is only meaningful for the
     *  chart currently mounted — a mode switch builds a fresh, empty one. */
    painted: number;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * The token is read back off the chain, whole, however old it is — there
     * is no live feed here to fall back to, and it turns out not to be needed:
     * a reconstruction covers the run-up as well as the present.
     */
    const shape = (h: TokenHistory | null): Replay => ({
      /**
       * The server's own bar width, not a constant.
       *
       * This was hardcoded to 15, and everything that buckets by it inherited
       * that: a trade at 12:47 on a two-hour chart was marked at 12:47:00
       * rounded to the nearest 15 seconds, which is not a time any bar sits at,
       * so the marker was dropped and the wallet's trades never appeared on the
       * candles they belonged to.
       */
      interval: h?.interval || 15,
      supply: h?.supply ?? 0,
      candles: h?.candles ?? [],
      trades: h?.trades ?? [],
      points: h?.points ?? [],
    });
    /**
     * A cluster reload is a real request, so it waits a moment: ticking three
     * wallets in a row should fetch once, not three times.
     */
    const load =
      preloaded && alongside.length === 0
        ? Promise.resolve(shape(preloaded))
        : new Promise<void>((r) => {
            timer = setTimeout(r, alongside.length > 0 ? 400 : 0);
          }).then(() => fetchHistory(mint, wallet, 300, alongside).then(shape));
    void load.then((d) => {
      if (cancelled) return;
      setRaw(toMarketCap(d));
      setAt(0);
      /**
       * A different wallet's graph is not this wallet's — but a CLUSTER change
       * is the same wallet, and clearing the selection there would undo the
       * tick that caused the reload.
       */
      if (subject.current !== `${mint}|${wallet}`) {
        subject.current = `${mint}|${wallet}`;
        setRelated(null);
        setFolded(new Set());
      }

      // Always, whatever the toggle says. See `playing`.
      setPlaying(true);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [mint, wallet, preloaded, alongside]);

  // Build the chart once per display mode. Switching mode swaps the series
  // type, which means a fresh chart rather than a mutated one.
  useEffect(() => {
    let dead = false;
    void (async () => {
      const lwc = await loadLwc();
      if (dead || !holder.current) return;
      holder.current.innerHTML = "";
      const chart = lwc.createChart(holder.current, {
        height: 340,
        layout: {
          background: { color: "transparent" },
          textColor: "#8a93a6",
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          timeVisible: true,
          secondsVisible: true,
          /**
           * Fixed spacing with the right edge pinned — the way a live chart
           * behaves. The first version called fitContent() on every frame,
           * which rescaled the whole range each step, so bars squeezed
           * narrower as the replay ran instead of scrolling past.
           */
          barSpacing: BAR_SPACING,
          /**
           * Half the visible bars of empty space to the right, so the newest
           * bar sits mid-chart with room ahead of it. Pinning it to the right
           * edge left the action crammed against the frame with nowhere for
           * the next move to go — bad to watch and worse to record.
           */
          rightOffset: Math.round(
            (holder.current.clientWidth || 900) / BAR_SPACING / 2,
          ),
          shiftVisibleRangeOnNewBar: true,
          lockVisibleTimeRangeOnResize: true,
        },
        crosshair: { mode: 0 },
        handleScroll: false,
        handleScale: false,
      });
      const series =
        mode === "candles"
          ? chart.addSeries(lwc.CandlestickSeries, {
              upColor: "#3fd08a",
              downColor: "#ff5c5c",
              borderVisible: false,
              wickUpColor: "#3fd08a",
              wickDownColor: "#ff5c5c",
              priceFormat: asCap ? capFormat : priceFormat,
            })
          : chart.addSeries(lwc.LineSeries, {
              color: "#f0b429",
              lineWidth: 2,
              priceFormat: asCap ? capFormat : priceFormat,
            });
      api.current = {
        chart: chart as never,
        series: series as never,
        markers: null,
        lwc,
        painted: -1,
      };
      setChartBuilt((n) => n + 1); // repaint into the new series
    })();
    return () => {
      dead = true;
      api.current?.chart.remove();
      api.current = null;
    };
  }, [mode, asCap, zoom]);

  /**
   * The wallet's trades, one marker per bar per side, labelled where there is room.
   *
   * Three things had to go right for this to be readable.
   *
   * TRANSFERS ARE NOT TRADES. Tokens arriving by transfer have no price, so
   * they were drawing as "BUY $0" — and there can be a great many of them:
   * one wallet on this token has 267 transfers against 73 real fills. They are
   * dropped; the chart marks what the wallet bought and sold.
   *
   * FILLS IN THE SAME BAR ARE SUMMED. A router can put a dozen fills inside
   * one bar, and a marker each stacked them into an unreadable pile.
   *
   * LABELS ARE ASSIGNED BY SIZE, NOT BY TIME. Bars are nine pixels apart and
   * "SELL $12.3K" is about seventy, so any two labels within eight bars of
   * each other overlap. Every marker keeps its dot; the TEXT goes to the
   * biggest trades first, and a smaller one inside the space an already
   * labelled trade needs stays a dot. Reading it left to right instead would
   * let a $20 fill claim the space and silently mute the $40,000 one beside it.
   */
  const marks = useMemo(() => {
    if (!data) return [];
    const iv = data.interval;

    /**
     * Grouped per wallet as well as per side once a cluster is being replayed:
     * seeing WHICH wallet bought is most of the point of replaying them
     * together, and summing them into one marker throws it away.
     */
    const grouped = new Map<
      string,
      { time: number; isBuy: boolean; usd: number; wallet?: string | null }
    >();
    for (const t of data.trades) {
      if (t.kind === "transfer" || !(t.usd > 0)) continue;
      const time = Math.floor(t.ts / iv) * iv;
      const who = alongside.length > 0 ? (t.wallet ?? "") : "";
      const key = `${time}:${t.isBuy}:${who}`;
      const at = grouped.get(key) ?? {
        time,
        isBuy: t.isBuy,
        usd: 0,
        wallet: t.wallet,
      };
      at.usd += t.usd;
      grouped.set(key, at);
    }

    const all = [...grouped.values()];
    const label = (g: { isBuy: boolean; usd: number; wallet?: string | null }) =>
      `${g.isBuy ? "BUY" : "SELL"} ${usdCompact(g.usd)}` +
      (alongside.length > 0 && g.wallet ? ` ${g.wallet.slice(0, 4)}` : "");

    /** Rough width of a marker label. The font is ~11px; this is close enough
     *  to keep neighbours apart without measuring text on a canvas. */
    const widthOf = (text: string) => text.length * 6.2 + 10;

    // Buys sit below the bar and sells above it, so the two sides are laid out
    // independently and only collide with their own kind.
    const placed: Record<"buy" | "sell", { bar: number; half: number }[]> = {
      buy: [],
      sell: [],
    };
    const labelled = new Set<string>();

    for (const g of [...all].sort((a, b) => b.usd - a.usd)) {
      const side = g.isBuy ? "buy" : "sell";
      const half = widthOf(label(g)) / 2;
      const bar = g.time / iv;
      const clear = placed[side].every(
        (other) => Math.abs(other.bar - bar) * BAR_SPACING >= other.half + half,
      );
      if (!clear) continue;
      placed[side].push({ bar, half });
      labelled.add(`${g.time}:${g.isBuy}:${g.wallet ?? ""}`);
    }

    // Ascending, because the library requires markers in time order.
    return all
      .sort((a, b) => a.time - b.time || Number(b.isBuy) - Number(a.isBuy))
      .map((g) => ({
        time: g.time,
        position: g.isBuy ? "belowBar" : "aboveBar",
        color: g.isBuy ? "#3fd08a" : "#ff5c5c",
        shape: "circle",
        text: labelled.has(`${g.time}:${g.isBuy}:${g.wallet ?? ""}`)
          ? label(g)
          : "",
      }));
  }, [data, alongside]);

  /**
   * A fill lands: wash the chart, float the number.
   *
   * Keyed off the bar index rather than the clock, so scrubbing to a bar
   * replays its fills and a paused chart stays still.
   *
   * A new fill pushes the previous one OUT rather than stacking on it. At
   * eight times speed a busy wallet lands fills faster than a label can finish
   * leaving, and they piled up on top of each other; now the outgoing label
   * fades and keeps drifting from wherever it had got to, which reads as being
   * displaced rather than as two labels fighting.
   */
  useEffect(() => {
    if (!effectsOn || !data) return;
    const bar = data.candles[at];
    if (!bar) return;

    const iv = data.interval;
    const inBar = data.trades.filter(
      (t) =>
        t.kind !== "transfer" &&
        t.usd > 0 &&
        Math.floor(t.ts / iv) * iv === bar.t,
    );
    if (inBar.length === 0) return;

    // Summed per side: a router can put a dozen fills in one bar, and twelve
    // labels climbing the screen together says less than two do.
    const bySide = new Map<string, { isBuy: boolean; usd: number; who?: string }>();
    for (const t of inBar) {
      const who = alongside.length > 0 ? (t.wallet ?? undefined) : undefined;
      const key = `${t.isBuy}:${who ?? ""}`;
      const at = bySide.get(key) ?? { isBuy: t.isBuy, usd: 0, who };
      at.usd += t.usd;
      bySide.set(key, at);
    }

    const born: Flash[] = [...bySide.values()].map((v, i) => ({
      id: (flashId += 1),
      isBuy: v.isBuy,
      usd: v.usd,
      cap: bar.c,
      slot: i,
      who: v.who,
      phase: "enter",
      bornAt: 0,
    }));

    /**
     * Spawned on the next frame rather than in the effect body.
     *
     * Adding to state synchronously here is a cascading render — the effect
     * runs as part of the commit that moved the bar, so it would immediately
     * schedule another. It also gives the `enter` phase a frame to be painted
     * from, which is what the transition eases out of.
     */
    let show = 0;
    const raf = requestAnimationFrame(() => {
      const bornAt = Date.now();
      setFlashes((held) => [
        // Whatever is on screen makes way.
        ...held.map((f) => ({ ...f, phase: "out" as const })),
        ...born.map((f) => ({ ...f, bornAt })),
      ]);
      show = requestAnimationFrame(() =>
        setFlashes((held) =>
          held.map((f) =>
            f.phase === "enter" ? { ...f, phase: "shown" as const } : f,
          ),
        ),
      );
    });

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(show);
    };
  }, [at, data, effectsOn, alongside]);

  /**
   * Labels retire themselves, on a clock of their own.
   *
   * This used to be a `setTimeout` inside the effect that spawned them, and
   * that effect's cleanup runs on every bar change — so the moment the replay
   * reached a bar with no fills, the pending timer was cancelled and the last
   * label sat there for good. Nothing was left to retire it, because the only
   * other thing that did was the NEXT fill arriving.
   *
   * Driven off each label's own birth time instead, so it leaves on schedule
   * whatever the chart is doing.
   */
  useEffect(() => {
    if (flashes.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setFlashes((held) => {
        let changed = false;
        const next = held.map((f) => {
          if (f.phase !== "shown" || now - f.bornAt < FLASH_MS) return f;
          changed = true;
          return { ...f, phase: "out" as const };
        });
        // Returning the same array when nothing expired keeps this from
        // re-rendering the chart every tick.
        return changed ? next : held;
      });
    }, 120);
    return () => clearInterval(timer);
  }, [flashes.length]);

  /**
   * Paint and play, in one loop.
   *
   * The bar being replayed is drawn FORMING rather than appearing: its close
   * walks from the open toward the real close across the step, with the high
   * and low revealed as it goes, exactly as a live candle behaves while trades
   * land in it. Appending finished bars on a timer made the chart tick like a
   * slideshow, which is the thing that read as unnatural.
   *
   * Driven by requestAnimationFrame off the wall clock, so the motion is smooth
   * at any speed and honest about dropped frames. React state only changes on a
   * bar boundary — a re-render per frame would cost more than it drew.
   *
   * Everything behind the current bar is finished history, so it is painted
   * once per structural change (a scrub, the loop wrapping, a mode switch)
   * rather than every frame.
   */
  useEffect(() => {
    const a = api.current;
    if (!a || !data || data.candles.length === 0) return;
    const total = data.candles.length;

    const finished = (c: (typeof data.candles)[number]) =>
      mode === "candles"
        ? { time: c.t, open: c.o, high: c.h, low: c.l, close: c.c }
        : { time: c.t, value: c.c };

    // Repaint the completed history only when it is not simply one step on.
    if (a.painted !== at - 1) {
      a.series.setData(data.candles.slice(0, at).map(finished));
      a.chart.timeScale().scrollToRealTime();
    }
    a.painted = at;

    const cutoff = data.candles[at]?.t ?? 0;
    const visible = marks.filter((m) => m.time <= cutoff);
    if (a.markers) a.markers.setMarkers(visible);
    else if (visible.length > 0) {
      a.markers = a.lwc.createSeriesMarkers(
        a.series as never,
        visible as never,
      ) as unknown as { setMarkers(m: unknown[]): void };
    }

    const bar = data.candles[at];
    if (!bar) return;
    const prev = data.candles[at - 1];
    const from = prev?.c ?? bar.o;

    if (!playing) {
      a.series.update(finished(bar));
      return;
    }

    const duration = STEP_MS / speed;
    const started = performance.now();
    let raf = 0;

    const frame = (now: number) => {
      const p = Math.min((now - started) / duration, 1);
      // Ease slightly: a linear walk looks mechanical at low speeds.
      const eased = p * p * (3 - 2 * p);
      const close = mode === "candles" ? bar.o + (bar.c - bar.o) * eased : from + (bar.c - from) * eased;
      a.series.update(
        mode === "candles"
          ? {
              time: bar.t,
              open: bar.o,
              // The extremes arrive with the move rather than being there from
              // the first frame, which is what a bar filling in looks like.
              high: Math.max(bar.o, close, bar.o + (bar.h - bar.o) * eased),
              low: Math.min(bar.o, close, bar.o + (bar.l - bar.o) * eased),
              close,
            }
          : { time: bar.t, value: close },
      );
      if (p >= 1) {
        const next = at + 1;
        if (next >= total) {
          /**
           * The loop is the "subsequent play" the toggle governs.
           *
           * Off means the replay STOPS ON ITS LAST BAR. Leaving `at` where it
           * is does that: the effect re-runs with `playing` false and paints
           * the finished bar. Winding back to zero first put the chart on the
           * opening frame before it stopped, which throws away the ending —
           * the part a recording is usually made for.
           */
          if (!autoPlay) {
            setPlaying(false);
            return;
          }
          setAt(0);
        } else {
          setAt(next);
        }
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [at, data, marks, mode, playing, speed, autoPlay, chartBuilt]);

  const now: ReplayPoint | undefined = data?.points[Math.min(at, (data?.points.length ?? 1) - 1)];
  const up = (now?.total ?? 0) >= 0;
  const total = data?.candles.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[1040px] rounded-md border border-line-strong bg-ink-900 p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Label>Wallet replay</Label>
            {label && (
              <div className="mt-1.5 font-mono text-[18px] font-bold text-tx">
                {label}
              </div>
            )}
            {/* The address stays on screen whether or not it has a name — a
                recording of a replay should say which wallet it is. */}
            {alongside.length > 0 && (
              <div className="mt-1 font-mono text-[10.5px] tracking-[0.1em] text-amber uppercase">
                replaying as one position with {alongside.length} linked wallet
                {alongside.length === 1 ? "" : "s"}
              </div>
            )}
            <div className="mt-1 flex items-center gap-2">
              <span
                title={wallet}
                className={cx(
                  "truncate font-mono select-all",
                  label ? "text-[11px] text-tx3" : "text-[15px] font-bold text-tx",
                )}
              >
                {wallet}
              </span>
              <Copy value={wallet} label="wallet address" />
            </div>
          </div>
          <div className="text-right">
            <div
              className={cx(
                "tnum font-mono text-[44px] leading-none font-bold",
                up ? "text-mint" : "text-signal",
              )}
            >
              {now ? `${up ? "+" : "−"}${usdCompact(Math.abs(now.total))}` : "—"}
            </div>
            <div className="mt-1.5 font-mono text-[10px] tracking-[0.12em] text-tx3 uppercase">
              total pnl
            </div>
          </div>
        </div>

        <div className="relative w-full">
          <div ref={holder} className="w-full" style={{ height: 340 }} />

          {!data && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-900">
              <div
                aria-hidden="true"
                className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-amber"
              />
              <div className="font-mono text-[11px] tracking-[0.12em] text-tx3 uppercase">
                reading this wallet&rsquo;s trades
              </div>
              <div className="font-mono text-[11px] text-tx3">
                and the token&rsquo;s price over the window it traded in
              </div>
            </div>
          )}

          {/* Purely decorative, and never in the way of the chart or a click. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {/* Only the arriving fill washes the chart. Leaving ones would
                stack their gradients and hold the screen bright. */}
            {flashes
              .filter((f) => f.phase !== "out")
              .map((f) => (
                <div
                  key={f.id}
                  className={cx(
                    "replay-wash absolute inset-0",
                    f.isBuy
                      ? "bg-[radial-gradient(ellipse_at_center,rgba(53,211,153,0.20),transparent_70%)]"
                      : "bg-[radial-gradient(ellipse_at_center,rgba(255,90,90,0.20),transparent_70%)]",
                  )}
                />
              ))}
            {flashes.map((f) => (
              <div
                key={`t${f.id}`}
                onTransitionEnd={(e) => {
                  if (e.propertyName !== "opacity" || f.phase !== "out") return;
                  setFlashes((held) => held.filter((x) => x.id !== f.id));
                }}
                style={{
                  left: "50%",
                  /* Top of the chart: the price action is usually in the lower
                     two thirds, and a label there covered the bars it was
                     describing. Enough headroom above it for the exit to
                     travel without clipping while it is still visible. */
                  top: 34 + f.slot * 42,
                  opacity: f.phase === "shown" ? 1 : 0,
                  transform:
                    f.phase === "enter"
                      ? "translate(-50%, 14px) scale(0.94)"
                      : f.phase === "shown"
                        ? "translate(-50%, 0) scale(1)"
                        : "translate(-50%, -30px) scale(1)",
                }}
                className={cx(
                  "replay-flash absolute font-mono text-[26px] leading-none font-black tracking-[-0.01em] whitespace-nowrap",
                  f.isBuy ? "text-mint" : "text-signal",
                )}
              >
                {usdCompact(f.usd)} {f.isBuy ? "BUY" : "SELL"}
                <span className="ml-2 text-[17px] font-bold text-tx2">
                  ({capLabel(f.cap)}
                  {asCap ? " MC" : ""})
                </span>
                {f.who && (
                  <span className="ml-2 text-[15px] font-bold text-tx3">
                    {f.who.slice(0, 4)}…{f.who.slice(-4)}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

        {data && total < 2 && (
          <p className="py-10 text-center font-mono text-[11px] tracking-[0.12em] text-tx3 uppercase">
            not enough history yet
          </p>
        )}

        {now && (
          <div className="mt-4 grid grid-cols-6 gap-4">
            {/* Bought and sold first: they are what the viewer is watching the
                wallet DO, and the PnL figures below are the consequence. Both
                are as of the current bar, not lifetime. */}
            <Figure label="Bought" value={now.boughtUsd} tone="mint" />
            <Figure label="Sold" value={now.soldUsd} tone="signal" />
            <Figure label="Realized" value={now.realized} signed />
            <Figure label="Unrealized" value={now.unrealized} signed />
            <Figure label="Holding" value={now.qty * now.price} />
            <Figure
              label="Trades"
              value={
                data
                  ? data.trades.filter(
                      (t) => t.ts <= (data.candles[at]?.t ?? 0) + data.interval,
                    ).length
                  : 0
              }
              plain
            />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setPlaying((p) => !p)}
            className="cursor-pointer rounded-xs border border-line-strong px-3 py-1.5 font-mono text-[10px] tracking-[0.12em] text-tx2 uppercase hover:text-tx"
          >
            {playing ? "pause" : "play"}
          </button>
          {!related && hasGraph !== false && (
            <button
              type="button"
              onClick={() => {
                setFindingRelated(true);
                void fetchRelated(mint, wallet)
                  .then((r) => {
                    // A 404 means nobody has worked this wallet out yet.
                    if (r?.error && !r.linked) setHasGraph(false);
                    else setRelated(r);
                  })
                  .finally(() => setFindingRelated(false));
              }}
              disabled={findingRelated}
              className="cursor-pointer rounded-xs border border-line-strong px-2.5 py-1.5 font-mono text-[10px] tracking-[0.1em] text-tx2 uppercase hover:text-tx disabled:opacity-40"
            >
              {findingRelated
                ? "looking…"
                : canCompute
                  ? "find linked wallets"
                  : "show linked wallets"}
            </button>
          )}
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={cx(
                "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] uppercase",
                speed === s
                  ? "border-amber/40 bg-amber/10 text-amber"
                  : "border-line-strong text-tx3 hover:text-tx2",
              )}
            >
              {s}x
            </button>
          ))}
          <div className="flex gap-1">
            {ZOOMS.map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => {
                  if (!raw) return;
                  /**
                   * Hold the moment, not the index. A wider bar means fewer of
                   * them, so keeping `at` would jump the replay backwards in
                   * time by however much the count shrank.
                   */
                  const now = data?.candles[at]?.t ?? 0;
                  const next = coarsen(raw, z);
                  const i = next
                    ? next.candles.findIndex((c) => c.t + next.interval > now)
                    : 0;
                  setZoom(z);
                  setAt(i < 0 ? Math.max((next?.candles.length ?? 1) - 1, 0) : i);
                }}
                disabled={!raw}
                title={`${barLabel((raw?.interval ?? 15) * z)} bars`}
                className={cx(
                  "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase disabled:opacity-40",
                  zoom === z
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {barLabel((raw?.interval ?? 15) * z)}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setAutoPlay(!autoPlay)}
            title="Start over at the end instead of holding on the last bar"
            className={cx(
              "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
              autoPlay
                ? "border-amber/40 bg-amber/10 text-amber"
                : "border-line-strong text-tx3 hover:text-tx2",
            )}
          >
            loop
          </button>
          <button
            type="button"
            onClick={() => {
              setEffectsOn(!effectsOn);
              if (effectsOn) setFlashes([]);
            }}
            title="Flash and float each fill as it lands"
            className={cx(
              "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
              effectsOn
                ? "border-amber/40 bg-amber/10 text-amber"
                : "border-line-strong text-tx3 hover:text-tx2",
            )}
          >
            fx
          </button>
          <div className="flex gap-1">
            {(["candles", "line"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cx(
                  "cursor-pointer rounded-xs border px-2 py-1.5 font-mono text-[10px] tracking-[0.1em] uppercase",
                  mode === m
                    ? "border-amber/40 bg-amber/10 text-amber"
                    : "border-line-strong text-tx3 hover:text-tx2",
                )}
              >
                {m}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={Math.max(total - 1, 0)}
            value={at}
            onChange={(e) => {
              setPlaying(false);
              setAt(Number(e.target.value));
            }}
            className="min-w-[140px] flex-1 accent-amber"
          />
          <span className="tnum font-mono text-[11px] text-tx3">
            {total ? at + 1 : 0}/{total} · {barLabel(data?.interval ?? 15)}
          </span>
        </div>

        {now && (related || findingRelated || hasGraph === false) && (
          <div className="mt-4 border-t border-line pt-4">
            {findingRelated && (
              <p className="mt-2 font-mono text-[11px] text-tx3">
                {canCompute
                  ? "Reading who this wallet moved tokens and SOL with, then reading each of them in full."
                  : "Loading."}
              </p>
            )}
            {hasGraph === false && (
              /**
               * The honest empty state. Linked wallets are worked out one
               * wallet at a time, so "none here" means nobody looked — not that
               * this wallet trades alone.
               */
              <p className="mt-2 font-mono text-[11px] text-tx3">
                Linked wallets have not been worked out for this one.
              </p>
            )}
            {related?.error && !related.linked && hasGraph !== false && (
              <p className="mt-2 font-mono text-[11px] text-signal">
                {related.error}
              </p>
            )}

            {related && !related.error && (
              <>
                <div className="flex flex-wrap items-baseline gap-2">
                  <Label>Linked wallets</Label>
                  <span
                    title={
                      "Wallets this one moved tokens or SOL with, judged material " +
                      "and not an exchange, a distributor or a temporary account. " +
                      "Tick one to replay both as a single position — transfers " +
                      "between them then cancel, the way they should. The link is " +
                      "inferred from funding and timing; it is not proof of common " +
                      "ownership."
                    }
                    className="cursor-help rounded-xs border border-line-strong px-1.5 py-0.5 font-mono text-[9px] tracking-[0.1em] text-tx3 uppercase"
                  >
                    what is this
                  </span>
                  <span className="font-mono text-[10.5px] text-tx3">
                    tick to fold into the replay
                  </span>
                </div>

                {related.linked.length === 0 && (
                  <p className="mt-2 font-mono text-[11px] text-tx3">
                    Nothing material — {related.dismissed.length} counterpart
                    {related.dismissed.length === 1 ? "y" : "ies"} looked at and
                    ruled out.
                  </p>
                )}

                {related.linked.map((r) => {
                  const on = folded.has(r.wallet);
                  return (
                    <label
                      key={r.wallet}
                      className="mt-2 flex cursor-pointer items-start gap-3 rounded-xs border border-line px-3 py-2 hover:bg-ink-800"
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() =>
                          setFolded((held) => {
                            const next = new Set(held);
                            if (on) next.delete(r.wallet);
                            else next.add(r.wallet);
                            return next;
                          })
                        }
                        className="mt-0.5 accent-amber"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-baseline gap-2">
                          {r.name && (
                            <span className="font-mono text-[12px] font-medium text-tx">
                              {r.name}
                            </span>
                          )}
                          <span className="truncate font-mono text-[10.5px] text-tx3 select-all">
                            {r.wallet}
                          </span>
                          <span className="tnum font-mono text-[10.5px] text-tx3">
                            {r.trades} trades
                          </span>
                        </span>
                        <span className="mt-0.5 block font-mono text-[10.5px] text-tx3">
                          {r.why.join(" · ")}
                        </span>
                      </span>
                      <span
                        className={cx(
                          "tnum shrink-0 font-mono text-[13px] font-bold",
                          r.total >= 0 ? "text-mint" : "text-signal",
                        )}
                      >
                        {r.total >= 0 ? "+" : "−"}
                        {usdCompact(Math.abs(r.total))}
                      </span>
                    </label>
                  );
                })}

                {folded.size > 0 && (
                  <p className="mt-3 rounded-xs border border-amber/30 bg-amber/5 px-3 py-2 font-mono text-[10.5px] tracking-[0.1em] text-amber uppercase">
                    {alongside.length === folded.size
                      ? `replaying as one position — the chart, the markers and the PnL above cover all ${folded.size + 1} wallets`
                      : "reloading the replay with these wallets…"}
                  </p>
                )}

              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  signed,
  plain,
  tone: forced,
}: {
  label: string;
  value: number;
  signed?: boolean;
  plain?: boolean;
  /** Fixed colour for figures whose sign carries no meaning. */
  tone?: "mint" | "signal";
}) {
  const tone = forced
    ? forced === "mint"
      ? "text-mint"
      : "text-signal"
    : signed
      ? value >= 0
        ? "text-mint"
        : "text-signal"
      : "text-tx";
  return (
    <div>
      <div className="font-mono text-[9.5px] tracking-[0.14em] text-tx3 uppercase">
        {label}
      </div>
      <div className={cx("tnum mt-1 font-mono text-[17px] font-bold", tone)}>
        {plain
          ? value
          : `${signed && value >= 0 ? "+" : signed ? "−" : ""}${usdCompact(Math.abs(value))}`}
      </div>
    </div>
  );
}
