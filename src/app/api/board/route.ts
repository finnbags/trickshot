import { NextResponse } from "next/server";
import { readOnly } from "@/server/config";
import { indexed, traderBoard } from "@/server/history";

/**
 * Who made and lost the most on a token.
 *
 * Its own endpoint because it is slow for a reason that will not go away:
 * every wallet it ranks has its complete history on the mint read back, which
 * is the only way to put an honest number beside an address. MEASURED on a
 * 27-day token, the chart takes about six seconds and this takes eighty.
 *
 * Asking for both in one request meant a blank page for a minute and a half to
 * see a chart that had been ready the whole time. The page now draws the chart
 * as soon as it has it and calls this after.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mint = params.get("mint")?.trim() ?? "";
  // `update` reads every ranked wallet's transactions since the last build.
  // Without it the stored books are simply re-marked at the current price.
  // Re-reading every ranked wallet is the slow path, and the owner's to spend.
  const update = params.get("update") === "1" && !readOnly();
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return NextResponse.json({ error: "a valid mint is required" }, { status: 400 });
  }

  /**
   * A board for a token that is not on the site is a full build — a couple of
   * hundred wallets read in full — so it is gated the same way the chart is.
   * Without this a visitor could start one for any mint they liked simply by
   * asking for its board instead of its chart.
   */
  if (readOnly() && !(await indexed(mint))) {
    return NextResponse.json(
      { error: "that token is not on this site yet" },
      { status: 404 },
    );
  }

  try {
    const board = await traderBoard(mint, update);
    if (!board) {
      return NextResponse.json({ error: "no trades found for this mint" }, { status: 404 });
    }
    return NextResponse.json(board);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
