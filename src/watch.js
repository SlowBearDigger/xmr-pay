// optional auto-detection ("watch mode") for merchants who run their own
// monero-wallet-rpc with a view-only wallet. the view key stays on the
// merchant's machine; this module just asks that wallet what arrived, so
// buyers don't have to submit proofs. combine freely with proof mode — watch
// for convenience, proofs for disputes and zero-infra setups.
//
// talks to the stock wallet-rpc json-rpc api over http. run wallet-rpc bound
// to localhost or a private network; if you must expose it, put a reverse
// proxy with auth in front (wallet-rpc's digest auth is not implemented here).

const { xmrToPico, picoToXmr, isValidAddress, isValidTxid, detectProofKind, classifyResult, fetchUnlockTime } = require('./verify');

async function rpc(url, method, params = {}, timeoutMs = 15000) {
    const r = await fetch(String(url).replace(/\/+$/, '') + '/json_rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`wallet-rpc http ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`wallet-rpc: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
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
                // transfer larger than that could lose precision before BigInt
                // sees it. fine for normal payments; relevant only for whales.
                amountPico: BigInt(t.amount),
                confirmations: Number(t.confirmations || 0),
                inPool: t.type === 'pool',
                // recent wallet-rpc reports `locked`; fall back to unlock_time
                locked: t.locked !== undefined ? !!t.locked && Number(t.unlock_time || 0) !== 0 : Number(t.unlock_time || 0) !== 0,
                unlockTime: Number(t.unlock_time || 0),
            }));
        },

        // classify one order. unlike proof mode this SUMS transfers, so a buyer
        // who paid in two installments still resolves to paid.
        async checkOrder({ subaddressIndex, amount, minConfirmations = 1 }) {
            const expected = xmrToPico(amount);
            const rows = await this.incoming(subaddressIndex);

            let confirmedSum = 0n, pendingSum = 0n, lockedSum = 0n;
            let minConfs = Infinity;
            const txids = [];
            for (const t of rows) {
                txids.push(t.txid);
                if (t.locked) { lockedSum += t.amountPico; continue; }
                if (!t.inPool && t.confirmations >= minConfirmations) {
                    confirmedSum += t.amountPico;
                    minConfs = Math.min(minConfs, t.confirmations);
                } else {
                    pendingSum += t.amountPico;
                }
            }

            const base = {
                receivedXmr: picoToXmr(confirmedSum),
                pendingXmr: picoToXmr(pendingSum),
                requiredXmr: picoToXmr(expected),
                confirmations: minConfs === Infinity ? 0 : minConfs,
                txids,
            };
            if (confirmedSum >= expected) return { paid: true, status: 'paid', reason: 'received on-chain', ...base };
            if (lockedSum + confirmedSum >= expected) return { paid: false, status: 'locked', reason: 'enough arrived but some outputs are time-locked', ...base };
            if (confirmedSum + pendingSum >= expected) return { paid: false, status: 'mempool', reason: 'enough seen, waiting for confirmations', ...base };
            if (confirmedSum > 0n || pendingSum > 0n) return { paid: false, status: 'partial', reason: 'partial payment so far', ...base };
            return { paid: false, status: 'pending', reason: 'nothing received yet', ...base };
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
        // an invalid key/proof is reported by wallet-rpc as an error; so is an
        // unreachable wallet. both mean "not verified here".
        return fail('invalid', `proof did not verify via wallet-rpc: ${e.message}`);
    }

    const isGood = proofKind === 'txkey' ? true : !!check.good;
    // wallet-rpc returns atomic units as a JSON number — exact below 2^53
    // piconero (~9007 XMR); whale-only precision caveat, same as watch mode.
    const receivedPico = BigInt(check.received ?? 0);
    const confirmations = Number(check.confirmations || 0);
    const inTxPool = !!check.in_pool;
    const base = { receivedXmr: picoToXmr(receivedPico), confirmations, txid: id, transport: 'wallet-rpc' };

    const tolerancePico = toleranceXmr ? xmrToPico(toleranceXmr) : 0n;
    const r = classifyResult({ isGood, receivedPico, confirmations, inTxPool }, { expectedPico, tolerancePico, minConfirmations });
    if (r.status !== 'ok') return { paid: false, status: r.status, reason: r.reason, ...base };

    if (!skipUnlockTimeCheck) {
        const unlockTime = await unlockTimeViaRpc(url, id, nodes, timeoutMs);
        if (unlockTime === null) {
            return { paid: false, status: 'invalid', reason: 'could not verify unlock_time — the wallet has no record of this tx and no daemon nodes were given; pass `nodes` or set skipUnlockTimeCheck', ...base };
        }
        if (unlockTime !== 0n) {
            return { paid: false, status: 'locked', reason: `outputs are time-locked (unlock_time=${unlockTime}) — not spendable, not accepted`, ...base };
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

module.exports = { createWatcher, verifyPaymentViaRpc };
