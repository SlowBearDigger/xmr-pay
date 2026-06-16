// signed payment receipt — a self-contained, verifiable record of a paid order.
//
// when an order settles, two facts are worth proving later, to anyone, with no
// third party in the middle:
//   1. the MERCHANT acknowledged the payment ("yes, order X is settled").
//   2. the CHAIN agrees it happened (those txs really paid that address).
//
// a receipt can carry both. the merchant signs the order facts with an Ed25519
// key (the same key family as the signed merchant config) — that signature is
// checkable offline in a millisecond against the merchant's published
// fingerprint. and if the buyer attached a Monero tx_proof, the receipt is ALSO
// verifiable against the chain itself (check_tx_proof on any node), so a holder
// never has to trust the merchant's signature at all: the same transaction that
// paid the order is what proves the order.
//
// no accounts, no receipt server, no "view in dashboard" link that rots. the
// receipt IS the artifact — it verifies standalone, forever, by anyone.

const crypto = require('crypto');
const { canonical, configFingerprint } = require('./config');
const { verifyPayment, xmrToPico, picoToXmrString, isValidTxid } = require('./verify');

// domain tag, embedded INSIDE the signed bytes. this is what keeps a config
// signature from ever being replayed as a receipt (and vice versa): the two
// envelopes commit to different `typ` values, so a verifier of one rejects the
// other even though both are Ed25519 over canonical JSON.
const RECEIPT_TYP = 'xmr-pay.receipt/1';

// build the canonical receipt body from a paid order (the object createOrder /
// check return). money is pinned in piconero (integer strings) so the signature
// commits to exact amounts, never a rounded float. pass `paidAt` explicitly
// (epoch ms or ISO string) so signing is deterministic and testable.
function receiptFromOrder(order, { merchant = {}, network, paidAt = null, txProofs = [] } = {}) {
    if (!order || order.id == null) throw new Error('order with an id is required');
    const amountPico = xmrToPico(order.amount);
    // a receipt commits to an EXACT piconero figure. the agent always records the
    // exact `receivedPico` (agent.js), so that branch is the norm. when it's absent
    // (a legacy/hand-built order) fall back to the exact `amountPico` — a paid order
    // received at least the amount — rather than re-deriving piconero from the FLOAT
    // `receivedXmr`, which can drift sub-piconero and sign a slightly-wrong value.
    const receivedPico = order.receivedPico != null
        ? BigInt(order.receivedPico)
        : amountPico;
    const txids = Array.isArray(order.txids) ? order.txids.filter(isValidTxid) : [];

    const body = {
        typ: RECEIPT_TYP,
        orderId: String(order.id),
        address: order.address,
        amountPico: amountPico.toString(),
        receivedPico: receivedPico.toString(),
        txids,
        confirmations: order.confirmations | 0,
        paidAt,
        merchant: { ...merchant },
    };
    if (order.birthdayHeight != null) body.birthdayHeight = order.birthdayHeight | 0;
    if (network) body.network = network;

    // the on-chain, trustless leg: a buyer tx_proof per payment lets anyone with
    // a node confirm the receipt against Monero itself, no merchant trust needed.
    const proofs = (txProofs || []).filter(p => p && isValidTxid(p.txid) && p.signature);
    if (proofs.length) {
        body.txProofs = proofs.map(p => ({
            txid: String(p.txid).trim().toLowerCase(),
            address: p.address || order.address,
            message: p.message || '',
            signature: p.signature,
        }));
    }
    return body;
}

// sign a receipt body with the merchant's Ed25519 private key (PEM). returns a
// self-contained envelope safe to hand to the buyer, email, or print in a QR.
function signReceipt(receipt, privateKeyPem) {
    if (!receipt || receipt.typ !== RECEIPT_TYP) throw new Error('not a receipt body (build it with receiptFromOrder)');
    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, Buffer.from(canonical(receipt)), key);
    const pubkey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' });
    return {
        v: 1,
        typ: RECEIPT_TYP,
        alg: 'ed25519',
        receipt,
        pubkey,
        fingerprint: configFingerprint(pubkey),
        sig: sig.toString('base64'),
    };
}

// verify the merchant signature on a receipt — OFFLINE, no network. pin a known
// signer with expectedFingerprint / expectedPubkey to bind it to identity;
// without a pin you only learn the receipt is internally consistent (tamper-
// evidence, not identity). returns { valid, reason, receipt, fingerprint }.
function verifyReceipt(envelope, { expectedFingerprint = null, expectedPubkey = null } = {}) {
    if (!envelope || typeof envelope !== 'object' || envelope.typ !== RECEIPT_TYP
        || !envelope.receipt || !envelope.sig || !envelope.pubkey) {
        return { valid: false, reason: 'not a signed receipt', receipt: null, fingerprint: null };
    }
    if (envelope.receipt.typ !== RECEIPT_TYP) {
        return { valid: false, reason: 'receipt body is not domain-tagged', receipt: null, fingerprint: null };
    }
    let pub, ok;
    try {
        pub = crypto.createPublicKey(envelope.pubkey);
        ok = crypto.verify(null, Buffer.from(canonical(envelope.receipt)), pub, Buffer.from(envelope.sig, 'base64'));
    } catch {
        return { valid: false, reason: 'bad key or signature encoding', receipt: null, fingerprint: null };
    }
    const fingerprint = configFingerprint(envelope.pubkey);
    if (!ok) return { valid: false, reason: 'signature does not match receipt', receipt: null, fingerprint };
    if (expectedPubkey) {
        const a = crypto.createPublicKey(expectedPubkey).export({ type: 'spki', format: 'der' });
        const b = pub.export({ type: 'spki', format: 'der' });
        if (!a.equals(b)) return { valid: false, reason: 'signed by a different key than pinned', receipt: null, fingerprint };
    }
    if (expectedFingerprint && expectedFingerprint.replace(/[^a-f0-9]/gi, '') !== fingerprint.replace(/-/g, '')) {
        return { valid: false, reason: 'fingerprint does not match the pinned one', receipt: null, fingerprint };
    }
    return { valid: true, reason: 'ok', receipt: envelope.receipt, fingerprint };
}

// verify a receipt against the CHAIN ITSELF — ONLINE, trustless, needs nodes.
// checks every buyer tx_proof in the receipt with Monero's native check_tx_proof
// on a real node, sums the cryptographically-confirmed piconero, and compares it
// to the receipt's amount. this leg trusts NO ONE — not even the merchant's
// signature — so a buyer can prove they were paid using only the transaction.
// returns { valid, reason, confirmedPico, needPico, perTx }.
async function verifyReceiptOnChain(envelope, { nodes, networkType, minConfirmations = 0, quorum = 1 } = {}) {
    const sig = verifyReceipt(envelope);
    if (!sig.valid) return { valid: false, reason: `receipt signature: ${sig.reason}`, confirmedPico: '0', needPico: '0', perTx: [] };
    const r = sig.receipt;
    const proofs = Array.isArray(r.txProofs) ? r.txProofs : [];
    if (!proofs.length) {
        return { valid: false, reason: 'receipt carries no tx_proofs — only the offline merchant signature can be checked', confirmedPico: '0', needPico: r.amountPico, perTx: [] };
    }
    if (!Array.isArray(nodes) || nodes.length === 0) {
        return { valid: false, reason: 'at least one node URI is required for on-chain verification', confirmedPico: '0', needPico: r.amountPico, perTx: [] };
    }
    const net = networkType || r.network || 'mainnet';
    const amountXmr = picoToXmrString(r.amountPico); // expected, passed per-proof so single full payments classify as 'paid'

    const perTx = [];
    let confirmed = 0n;
    for (const p of proofs) {
        const res = await verifyPayment({
            txid: p.txid, proof: p.signature, address: p.address || r.address,
            message: p.message || '', amount: amountXmr, nodes, networkType: net, minConfirmations, quorum,
        });
        // a top-up tx is 'underpaid' relative to the full amount but is still a
        // cryptographically valid payment — count those two, reject the rest.
        const counted = res.status === 'paid' || res.status === 'underpaid';
        const pico = counted && res.receivedPico != null ? BigInt(res.receivedPico) : 0n;
        if (counted) confirmed += pico;
        perTx.push({ txid: p.txid, status: res.status, ok: counted, receivedPico: pico.toString(), confirmations: res.confirmations | 0 });
    }

    const need = BigInt(r.amountPico);
    const allProofsValid = perTx.every(t => t.ok);
    const enough = confirmed >= need;
    const valid = allProofsValid && enough;
    const reason = valid ? 'ok'
        : !allProofsValid ? 'a tx_proof failed on-chain verification'
        : `chain-confirmed ${confirmed} pico is short of the receipt's ${need} pico`;
    return { valid, reason, confirmedPico: confirmed.toString(), needPico: need.toString(), perTx };
}

module.exports = { receiptFromOrder, signReceipt, verifyReceipt, verifyReceiptOnChain, RECEIPT_TYP };
