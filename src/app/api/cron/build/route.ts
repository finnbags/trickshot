import { NextResponse } from "next/server";
import {
  buildsDisabled,
  releaseBuildSlot,
  takeBuildSlot,
  withinDailyBudget,
} from "@/server/budget";
import { buildWindow } from "@/server/history";
import { claim, finish } from "@/server/queue";

/**
 * Builds whatever the queue is holding, once a minute.
 *
 * This is the only thing in the app that spends money with nobody watching, so
 * it is bounded four ways: the daily credit ceiling, the kill switch, one job
 * per tick, and the queue's own depth cap. Any of them can stop it without a
 * deploy.
 *
 * It runs the WHOLE-LIFE build — the owner-grade path a visitor may not
 * trigger — because that is the point. A wallet window is what gets refused;
 * indexing the token properly is what makes every later request for it cheap,
 * for every wallet, not just the one that asked.
 */
export const dynamic = "force-dynamic";
/**
 * Long, because a cold build of a busy token is minutes of work and being
 * killed part-way wastes everything it spent. Vercel allows up to 800 on Pro.
 */
export const maxDuration = 800;

/**
 * One per tick, deliberately.
 *
 * The cron fires every minute, so a queue of ten drains in ten. Draining
 * several at once would multiply the worst case — several cold builds sharing
 * one function's time and the account's rate limit — for no gain a shorter
 * interval does not already give.
 */
const PER_TICK = Number(process.env.QUEUE_PER_TICK ?? 1);

export async function GET(request: Request) {
  /**
   * Vercel signs its cron requests; nothing else may start a build here.
   *
   * Without `CRON_SECRET` set this endpoint refuses everyone, which is the
   * right default for a route whose only job is to spend money.
   */
  const secret = process.env.CRON_SECRET;
  const offered = request.headers.get("authorization");
  if (!secret || offered !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "not authorised" }, { status: 401 });
  }

  if (buildsDisabled()) {
    return NextResponse.json({ skipped: "builds are disabled" });
  }
  if (!(await withinDailyBudget())) {
    return NextResponse.json({ skipped: "daily credit ceiling reached" });
  }

  const built: { mint: string; ok: boolean; error?: string }[] = [];
  for (let i = 0; i < PER_TICK; i += 1) {
    const job = await claim();
    if (!job) break;

    /**
     * The worker competes for the same capacity as visitors do.
     *
     * Without this the cap is only half a cap: three visitor builds plus the
     * cron makes four, and the number that was supposed to bound the site
     * bounds only part of it. Putting the job back is the right failure — it
     * is still wanted, just not right now.
     */
    if (!(await takeBuildSlot())) {
      await finish(job.mint, { ok: false, error: "at capacity" });
      break;
    }

    try {
      /**
       * The rungs people asked for, NOT the token's own.
       *
       * A wallet's bar width comes from its own trading span; the whole-life
       * chart picks a width to suit the token. MEASURED on a 27-day token they
       * are 900s and 7,200s — different series, different keys. Building the
       * token's and calling the job done would leave every waiting click
       * refused for exactly the reason it was refused before, and the queue
       * would go round again at full price.
       */
      let bars = 0;
      for (const w of job.windows ?? []) {
        bars += await buildWindow(job.mint, w.interval, w.from, w.to);
      }

      /**
       * And that is ALL a queued job does.
       *
       * It deliberately does not run the whole-life rebuild or the trader
       * board. Both were here and both were wrong:
       *
       *   `reconstruct` marks the token `full`, which puts it in the gallery —
       *   a token nobody has vetted, whose chart covers one wallet's span.
       *
       *   `traderBoard` is ~19,500 credits and ~80 seconds to answer a
       *   question nobody asked. Somebody clicked a row to see THEIR trades.
       *
       * A queued build serves the click that caused it: this wallet, this
       * token, this window. The token stays `window` coverage, stays off the
       * home page, and its page shows the replay without pretending to a
       * leaderboard it has not earned. Promoting it to a full token page is
       * `npm run index -- <mint> --top 5`, which is a decision, not a
       * side effect.
       */
      const ok = bars > 0;
      await finish(job.mint, { ok, error: ok ? undefined : "no trades found" });
      built.push({ mint: job.mint, ok });
    } catch (error) {
      const message = (error as Error).message;
      await finish(job.mint, { ok: false, error: message });
      built.push({ mint: job.mint, ok: false, error: message });
    }
    await releaseBuildSlot();
    // Stop if this build used up what was left for the day.
    if (!(await withinDailyBudget())) break;
  }

  return NextResponse.json({ built });
}
