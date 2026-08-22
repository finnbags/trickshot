import { NextResponse } from "next/server";
import { readOnly } from "@/server/config";
import { relatedWallets } from "@/server/history";

/**
 * The other wallets a wallet appears to be operating with, on one token.
 *
 * Its own endpoint because it is optional and slow-ish: it reads a slice of
 * the subject's non-token history to find funding legs, then reads every
 * candidate it keeps. A replay never waits for this.
 *
 * The links are INFERENCE. Each one carries the evidence that produced it so
 * a reader can judge it, and nothing here is folded into anyone's PnL.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mint = params.get("mint")?.trim() ?? "";
  const wallet = params.get("wallet")?.trim() ?? "";

  if (!ADDRESS.test(mint) || !ADDRESS.test(wallet)) {
    return NextResponse.json(
      { error: "a valid mint and wallet are required" },
      { status: 400 },
    );
  }

  try {
    /**
     * Linked wallets are chosen, not discovered on demand: the owner opens a
     * wallet and computes its graph, and every visitor then sees it. Asking
     * for one that was never computed says so rather than building it.
     */
    const report = await relatedWallets(mint, wallet, !readOnly());
    if (report === "not computed") {
      return NextResponse.json(
        { error: "linked wallets have not been worked out for this wallet" },
        { status: 404 },
      );
    }
    if (!report) {
      return NextResponse.json(
        { error: "this wallet has no history on this mint" },
        { status: 404 },
      );
    }
    return NextResponse.json(report);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
