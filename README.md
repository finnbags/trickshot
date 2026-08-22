# Trickshot

Rebuild any Solana token from the chain and replay what a wallet did on it — as
a chart you can record and post.

Give it a mint. It reconstructs the price history as candles, ranks who made and
lost the most, and for any wallet plays its buys and sells back on the bars with
its PnL stepping alongside. Nothing is indexed ahead of time.

Live: **[trickshot-memes.vercel.app](https://trickshot-memes.vercel.app)**

## Run it

    cp .env.example .env.local     # add HELIUS_API_KEY
    npm install
    npm run dev

One key is all it needs, on a paid Helius plan — `getTransactionsForAddress`
and the wallet-identity endpoint are not on the free tier. Everything else is
optional.

Paste a mint and press build. A busy token takes about ten seconds the first
time; results are cached in `.trickshot-cache/`, so it is quick after that.

There is a command-line path too, which is also how tokens get added to a
hosted copy:

    npm run index -- <mint>                    chart and trader board
    npm run index -- <mint> --top 5            …and linked wallets for the top 5
    npm run index -- <mint> --wallets <a>,<b>  …for specific wallets
    npm run index -- <mint> --include <a>      pin a wallet onto the board
    npm run index -- <mint> --update           re-read the board

Set `SUPABASE_URL` and `SUPABASE_KEY` and the cache moves to Supabase instead
of the local directory, which is what a deployment reads from. See
`.env.example` for the rest of the settings.

## How it uses Helius

Four things, one key.

**`getTransactionsForAddress`** does the heavy lifting. Two details make the
project possible at all:

- `filters.blockTime` reaches a window days old directly instead of paging back
  to it, so a month-old token costs a few hundred calls rather than millions.
- `filters.tokenTransfer.mint` returns only the transactions that actually
  traded the token. Ask a busy pool for a five-minute window and you get 11,085
  transactions; ask with this filter and you get the 310 that were swaps — every
  one of them, and nothing else.

Point it at the **pool**, not the mint. A mint's transactions are mostly bots
referencing it without trading; a pool's are trades. Everything else depends on
that.

**Standard RPC** — `getTokenLargestAccounts`, `getMultipleAccounts`,
`getTokenSupply` — finds the pools and the holders.

**DAS** (`getAsset`, `getTokenAccounts`) gives token names, artwork, and the full
holder list. Use the `cdn_uri` it returns for images: token art is hosted
wherever its creator put it and plenty of those hosts refuse to serve it to
anyone else.

**Wallet Identity** (`/v1/wallet/batch-identity`) puts names to addresses where
it knows them — exchanges, protocols, a few thousand known traders.

Prices come from **balances**, never from decoding instructions. A swap is two
balances moving in opposite directions inside one pool and the transaction
states both, so it works for venues no decoder knows — and a wallet's own token
delta cannot double-count a swap routed through three pools.

The only thing not from Helius is **SOL/USD by the minute**, from Binance's
public price mirror. A USD figure needs the SOL price at the time of the trade,
and Helius has no price history.

## What it does not do

Worth knowing before trusting a number.

- **The chart is one book.** A token trades on many pools at slightly different
  prices, so candles come from the busiest. A wallet's PnL counts every venue,
  because that path reads the wallet rather than a pool.
- **Long spans are sampled.** Past a few thousand swaps a bar is priced from
  trades spread across it. The prices are real trades; the volume is an estimate.
  The page says which a chart is.
- **The trader board is a shortlist.** Every figure shown is exact — each wallet
  is read in full — but a wallet that was never nominated is absent.
- **Fills are priced at the bar's mark**, not the exact execution price. The
  payer is often not the holder, so there is no reliable SOL leg on the wallet.
- **Transferred tokens have no cost basis.** They count toward a position and not
  toward profit.
- **A linked wallet is inference**, from funding and timing. Not proof of common
  ownership, and nothing is combined unless you ask.

## Layout

    src/app/api/          history · board · tokens · related
    src/server/pool       which book to read, and its vaults
    src/server/candles    windows to bars, priced from balances
    src/server/positions  PnL, and the replay curve
    src/server/graph      a wallet's counterparties
    src/server/store      anything built, kept between requests
    src/components        the chart, the replay, the boards

The reasoning behind each decision — and the measurements that forced it — is in
the comments, next to the code it explains.
