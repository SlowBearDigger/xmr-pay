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

// piconero BigInt → EXACT canonical XMR decimal string (trailing zeros trimmed).
// unlike picoToXmr (a float, fine for display) this never loses a piconero — use
// it for any amount that must be exact, e.g. a top-up shortfall or a nonce.
function picoToXmrString(pico) {
    // handle the sign separately — padStart on "-1" would wedge the minus INSIDE
    // the digits ("00000000000-1") and produce a garbage amount string.
    const neg = pico < 0n;
    const s = (neg ? -pico : pico).toString().padStart(13, '0');
    const i = s.slice(0, -12);
    let f = s.slice(-12);
    let fend = f.length; while (fend > 0 && f.charCodeAt(fend - 1) === 48) fend--;  // trim trailing zeros, no regex (ReDoS-free)
    f = f.slice(0, fend);
    return (neg ? '-' : '') + (f ? `${i}.${f}` : i);
}

// parse an atomic-unit amount (piconero) coming from wallet-rpc or a daemon into
// a BigInt. these arrive as JSON numbers (integers); a non-integer or otherwise
// unparseable value is malformed input from an untrusted or buggy node — throw a
// descriptive error so the caller can fail CLOSED (reject) instead of leaking a
// raw BigInt exception. a negative integer is allowed through (it resolves to
// no-funds downstream); garbage is not. (a JS number above 2^53 has already lost
// precision before we see it — the documented whale caveat, unchanged.)
function atomicToPico(v) {
    if (v === undefined || v === null) return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
        if (!Number.isInteger(v)) throw new Error(`non-integer atomic amount: ${v}`);
        // a JS number past 2^53 has ALREADY lost integer precision in transit
        // (JSON), so BigInt(v) would mint a confidently-wrong amount. fail CLOSED:
        // large atomic amounts must arrive as a string or BigInt (monero-ts hands
        // us BigInt; a wallet-rpc client should read amounts as strings).
        if (!Number.isSafeInteger(v)) throw new Error(`atomic amount ${v} exceeds JS safe-integer precision — pass it as a string or BigInt`);
        return BigInt(v);
    }
    const s = String(v).trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`non-integer atomic amount: ${v}`);
    return BigInt(s);
}

// classify the proof material: a 64-hex tx secret key, or an (Out|In)Proof
// signature. returns 'txkey' | 'txproof' | null. shared by both verify
// transports so they accept exactly the same inputs.
function detectProofKind(proof) {
    if (typeof proof !== 'string') return null;
    const p = proof.trim();
    if (/^[0-9a-f]{64}$/i.test(p)) return 'txkey';
    if (/^(Out|In)Proof[A-Za-z0-9]/.test(p)) return 'txproof';
    return null;
}

// pure decision: map a verified proof/transfer result to a payment status.
// does NOT gate unlock_time or replay — those are separate, stateful concerns.
// shared by verifyPayment (monero-ts) and verifyPaymentViaRpc (wallet-rpc) so
// the two transports can never drift on what counts as paid (the bug we found
// in a downstream re-implementation: float amounts + a missing gate). amounts
// in piconero (BigInt) — float never decides money.
//   status: ok | invalid | no-funds | underpaid | mempool | unconfirmed
function classifyResult({ isGood, receivedPico, confirmations, inTxPool }, { expectedPico, tolerancePico = 0n, minConfirmations = 1 }) {
    if (!isGood) return { status: 'invalid', reason: 'proof does not verify for this txid/address' };
    if (receivedPico <= 0n) return { status: 'no-funds', reason: 'this transaction sent nothing to this address' };
    if (receivedPico < expectedPico - tolerancePico) {
        // shortfall to reach the full expected amount, computed in piconero so the
        // "send X more" the buyer is told is EXACT (float subtraction would drift).
        return {
            status: 'underpaid',
            reason: `received ${picoToXmr(receivedPico)} XMR, expected ${picoToXmr(expectedPico)}`,
            shortfallXmr: picoToXmrString(expectedPico - receivedPico),
        };
    }
    if (confirmations < minConfirmations) {
        return { status: inTxPool ? 'mempool' : 'unconfirmed', reason: `${confirmations}/${minConfirmations} confirmations` };
    }
    const overpaid = receivedPico > expectedPico;
    // EXACT piconero string (not picoToXmr's float) — this is a refund amount the
    // merchant may pay back; the 12th decimal must not drift. matches watch.js.
    return { status: 'ok', overpaid, overpaidXmr: overpaid ? picoToXmrString(receivedPico - expectedPico) : '0' };
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

// classify a thrown verifier error. a SEMANTICALLY wrong proof (right shape,
// wrong payment) returns isGood:false and never reaches here — but a MALFORMED
// proof makes monero-ts throw a data error ("Wrong signature size", bad key,
// parse failure): that is terminal, the proof is bad and retrying won't help. a
// connection/daemon error is TRANSIENT — the node is unreachable, a retry may
// work. default to transient: safer to tell a buyer "retry" on a flaky node than
// to reject a real payment as invalid.
const _DATA_ERR = /signature|invalid proof|secret key|tx key|parse|malformed|deserial/i;
function isTransientError(e) {
    const m = (e && e.message) ? e.message : String(e);
    return !_DATA_ERR.test(m);
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
        // classify before deciding whether to evict: a malformed proof makes
        // monero-ts throw ("Wrong signature size") — that is NOT a node problem,
        // so evicting would only force a pointless WASM cold-start on the next
        // request. only evict on transient node/network failures.
        if (e && e.transient === undefined) {
            try { e.transient = isTransientError(e); } catch { /* frozen error object */ }
        }
        if (e.transient !== false) dropWallet(key);
        throw e;
    }
}

// reject time-locked payments: a custom wallet can craft a tx whose outputs are
// frozen via unlock_time — the proof verifies and confirmations accrue, but the
// merchant cannot spend the funds (possibly for years). read the raw tx from the
// daemon and require unlock_time === 0.
//
// read ONE node's unlock_time for a txid; null if it could not be read. the
// tx_hash in the daemon response is cross-checked against the requested txid, so
// a node cannot answer with a different (unlocked) tx's blob.
// trim trailing slashes without a regex (avoids the /\/+$/ polynomial-ReDoS pattern on node URLs)
const rtrimSlash = u => { u = String(u); let e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; return u.slice(0, e); };

async function unlockTimeFromNode(uri, txid) {
    try {
        const r = await fetch(rtrimSlash(uri) + '/get_transactions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ txs_hashes: [txid], decode_as_json: true }),
            signal: AbortSignal.timeout(10000),
        });
        if (!r.ok) return null;
        const j = await r.json();
        const tx = j && Array.isArray(j.txs) && j.txs[0];
        if (!tx || !tx.as_json) return null;
        // require the daemon to echo a MATCHING tx_hash — a response that omits it
        // (or returns a different tx's blob) cannot be trusted for the time-lock
        // gate, so fail closed rather than read someone else's unlock_time.
        if (!tx.tx_hash || String(tx.tx_hash).toLowerCase() !== txid) return null;
        const decoded = JSON.parse(tx.as_json);
        if (decoded.unlock_time === undefined || decoded.unlock_time === null) return null;
        return BigInt(String(decoded.unlock_time));
    } catch { return null; }
}

// read the chain tip from ONE node (plain /get_height). null if unreadable.
async function daemonHeightFromNode(uri) {
    try {
        const r = await fetch(rtrimSlash(uri) + '/get_height', { method: 'GET', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const j = await r.json();
        const h = j && (j.height ?? j.count);
        return (h == null) ? null : BigInt(String(h));
    } catch { return null; }
}
// the MINIMUM tip across the queried nodes — conservative, so a single node that
// OVERSTATES the height can never unlock a time-locked output early.
async function minHeightAcross(nodes) {
    const hs = (await Promise.all(nodes.map(daemonHeightFromNode))).filter(h => h !== null);
    return hs.length ? hs.reduce((m, h) => (h < m ? h : m)) : null;
}

// the time-lock gate must honor the SAME node-quorum as the proof step — else a
// single lying node could report unlock_time=0 for a frozen tx and flip
// locked -> paid even under quorum >= 2. quorum 1: first node that answers wins
// (the merchant opted into single-node trust). quorum >= 2: read want+1 nodes in
// parallel and require at least `want` to answer AND all answers to agree; one
// disagreeing node trips it, exactly like checkOnNode. returns the agreed
// unlock_time, or null when it cannot be established — fail CLOSED, the caller
// does not mark paid. set skipUnlockTimeCheck only if you accept that risk.
async function fetchUnlockTime(nodes, txid, quorum = 1) {
    const id = String(txid).toLowerCase();
    const want = Math.max(1, quorum | 0);
    if (want === 1) {
        for (const uri of nodes) {
            const t = await unlockTimeFromNode(uri, id);
            if (t !== null) return t;
        }
        return null;
    }
    const targets = nodes.slice(0, Math.min(nodes.length, want + 1));
    const answered = (await Promise.all(targets.map(uri => unlockTimeFromNode(uri, id)))).filter(t => t !== null);
    if (answered.length < want) return null;                              // not enough nodes vouched — fail closed
    return answered.every(t => t === answered[0]) ? answered[0] : null;   // any disagreement — fail closed
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
 *   status: paid | underpaid | unconfirmed | mempool | no-funds | locked | invalid | replay | node-disagreement | node-error
 *   (node-error is transient/retryable — not enough nodes answered; the verdict statuses are terminal)
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

    const proofKind = detectProofKind(proof);
    if (!proofKind) return fail('invalid', 'proof must be a tx secret key (64 hex) or a tx proof signature (OutProofV*/InProofV*)');

    // quorum 1: try nodes in order, first success wins (resilient, no cross-
    // check). quorum >= 2: query want+1 in parallel and require that EVERY node
    // that answered agrees — a single disagreeing node trips it, which is the
    // whole point of asking more than one.
    const want = Math.max(1, quorum | 0);
    if (nodes.length < want) {
        return fail('invalid', `quorum ${want} needs at least ${want} nodes, but ${nodes.length} provided`);
    }
    let answers = [], errs = [];
    if (want === 1) {
        for (const nodeUri of nodes) {
            try { answers.push(await checkOnNode({ nodeUri, networkType, txid: id, proofKind, proof: proof.trim(), address, message })); break; }
            catch (e) { errs.push(e); }
        }
    } else {
        const targets = nodes.slice(0, Math.min(nodes.length, want + 1));
        const settled = await Promise.allSettled(targets.map(nodeUri =>
            checkOnNode({ nodeUri, networkType, txid: id, proofKind, proof: proof.trim(), address, message })));
        answers = settled.filter(s => s.status === 'fulfilled').map(s => s.value);
        errs = settled.filter(s => s.status === 'rejected').map(s => s.reason);
    }
    if (answers.length < want) {
        const msgs = errs.map(e => (e && e.message) ? e.message : String(e));
        // distinguish a transport failure (retryable → node-error) from a proof the
        // verifier threw out. monero-ts THROWS on malformed proof data ("Wrong
        // signature size" — e.g. a truncated paste), which is NOT a node problem.
        // if EVERY failure is such a data error, it is the proof: terminal `invalid`.
        const proofRejected = errs.length > 0 && errs.every(e => e && e.transient === false);
        return proofRejected
            ? fail('invalid', `proof rejected by the verifier (${msgs.join('; ')})`)
            : fail('node-error', `only ${answers.length}/${want} nodes answered (${msgs.join('; ') || 'no errors'})`);
    }

    const head = answers[0];
    // require `want` answers to agree, not ALL of them. this matches the
    // documented semantics ("quorum N = N nodes must agree") and tolerates
    // one bad/misconfigured node in a want+1 list without blocking payment.
    const agreeing = answers.filter(a => a.isGood === head.isGood && a.receivedPico === head.receivedPico);
    const agreed = agreeing.length >= want;
    if (!agreed) {
        return fail('node-disagreement',
            'nodes returned different results — verify against different nodes',
            { detail: answers.map(a => ({ node: a.nodeUri, isGood: a.isGood, receivedXmr: picoToXmr(a.receivedPico) })) });
    }

    const confirmations = Math.min(...answers.map(a => a.confirmations));
    const receivedXmr = picoToXmr(head.receivedPico);
    // expose the exact piconero too — callers that sum multiple payments (e.g.
    // verifying a multi-tx receipt) must not go through the float `receivedXmr`.
    const base = { receivedXmr, receivedPico: head.receivedPico.toString(), confirmations, txid: id, nodesAgreed: answers.length, expectedXmr: picoToXmr(expectedPico) };

    const tolerancePico = toleranceXmr ? xmrToPico(toleranceXmr) : 0n;
    const cls = classifyResult(
        { isGood: head.isGood, receivedPico: head.receivedPico, confirmations, inTxPool: head.inTxPool },
        { expectedPico, tolerancePico, minConfirmations });
    if (cls.status !== 'ok') return { paid: false, status: cls.status, reason: cls.reason, shortfallXmr: cls.shortfallXmr, ...base };

    // time-lock gate: amount and confirmations can both look right while the
    // outputs are frozen by unlock_time — that is not money the merchant can
    // spend, so it does not count as paid.
    if (!skipUnlockTimeCheck) {
        const unlockTime = await fetchUnlockTime(nodes, id, want);
        if (unlockTime === null) {
            return { paid: false, status: 'invalid', reason: 'could not verify unlock_time — nodes did not return the tx or disagreed; not marking paid (add nodes or retry)', ...base };
        }
        if (unlockTime !== 0n) {
            // a FUTURE unlock_time is the freeze scam (unspendable). but an
            // ALREADY-ELAPSED unlock_time means the funds are spendable now — accept
            // it, matching watch mode (rejecting those threw away legit payments).
            // Monero: unlock_time < 5e8 is a block height, else a unix timestamp.
            let elapsed;
            if (unlockTime >= 500000000n) {
                elapsed = BigInt(Math.floor(Date.now() / 1000)) >= unlockTime;
            } else {
                const tip = await minHeightAcross(nodes);
                // can't confirm the lock elapsed → treat as still locked (conservative).
                elapsed = tip !== null && tip >= unlockTime;
            }
            if (!elapsed) {
                return { paid: false, status: 'locked', reason: `outputs are time-locked (unlock_time=${unlockTime}) — not spendable yet, not accepted`, ...base };
            }
        }
    }

    // replay gate last — only a cryptographically valid, sufficient payment
    // reaches here. the caller's own order storage is the source of truth.
    if (alreadyUsed && await alreadyUsed(id)) {
        return { paid: false, status: 'replay', reason: 'this txid was already used to pay another order', ...base };
    }

    // overpaid still counts as paid, but the merchant gets told so they can
    // decide whether to refund the difference (cls computed it above).
    return {
        paid: true, status: 'paid', reason: 'verified on-chain',
        overpaid: cls.overpaid, overpaidXmr: cls.overpaidXmr,
        ...base,
    };
}

module.exports = { verifyPayment, fetchUnlockTime, minHeightAcross, xmrToPico, picoToXmr, picoToXmrString, atomicToPico, isValidAddress, isValidTxid, detectProofKind, classifyResult, isTransientError };
