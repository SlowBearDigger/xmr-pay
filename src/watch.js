// optional auto-detection ("watch mode") for merchants who run their own
// monero-wallet-rpc with a view-only wallet. the view key stays on the
// merchant's machine; this module just asks that wallet what arrived, so
// buyers don't have to submit proofs. combine freely with proof mode — watch
// for convenience, proofs for disputes and zero-infra setups.
//
// talks to the stock wallet-rpc json-rpc api over http. run wallet-rpc bound
// to localhost or a private network; if you must expose it, put a reverse
// proxy with auth in front (wallet-rpc's digest auth is not implemented here).

const { xmrToPico, picoToXmr, picoToXmrString, atomicToPico, isValidAddress, isValidTxid, detectProofKind, classifyResult, fetchUnlockTime, minHeightAcross } = require('./verify');

// trim trailing slashes without a regex (avoids the /\/+$/ polynomial-ReDoS pattern on node URLs)
const rtrimSlash = u => { u = String(u); let e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; return u.slice(0, e); };

async function rpc(url, method, params = {}, timeoutMs = 15000) {
    let r;
    try {
        r = await fetch(rtrimSlash(url) + '/json_rpc', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (e) {
        // network refused, dropped, or timed out — transient, the caller should
        // retry, NOT treat the payment as failed. tagged so verify can tell it
        // apart from a proof that genuinely doesn't verify.
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true });
    }
    if (!r.ok) throw Object.assign(new Error(`wallet-rpc http ${r.status}`), { transient: true });
    const j = await r.json();
    // a json-rpc error is a protocol-level answer (e.g. a bad tx key) — a verdict,
    // not a transport failure — so it is deliberately NOT tagged transient.
    if (j.error) throw new Error(`wallet-rpc: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
}

// pure summing classifier shared by the wallet-rpc watcher AND the WASM scanner
// (src/scanner.js) — so the two transports never drift on what counts as paid.
// SUMS confirmed transfers (a buyer who paid in two installments still completes),
// holds back pool + time-locked outputs, and reports an EXACT piconero shortfall.
// rows: [{ txid, amountPico (BigInt), confirmations, inPool, locked }]
function summarizeTransfers(rows, expectedPico, minConfirmations = 1, tolerancePico = 0n) {
    let confirmedSum = 0n, pendingSum = 0n, lockedSum = 0n;
    let minConfs = Infinity;
    const txids = [];
    for (const t of rows) {
        // fail-soft: a malformed row (null, non-object, or an amount we can't read as
        // a BigInt) is SKIPPED, never crashes the summary — toRow always hands us
        // clean BigInt rows, but a buggy/odd monero-ts build or a future transport
        // must not be able to stall detection with one bad row.
        if (!t || typeof t !== 'object') continue;
        let amt;
        try { amt = (typeof t.amountPico === 'bigint') ? t.amountPico : BigInt(t.amountPico); } catch { continue; }
        if (amt < 0n) continue;                    // a negative amount can't exist on-chain — never credit it
        if (t.txid != null) txids.push(t.txid);
        const confs = Number(t.confirmations) || 0;
        if (t.locked) { lockedSum += amt; continue; }
        // double_spend_seen: the daemon saw a conflicting spend of these inputs —
        // contested money. hold it as pending (never credit) until the flag clears
        // (it does once the tx is firmly in the chain). protects a low-minConf
        // merchant from a reorg-double-spend that a plain confirmation count misses.
        if (!t.inPool && !t.doubleSpendSeen && confs >= minConfirmations) {
            confirmedSum += amt;
            minConfs = Math.min(minConfs, confs);
        } else {
            pendingSum += amt;
        }
    }
    // everything that has ARRIVED on-chain — confirmed, in the pool, OR confirmed
    // but still in its ~10-block lock window. the shortfall is measured against
    // this so a top-up prompt never tells the buyer to re-send money that is
    // already here: locked funds just need to mature, there's nothing more to pay.
    const seenPico = confirmedSum + pendingSum + lockedSum;
    // accepted-shortfall tolerance: a buyer who lands within `tolerancePico` of the
    // price still completes (absorbs dust / fee / rounding so they aren't stuck
    // "underpaid"). default 0 = exact. NEVER let tolerance reach/exceed the price —
    // that would mark an order paid on (next to) nothing.
    const threshold = (tolerancePico > 0n && tolerancePico < expectedPico) ? expectedPico - tolerancePico : expectedPico;
    const base = {
        receivedXmr: picoToXmr(confirmedSum),
        receivedPico: confirmedSum.toString(), // exact string so callers avoid a float round-trip
        pendingXmr: picoToXmr(pendingSum),
        lockedXmr: picoToXmr(lockedSum),
        requiredXmr: picoToXmr(expectedPico),
        // exact; measured against the (tolerance-adjusted) threshold so a "paid"
        // order never shows a leftover shortfall, and counts money already seen.
        shortfallXmr: picoToXmrString(seenPico < threshold ? threshold - seenPico : 0n),
        confirmations: minConfs === Infinity ? 0 : minConfs,
        txids,
    };
    // defense in depth: an expected amount of 0 (or negative) must NEVER summarize
    // as paid — `0 >= 0` would mark an order paid with nothing received. callers
    // (createOrder) reject this upstream; this is the last line.
    if (expectedPico <= 0n) return { paid: false, status: 'invalid', reason: 'expected amount must be greater than 0', ...base };
    if (confirmedSum >= threshold) {
        // overpaid is measured against the FULL price (not the tolerant threshold):
        // report the exact excess so the merchant can refund + the buyer be told.
        const overpaid = confirmedSum > expectedPico;
        return {
            paid: true, status: 'paid', reason: 'received on-chain',
            overpaid, overpaidXmr: overpaid ? picoToXmrString(confirmedSum - expectedPico) : '0',
            ...base,
        };
    }
    if (lockedSum + confirmedSum >= threshold) return { paid: false, status: 'locked', reason: 'enough arrived but some outputs are time-locked', ...base };
    if (confirmedSum + pendingSum >= threshold) return { paid: false, status: 'mempool', reason: 'enough seen, waiting for confirmations', ...base };
    if (confirmedSum > 0n || pendingSum > 0n) return { paid: false, status: 'partial', reason: 'partial payment so far', ...base };
    return { paid: false, status: 'pending', reason: 'nothing received yet', ...base };
}

function createWatcher({ url, accountIndex = 0 } = {}) {
    if (!url) throw new Error('url of your monero-wallet-rpc is required');

    return {
        // fresh subaddress per order — keeps two orders from ever colliding and
        // keeps one buyer from learning anything about another.
        async newSubaddress(label = '') {
            const r = await rpc(url, 'create_address', { account_index: accountIndex, label });
            return { address: r.address, index: r.address_index };
        },

        // everything that arrived at one subaddress, normalized. includes pool.
        async incoming(subaddressIndex) {
            const r = await rpc(url, 'get_transfers', {
                in: true, pool: true, account_index: accountIndex, subaddr_indices: [subaddressIndex],
            });
            const rows = [...(r.in || []), ...(r.pool || [])];
            return rows.map(t => ({
                txid: t.txid,
                // wallet-rpc returns amount as a JSON number (atomic units). that
                // is exact below 2^53 piconero (~9007 XMR per transfer); a single
                // transfer larger than that could lose precision before it is read.
                // fine for normal payments; relevant only for whales. atomicToPico
                // rejects a malformed amount loudly rather than producing a wrong
                // BigInt.
                amountPico: atomicToPico(t.amount),
                confirmations: Number(t.confirmations || 0),
                inPool: t.type === 'pool',
                // the daemon saw a conflicting spend of these inputs — contested
                // money. summarizeTransfers holds it as pending (never credits) until
                // the flag clears. without this the double-spend gate is DEAD on the
                // wallet-rpc transport (the WASM scanner sets it in scanner.js).
                doubleSpendSeen: !!t.double_spend_seen,
                // recent wallet-rpc reports `locked`; fall back to unlock_time
                locked: t.locked !== undefined ? !!t.locked && Number(t.unlock_time || 0) !== 0 : Number(t.unlock_time || 0) !== 0,
                unlockTime: Number(t.unlock_time || 0),
            }));
        },

        // classify one order. unlike proof mode this SUMS transfers, so a buyer
        // who paid in two installments still resolves to paid.
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            const rows = await this.incoming(subaddressIndex);
            return summarizeTransfers(rows, xmrToPico(amount), minConfirmations);
        },

        async height() {
            const r = await rpc(url, 'get_height');
            return r.height;
        },
    };
}

// read the tx's unlock_time for the time-lock gate. prefer the wallet's own
// record (self-contained — no daemon needed) when it received the tx; fall back
// to a daemon node via fetchUnlockTime. returns BigInt, or null when it cannot
// be established (caller fails closed).
async function unlockTimeViaRpc(url, id, nodes, timeoutMs) {
    try {
        const t = await rpc(url, 'get_transfer_by_txid', { txid: id }, timeoutMs);
        const tr = t && t.transfer;
        if (tr && tr.unlock_time !== undefined && tr.unlock_time !== null) return BigInt(String(tr.unlock_time));
    } catch { /* wallet has no record of this tx — fall back to a daemon */ }
    if (nodes && nodes.length) return fetchUnlockTime(nodes, id);
    return null;
}

/**
 * verifyPaymentViaRpc — verify a buyer's proof using a monero-wallet-rpc instead
 * of the monero-ts WASM peer. a merchant who already runs wallet-rpc needs NO
 * monero-ts at all (and so carries none of its transitive advisories). same
 * gates and status vocabulary as verifyPayment — it shares classifyResult and
 * the time-lock gate, so the two transports never drift on what counts as paid.
 *
 * @param {object} opts
 * @param {string}   opts.url                 your monero-wallet-rpc base url (e.g. http://127.0.0.1:18083)
 * @param {string}   opts.txid                transaction id (64 hex)
 * @param {string}   opts.proof               tx secret key (64 hex) or tx proof signature ((Out|In)ProofV*)
 * @param {string}   opts.address             the payment address for THIS order
 * @param {string|number} opts.amount         expected XMR (string keeps 12-decimal nonces exact)
 * @param {string[]} [opts.nodes]             daemon URIs for the time-lock gate when the wallet has no record of the tx
 * @param {string}   [opts.networkType]       'mainnet' (default) | 'stagenet' | 'testnet'
 * @param {number}   [opts.minConfirmations]  default 1
 * @param {string}   [opts.message]           challenge message the proof was generated over (default '')
 * @param {number}   [opts.toleranceXmr]      accepted shortfall, default 0 (exact)
 * @param {boolean}  [opts.skipUnlockTimeCheck] default false; skips the time-lock guard (NOT recommended)
 * @param {function} [opts.alreadyUsed]       async (txid) => boolean — caller's ATOMIC replay check (see verifyPayment)
 * @returns {Promise<object>} same shape as verifyPayment, plus transport:'wallet-rpc'
 */
async function verifyPaymentViaRpc(opts) {
    const {
        url, txid, proof, address, amount,
        nodes = [],
        networkType = 'mainnet',
        minConfirmations = 1,
        message = '',
        toleranceXmr = 0,
        skipUnlockTimeCheck = false,
        alreadyUsed = null,
        timeoutMs = 15000,
    } = opts || {};

    const id = String(txid == null ? '' : txid).trim().toLowerCase();
    const fail = (status, reason, extra = {}) => ({
        paid: false, status, reason,
        receivedXmr: 0, confirmations: 0, txid: id || null, transport: 'wallet-rpc', ...extra,
    });

    if (!url) return fail('invalid', 'url of your monero-wallet-rpc is required');
    if (!isValidTxid(id)) return fail('invalid', 'txid must be 64 hex chars');
    if (!isValidAddress(address, networkType)) return fail('invalid', `address is not a valid ${networkType} address`);
    let expectedPico;
    try { expectedPico = xmrToPico(amount); } catch (e) { return fail('invalid', e.message); }
    if (expectedPico <= 0n) return fail('invalid', 'amount must be greater than 0');
    const proofKind = detectProofKind(proof);
    if (!proofKind) return fail('invalid', 'proof must be a tx secret key (64 hex) or a tx proof signature (OutProofV*/InProofV*)');

    // ask the wallet-rpc to verify the proof. check_tx_key throws on a bad key;
    // check_tx_proof returns good=false. amounts come back as atomic units.
    let check;
    try {
        check = proofKind === 'txkey'
            ? await rpc(url, 'check_tx_key', { txid: id, tx_key: proof.trim(), address }, timeoutMs)
            : await rpc(url, 'check_tx_proof', { txid: id, address, message, signature: proof.trim() }, timeoutMs);
    } catch (e) {
        // a transient transport failure (wallet-rpc down, slow, HTTP 500) is
        // retryable and must read differently from a proof that genuinely doesn't
        // verify (a json-rpc error, e.g. a bad key) — the merchant retries the
        // first, rejects the second.
        if (e && e.transient) return fail('node-error', `wallet-rpc unreachable: ${e.message}`);
        return fail('invalid', `proof did not verify via wallet-rpc: ${e.message}`);
    }

    const isGood = proofKind === 'txkey' ? true : !!check.good;
    // wallet-rpc returns atomic units as a JSON number — exact below 2^53
    // piconero (~9007 XMR); whale-only precision caveat. parse defensively: a
    // malformed amount fails closed (invalid) instead of throwing uncaught.
    let receivedPico;
    try { receivedPico = atomicToPico(check.received); }
    catch (e) { return fail('invalid', `wallet-rpc returned a malformed amount: ${e.message}`); }
    const confirmations = Number(check.confirmations || 0);
    const inTxPool = !!check.in_pool;
    const base = { receivedXmr: picoToXmr(receivedPico), confirmations, txid: id, expectedXmr: picoToXmr(expectedPico), transport: 'wallet-rpc' };

    const tolerancePico = toleranceXmr ? xmrToPico(toleranceXmr) : 0n;
    const r = classifyResult({ isGood, receivedPico, confirmations, inTxPool }, { expectedPico, tolerancePico, minConfirmations });
    if (r.status !== 'ok') return { paid: false, status: r.status, reason: r.reason, shortfallXmr: r.shortfallXmr, ...base };

    if (!skipUnlockTimeCheck) {
        const unlockTime = await unlockTimeViaRpc(url, id, nodes, timeoutMs);
        if (unlockTime === null) {
            return { paid: false, status: 'invalid', reason: 'could not verify unlock_time — the wallet has no record of this tx and no daemon nodes were given; pass `nodes` or set skipUnlockTimeCheck', ...base };
        }
        if (unlockTime !== 0n) {
            // a FUTURE unlock_time is the freeze scam (unspendable). but an
            // ALREADY-ELAPSED unlock_time means the funds are spendable now — accept
            // it, matching verifyPayment + watch mode (rejecting those stranded legit
            // payments forever on this transport). Monero: unlock_time < 5e8 is a
            // block height, else a unix timestamp.
            let elapsed;
            if (unlockTime >= 500000000n) {
                elapsed = BigInt(Math.floor(Date.now() / 1000)) >= unlockTime;
            } else {
                // chain tip: prefer the wallet's own height (self-contained on this
                // transport — no daemon needed), fall back to the given nodes. can't
                // establish it → treat as still locked (conservative, never early).
                let tip = null;
                try { const h = await rpc(url, 'get_height', {}, timeoutMs); tip = (h && h.height != null) ? BigInt(String(h.height)) : null; } catch { /* fall back to nodes */ }
                if (tip === null && nodes && nodes.length) tip = await minHeightAcross(nodes);
                elapsed = tip !== null && tip >= unlockTime;
            }
            if (!elapsed) {
                return { paid: false, status: 'locked', reason: `outputs are time-locked (unlock_time=${unlockTime}) — not spendable yet, not accepted`, ...base };
            }
        }
    }

    if (alreadyUsed && await alreadyUsed(id)) {
        return { paid: false, status: 'replay', reason: 'this txid was already used to pay another order', ...base };
    }

    return {
        paid: true, status: 'paid', reason: 'verified on-chain (wallet-rpc)',
        overpaid: r.overpaid, overpaidXmr: r.overpaidXmr, ...base,
    };
}

module.exports = { createWatcher, verifyPaymentViaRpc, summarizeTransfers };
