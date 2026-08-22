import { NextResponse } from "next/server";
import { readOnly } from "@/server/config";
import { indexed, reconstruct, replayFrom } from "@/server/history";

/**
 * Rebuild a token from the chain, and optionally one wallet's trades on it.
 *
 * Runs the reconstruction in-process rather than proxying to a worker: this
 * app has no stream to keep alive, so the only thing a separate process would
 * add is a second thing to deploy. A rebuild is cached per mint, so asking
 * about a second wallet on the same token costs that wallet's history alone.
 */
export const dynamic = "force-dynamic";
/** A first reconstruction reads a few hundred windows; it needs the headroom. */
export const maxDuration = 300;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mint = searchParams.get("mint")?.trim() ?? "";
  const wallet = searchParams.get("wallet")?.trim() || undefined;
  const lead = Number(searchParams.get("lead") ?? 300);
  /**
   * Extra wallets replayed as ONE position with the subject. Capped, because
   * each one is a full history read and the caller is waiting.
   */
  const alongside = (searchParams.get("with") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w && isAddress(w))
    .slice(0, 8);

  if (!isAddress(mint)) {
    return NextResponse.json({ error: "a valid mint is required" }, { status: 400 });
  }
  if (wallet && !isAddress(wallet)) {
    return NextResponse.json({ error: "wallet is not an address" }, { status: 400 });
  }

  /**
   * Replaying is always allowed; INDEXING is not.
   *
   * A visitor who pastes an unknown mint gets told it is not on the site
   * rather than silently building it. Everything already indexed — including
   * any wallet on it — is served to everyone.
   */
  if (readOnly() && !(await indexed(mint))) {
    return NextResponse.json(
      { error: "that token is not on this site yet" },
      { status: 404 },
    );
  }

  try {
    const history = await reconstruct(mint, wallet, lead, alongside);
    if (!history) {
      return NextResponse.json(
        { error: "no trades found for this mint" },
        { status: 404 },
      );
    }
    if (!wallet) return NextResponse.json(history);

    // The wallet's own window replaces the token-wide one, so the replay opens
    // on its trades rather than on the token's whole life.
    const replay = replayFrom(mint, wallet, history.candles, lead, alongside);
    return NextResponse.json({
      ...history,
      wallet,
      candles: replay?.candles ?? history.candles,
      trades: replay?.trades ?? [],
      points: replay?.points ?? [],
    });
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}

/**
 * Base58, 32–44 characters.
 *
 * Checked before anything is fetched: these values are interpolated into
 * upstream RPC requests, and an address is the only thing that belongs there.
 */
function isAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}
