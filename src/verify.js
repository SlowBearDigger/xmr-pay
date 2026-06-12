// stateless Monero payment verification.
//
// the buyer hands the merchant (txid + proof). this module re-verifies that
// proof against Monero nodes the MERCHANT chooses — it never trusts the buyer,
// the merchant's word, or any third party. a lie cannot pass: the proof either
// checks out on-chain or it doesn't.
//
// accepted proof material (either, auto-detected):
//   - tx secret key   (64 hex — wallet: "show transaction key")
//   - tx proof        (OutProofV2.../InProofV2... — wallet: "prove payment")
//
// no state lives here. anti-replay belongs to the caller's own order storage:
// pass `alreadyUsed(txid)` and reuse is rejected. when each order carries a
// unique amount (amount-nonce, see xmr-pay/core) the proof additionally only
// fits its own order.
//
// design notes:
//   - all amounts compared in piconero (BigInt) — float never decides money.
//   - node quorum: set quorum >= 2 to require independent nodes to agree before
//     trusting a result. answers "why should I trust your node?" — you don't.
//   - monero-ts (WASM) is a peer dependency; verifier wallets are random keys,
//     hold nothing, and are cached per node for warm serverless invocations.

let monerojs = null;
function lazyMonero() {
    if (!monerojs) monerojs = require('monero-ts');
    return monerojs;
}

// loud-but-once guardrail for footguns. a payments lib should make a dangerous
// opt-out visible in the logs, not silent.
const _warned = new Set();
function warnOnce(msg) {
    if (_warned.has(msg)) return;
    _warned.add(msg);
    try { console.warn('[xmr-pay] ' + msg); } catch { /* no console */ }
}

const ADDR_FIRST_CHAR = {
    mainnet: '[48]',
    stagenet: '[57]',
    testnet: '[9AB]',
};

function isValidAddress(a, networkType) {
    const first = ADDR_FIRST_CHAR[networkType] || ADDR_FIRST_CHAR.mainnet;
    return typeof a === 'string' && new RegExp(`^${first}[1-9A-HJ-NP-Za-km-z]{94}$`).test(a);
}
function isValidTxid(t) {
    return typeof t === 'string' && /^[0-9a-f]{64}$/i.test(t);
}

// exact decimal → piconero. strings are taken verbatim so the 12th decimal
// never falls to float error (amount-nonce lives in those last digits). numbers
// are accepted too, but a small one (0.00000001) stringifies to "1e-8" which the
// validator would reject — so convert a number to a plain 12-decimal string
// first (this caps a number at piconero precision; pass a string for full nonce
// fidelity).
function xmrToPico(x) {
    const s = typeof x === 'number'
        ? (Number.isFinite(x) ? x.toFixed(12).replace(/\.?0+$/, '') : 'NaN')
        : String(x).trim();
    if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error(`invalid XMR amount: ${x}`);
    const [i, f = ''] = s.split('.');
    return BigInt(i) * 1000000000000n + BigInt(f.padEnd(12, '0'));
}
function picoToXmr(p) {
    return Number(p) / 1e12;
}

// one shared verifier wallet per (node, network) — random keys, no secrets.
// cached so a warm serverless instance pays the WASM open cost once. entries
// expire after WALLET_TTL_MS so a long-running server picks up node changes and
// never holds a wallet whose daemon connection went stale; checkOnNode also
// drops the entry on any operation error so the next call rebuilds it.
const walletCache = new Map();
const WALLET_TTL_MS = 5 * 60 * 1000;
function dropWallet(key) {
    const e = walletCache.get(key);
    if (e) { clearTimeout(e.timer); walletCache.delete(key); }
}
function verifierWallet(nodeUri, networkType) {
    const key = `${networkType}|${nodeUri}`;
    let entry = walletCache.get(key);
    if (!entry) {
        const promise = (async () => {
            const m = lazyMonero();
            const w = await m.createWalletFull({ networkType, password: '' });
            await w.setDaemonConnection(nodeUri);
            if (!(await w.isConnectedToDaemon())) throw new Error(`node unreachable: ${nodeUri}`);
            return w;
        })().catch(err => { dropWallet(key); throw err; });
        const timer = setTimeout(() => dropWallet(key), WALLET_TTL_MS);
        if (timer.unref) timer.unref();   // a pending eviction must not keep the process alive
        entry = { promise, timer };
        walletCache.set(key, entry);
    }
    return entry.promise;
}

function readCheck(c) {
    return {
        isGood: !!(c.getIsGood ? c.getIsGood() : c.isGood),
        inTxPool: !!(c.getInTxPool ? c.getInTxPool() : c.inTxPool),
        confirmations: Number((c.getNumConfirmations ? c.getNumConfirmations() : c.numConfirmations) ?? 0) || 0,
        receivedPico: BigInt(((c.getReceivedAmount ? c.getReceivedAmount() : c.receivedAmount) ?? 0).toString()),
    };
}

async function checkOnNode({ nodeUri, networkType, txid, proofKind, proof, address, message }) {
    const key = `${networkType}|${nodeUri}`;
    try {
        const w = await verifierWallet(nodeUri, networkType);
        const raw = proofKind === 'txkey'
            ? await w.checkTxKey(txid, proof, address)
            : await w.checkTxProof(txid, address, message, proof);
        return { nodeUri, ...readCheck(raw) };
    } catch (e) {
        // a cached wallet whose node dropped would fail every call forever —
        // evict so the next attempt rebuilds the connection. (a bad proof does
        // not throw here; checkTx* returns isGood:false, so this is RPC/network.)
        dropWallet(key);
        throw e;
    }
}

// reject time-locked payments: a custom wallet can craft a tx whose outputs are
// frozen via unlock_time — the proof verifies and confirmations accrue, but the
// merchant cannot spend the funds (possibly for years). fetch the raw tx from
// the daemon and require unlock_time === 0. fails CLOSED when no node returns
// the tx — set skipUnlockTimeCheck only if you accept that risk.
async function fetchUnlockTime(nodes, txid) {
    for (const uri of nodes) {
        try {
            const r = await fetch(String(uri).replace(/\/+$/, '') + '/get_transactions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ txs_hashes: [txid], decode_as_json: true }),
                signal: AbortSignal.timeout(10000),
            });
            if (!r.ok) continue;
            const j = await r.json();
            const tx = j && Array.isArray(j.txs) && j.txs[0];
            if (!tx || !tx.as_json) continue;
            const decoded = JSON.parse(tx.as_json);
            if (decoded.unlock_time === undefined || decoded.unlock_time === null) continue;
            return BigInt(String(decoded.unlock_time));
        } catch { /* try next node */ }
    }
    return null;
}

/**
 * verifyPayment — re-verify a buyer-supplied payment proof on-chain.
 *
 * @param {object} opts
 * @param {string}   opts.txid               transaction id (64 hex)
 * @param {string}   opts.proof              tx secret key (64 hex) or tx proof signature ((Out|In)ProofV*)
 * @param {string}   opts.address            the payment address for THIS order
 * @param {string|number} opts.amount        expected XMR (string keeps 12-decimal nonces exact)
 * @param {string[]} opts.nodes              node URIs the merchant trusts, in preference order
 * @param {string}   [opts.networkType]      'mainnet' (default) | 'stagenet' | 'testnet'
 * @param {number}   [opts.minConfirmations] default 1; 0 accepts mempool (merchant's own risk)
 * @param {number}   [opts.quorum]           default 1; >=2 requires that many nodes to agree
 * @param {string}   [opts.message]          challenge message the proof was generated over (default '')
 * @param {number}   [opts.toleranceXmr]     accepted shortfall, default 0 (exact — keeps amount-nonce meaningful)
 * @param {boolean}  [opts.skipUnlockTimeCheck] default false; skips the time-lock guard (NOT recommended)
 * @param {function} [opts.alreadyUsed]      async (txid) => boolean — caller's replay check
 *
 * @returns {Promise<{paid:boolean,status:string,reason:string,receivedXmr:number,confirmations:number,txid:string,nodesAgreed:number}>}
 *   status: paid | underpaid | unconfirmed | mempool | no-funds | locked | invalid | replay | node-disagreement
 *
 * REPLAY PROTECTION IS THE CALLER'S JOB, AND IT MUST BE ATOMIC. this function
 * proves a payment is real; it cannot know your order state. back `alreadyUsed`
 * with a UNIQUE constraint on the stored txid (or a synchronous check-and-claim)
 * — a plain async read has a TOCTOU window where two concurrent requests with
 * the same txid both pass and both orders settle. the returned `txid` is
 * normalized to lowercase; store and compare that form.
 */
async function verifyPayment(opts) {
    const {
        txid, proof, address, amount, nodes,
        networkType = 'mainnet',
        minConfirmations = 1,
        quorum = 1,
        message = '',
        toleranceXmr = 0,
        skipUnlockTimeCheck = false,
        alreadyUsed = null,
    } = opts || {};

    if (skipUnlockTimeCheck) warnOnce('skipUnlockTimeCheck is on — time-locked (unspendable) payments will be accepted as paid. leave it off unless you know exactly why.');

    // normalize the txid: trim + lowercase. monerod treats it case-insensitively,
    // but the caller's replay store does not — without this the same tx in a
    // different case slips past an alreadyUsed(txid) check and pays twice.
    const id = String(txid == null ? '' : txid).trim().toLowerCase();

    const fail = (status, reason, extra = {}) => ({
        paid: false, status, reason,
        receivedXmr: 0, confirmations: 0, txid: id || null, nodesAgreed: 0,
        ...extra,
    });

    // cheap input gates — reject garbage before any node RPC
    if (!isValidTxid(id)) return fail('invalid', 'txid must be 64 hex chars');
    if (!isValidAddress(address, networkType)) return fail('invalid', `address is not a valid ${networkType} address`);
    if (!Array.isArray(nodes) || nodes.length === 0) return fail('invalid', 'at least one node URI required');
    let expectedPico;
    try { expectedPico = xmrToPico(amount); } catch (e) { return fail('invalid', e.message); }
    if (expectedPico <= 0n) return fail('invalid', 'amount must be greater than 0');

    let proofKind = null;
    if (typeof proof === 'string' && /^[0-9a-f]{64}$/i.test(proof.trim())) proofKind = 'txkey';
    else if (typeof proof === 'string' && /^(Out|In)Proof[A-Za-z0-9]/.test(proof.trim())) proofKind = 'txproof';
    else return fail('invalid', 'proof must be a tx secret key (64 hex) or a tx proof signature (OutProofV*/InProofV*)');

    // quorum 1: try nodes in order, first success wins (resilient, no cross-
    // check). quorum >= 2: query want+1 in parallel and require that EVERY node
    // that answered agrees — a single disagreeing node trips it, which is the
    // whole point of asking more than one.
    const want = Math.max(1, quorum | 0);
    if (nodes.length < want) {
        return fail('invalid', `quorum ${want} needs at least ${want} nodes, but ${nodes.length} provided`);
    }
    let answers = [], errors = [];
    if (want === 1) {
        for (const nodeUri of nodes) {
            try { answers.push(await checkOnNode({ nodeUri, networkType, txid: id, proofKind, proof: proof.trim(), address, message })); break; }
            catch (e) { errors.push(e && e.message ? e.message : String(e)); }
        }
    } else {
        const targets = nodes.slice(0, Math.min(nodes.length, want + 1));
        const settled = await Promise.allSettled(targets.map(nodeUri =>
            checkOnNode({ nodeUri, networkType, txid: id, proofKind, proof: proof.trim(), address, message })));
        answers = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
        errors = settled.filter(s => s.status === 'rejected').map(s => s.reason && s.reason.message ? s.reason.message : String(s.reason));
    }
    if (answers.length < want) {
        return fail('invalid', `only ${answers.length}/${want} nodes answered (${errors.join('; ') || 'no errors'})`);
    }

    const head = answers[0];
    const agreed = answers.every(a => a.isGood === head.isGood && a.receivedPico === head.receivedPico);
    if (!agreed) {
        return fail('node-disagreement',
            'nodes returned different results — verify against different nodes',
            { detail: answers.map(a => ({ node: a.nodeUri, isGood: a.isGood, receivedXmr: picoToXmr(a.receivedPico) })) });
    }

    const confirmations = Math.min(...answers.map(a => a.confirmations));
    const receivedXmr = picoToXmr(head.receivedPico);
    const base = { receivedXmr, confirmations, txid: id, nodesAgreed: answers.length };

    if (!head.isGood) return { paid: false, status: 'invalid', reason: 'proof does not verify for this txid/address', ...base };
    if (head.receivedPico <= 0n) return { paid: false, status: 'no-funds', reason: 'this transaction sent nothing to this address', ...base };

    const tolerancePico = toleranceXmr ? xmrToPico(toleranceXmr) : 0n;
    if (head.receivedPico < expectedPico - tolerancePico) {
        return { paid: false, status: 'underpaid', reason: `received ${receivedXmr} XMR, expected ${amount}`, ...base };
    }

    if (confirmations < minConfirmations) {
        const status = head.inTxPool ? 'mempool' : 'unconfirmed';
        return { paid: false, status, reason: `${confirmations}/${minConfirmations} confirmations`, ...base };
    }

    // time-lock gate: amount and confirmations can both look right while the
    // outputs are frozen by unlock_time — that is not money the merchant can
    // spend, so it does not count as paid.
    if (!skipUnlockTimeCheck) {
        const unlockTime = await fetchUnlockTime(nodes, id);
        if (unlockTime === null) {
            return { paid: false, status: 'invalid', reason: 'could not verify unlock_time — every node failed to return the tx; not marking paid (add nodes or retry)', ...base };
        }
        if (unlockTime !== 0n) {
            return { paid: false, status: 'locked', reason: `outputs are time-locked (unlock_time=${unlockTime}) — not spendable, not accepted`, ...base };
        }
    }

    // replay gate last — only a cryptographically valid, sufficient payment
    // reaches here. the caller's own order storage is the source of truth.
    if (alreadyUsed && await alreadyUsed(id)) {
        return { paid: false, status: 'replay', reason: 'this txid was already used to pay another order', ...base };
    }

    // overpaid still counts as paid, but the merchant gets told so they can
    // decide whether to refund the difference.
    const overpaid = head.receivedPico > expectedPico;
    return {
        paid: true, status: 'paid', reason: 'verified on-chain',
        overpaid, overpaidXmr: overpaid ? picoToXmr(head.receivedPico - expectedPico) : 0,
        ...base,
    };
}

module.exports = { verifyPayment, fetchUnlockTime, xmrToPico, picoToXmr, isValidAddress, isValidTxid };
