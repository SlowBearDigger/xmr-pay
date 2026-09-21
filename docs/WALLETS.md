# Wallet compatibility: how buyers prove a payment

The verify endpoint accepts either a **tx secret key** (64 hex) or a **tx
proof** (`OutProofV2…`/`InProofV2…`). Both come from the buyer's wallet. The
widget's proof box accepts a whole pasted block (Feather's formatted proof,
a copied details screen) and picks out the txid and proof by itself.

| Wallet | Where to find it | What you get |
|---|---|---|
| Feather | History → right-click the tx → **Create tx proof** → "Prove payment to an address" → Get formatted proof | formatted block with txid + address + OutProof: paste it whole |
| Monero GUI | History → open the tx → **P** (payment proof) | tx key / proof |
| monero-wallet-cli | `get_tx_key <txid>` or `get_tx_proof <txid> <address>` | tx key or OutProofV2 |
| Cake / Monero.com | transaction details → copy the **transaction key** | tx key |
| Monerujo | transaction details → tx key | tx key |
| Stack Wallet | transaction details | tx key |

Menu names vary by wallet version. The verifier accepts the formats above;
check your wallet's help if its transaction screen does not expose them.

## Things to warn buyers about

- **Tx keys only exist in the wallet that sent the payment.** A wallet
  restored from seed cannot produce keys or proofs for transactions sent
  before the restore. Buyers should prove soon after paying. (Merchants who
  want detection without buyer effort: use watch mode.)
- **Sender tx keys and receiver proofs differ.** A restored sender wallet may lack
  the original tx key. A view-only receiver can generate an incoming proof for a
  payment it can identify; it does not need a spend key for that operation.
- Some wallets only store tx keys if the "store tx info" setting is on
  (default on in CLI/GUI).
- A proof generated with a challenge message only verifies with that same
  message. The widget submits none, so plain proofs are the safe default.

## If a buyer can't prove

The payment is still on-chain. The merchant can confirm it manually with the
transaction ID and their own view-only wallet or PHP scanner. `check_tx_key`
requires the sender's transaction key; it cannot substitute a merchant view key.
