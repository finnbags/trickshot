import { config } from "./config";

/**
 * Names for addresses, where Helius knows one.
 *
 * A board of base58 is a board nobody reads. The Wallet Identity API turns a
 * useful fraction of it into people — MEASURED on this token's board, of 22
 * addresses looked up in 1.7 seconds:
 *
 *      HDixbrzw   +$4.7M    "latentfish83215" on Pump.fun
 *      2M2vLX34   +$1.6M    "SossaDotKek" on Pump.fun
 *      498g1rVn   +$487k    Frank Degods
 *      8deJ9xeU    -$27k    Cooker @CookerFlips
 *
 * Most addresses come back unknown, which is expected and fine: an unnamed
 * wallet keeps its address. Nothing here is load-bearing — a failed lookup
 * costs a label, never a number — so every error resolves to "no name".
 *
 * The Wallet API is in beta and needs a paid plan; a free key answers 403.
 */

/** The documented ceiling for one batch-identity request. */
const BATCH = 100;

export interface Identity {
  /** A human name: an exchange, a protocol, a person. */
  name?: string;
  /** "Centralized Exchange", "Individual", "Key Opinion Leader". */
  category?: string;
  /** "exchange", "wallet", "program", "unknown". */
  type?: string;
}

interface IdentityRow {
  address?: string | null;
  name?: string;
  category?: string;
  type?: string;
}

/**
 * Look up many addresses at once.
 *
 * Only addresses with an actual NAME come back in the map. The API also
 * returns tags — "Pump.fun User", "Jup.ag User" — for a much larger share, and
 * those are deliberately dropped: they describe what a wallet has used, not
 * who it is, and on a pump.fun token every row would read "Pump.fun User".
 */
export async function identify(
  addresses: string[],
): Promise<Map<string, Identity>> {
  const found = new Map<string, Identity>();
  const unique = [...new Set(addresses)].filter(Boolean);
  if (unique.length === 0) return found;

  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    batches.push(unique.slice(i, i + BATCH));
  }

  const pages = await Promise.all(
    batches.map(async (batch) => {
      try {
        const res = await fetch(
          `https://api.helius.xyz/v1/wallet/batch-identity?api-key=${config.apiKey}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            signal: AbortSignal.timeout(15_000),
            body: JSON.stringify({ addresses: batch }),
          },
        );
        if (!res.ok) return [];
        const body: unknown = await res.json();
        return Array.isArray(body) ? (body as IdentityRow[]) : [];
      } catch {
        return [];
      }
    }),
  );

  for (const rows of pages) {
    for (const row of rows) {
      if (!row?.address || !row.name) continue;
      found.set(row.address, {
        name: row.name,
        category: row.category,
        type: row.type,
      });
    }
  }
  return found;
}

export interface TokenIdentity {
  name?: string;
  symbol?: string;
  image?: string;
}

/**
 * What a token is called, from DAS.
 *
 * The identity endpoint answers "unknown" for a mint — it names wallets and
 * programs, not tokens — so the name comes from the asset's own metadata.
 * MEASURED: `Ai66LHZG…` is Catecoin (CATE), which is a great deal more use in
 * a list than `Ai66LHZG…` is.
 */
export async function tokenIdentity(mint: string): Promise<TokenIdentity> {
  try {
    const res = await fetch(config.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "identity",
        method: "getAsset",
        params: { id: mint },
      }),
    });
    if (!res.ok) return {};
    const body = (await res.json()) as {
      result?: {
        content?: {
          metadata?: { name?: string; symbol?: string };
          links?: { image?: string };
          files?: { uri?: string; cdn_uri?: string; mime?: string }[];
        };
      };
    };
    const content = body.result?.content;
    /**
     * The CDN copy first, the original only as a fallback.
     *
     * Token art is hosted wherever its creator put it, and plenty of those
     * hosts refuse to serve it to anyone else. MEASURED on this token: its
     * image returns 403 when a browser asks with a Referer header and 200
     * without, which is hotlink protection — so it loaded from curl and not
     * from the page. Helius mirrors the same file and serves it to anyone.
     */
    const file = content?.files?.find((f) => f.cdn_uri || f.uri);
    return {
      name: content?.metadata?.name,
      symbol: content?.metadata?.symbol,
      image: file?.cdn_uri ?? content?.links?.image ?? file?.uri,
    };
  } catch {
    return {};
  }
}
