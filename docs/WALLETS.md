# Wallet compatibility — how buyers prove a payment

The verify endpoint accepts either a **tx secret key** (64 hex) or a **tx
proof** (`OutProofV2…`/`InProofV2…`). Both come from the buyer's wallet. The
widget's proof box accepts a whole pasted block (Feather's formatted proof,
a copied details screen) and picks out the txid and proof by itself.

| Wallet | Where to find it | What you get |
|---|---|---|
| Feather | History → right-click the tx → **Create tx proof** → "Prove payment to an address" → Get formatted proof | formatted block with txid + address + OutProof — paste it whole |
| Monero GUI | History → open the tx → **P** (payment proof) | tx key / proof |
| monero-wallet-cli | `get_tx_key <txid>` or `get_tx_proof <txid> <address>` | tx key or OutProofV2 |
| Cake / Monero.com | transaction details → copy the **transaction key** | tx key |
| Monerujo | transaction details → tx key | tx key |
| Stack Wallet | transaction details | tx key |

Generation paths verified against the wallets' own docs; Feather, GUI and CLI
are first-hand documented, Cake via its official guides. All of these wallets
build on the same `wallet2` core, which is also what verifies on our side
(via monero-ts), so a proof one of them generates is a proof we can check —
the tx-proof and tx-key verification paths are live-validated on stagenet.

## Things to warn buyers about

- **Tx keys only exist in the wallet that sent the payment.** A wallet
  restored from seed cannot produce keys or proofs for transactions sent
  before the restore. Buyers should prove soon after paying. (Merchants who
  want detection without buyer effort: use watch mode.)
- **View-only wallets can't generate proofs** — no spend key, no tx key.
- Some wallets only store tx keys if the "store tx info" setting is on
  (default on in CLI/GUI).
- A proof generated with a challenge message only verifies with that same
  message. The widget submits none, so plain proofs are the safe default.

## If a buyer can't prove

The payment is still on-chain. The merchant can confirm it manually with the
txid + their own view key (any wallet, or `check_tx_key` against their own
node), or run watch mode and skip buyer proofs entirely.
