/**
 * Everything this app needs from the environment, which is one key.
 *
 * The replay reads the chain and nothing else — no stream, no database, no
 * notifications — so the whole configuration is the Helius endpoint it reads
 * from. The key is read lazily rather than at module load so that importing
 * this from a route that never calls it cannot break the build.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * Whether this instance refuses to build anything it has not already got.
 *
 * A hosted copy serves a curated set: the owner indexes from their own machine
 * and the site reads the result. There is no administrator login to go with
 * this, and deliberately so — the hosted copy is handed a Supabase key that
 * cannot write, so it could not persist a build even if it made one. A login
 * would be a second lock on a door that does not open.
 */
export function readOnly(): boolean {
  return process.env.TRICKSHOT_READONLY === "1";
}

export const config = {
  /** The raw key, for the REST endpoints that are not JSON-RPC. */
  get apiKey(): string {
    return required("HELIUS_API_KEY");
  },
  get rpcUrl(): string {
    const base = process.env.HELIUS_RPC_URL ?? "https://mainnet.helius-rpc.com";
    return `${base}/?api-key=${required("HELIUS_API_KEY")}`;
  },
  commitment: (process.env.COMMITMENT ?? "confirmed") as
    | "processed"
    | "confirmed"
    | "finalized",
};
