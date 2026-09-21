// Classify incoming wallet transfers for payment orders.
const { xmrToPico, picoToXmr, picoToXmrString, atomicToPico, isValidAddress, isValidTxid, detectProofKind, classifyResult, fetchUnlockTime, minHeightAcross } = require('./verify');

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

        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { transient: true });
    }
    if (!r.ok) throw Object.assign(new Error(`wallet-rpc http ${r.status}`), { transient: true });
    const j = await r.json();

    if (j.error) throw new Error(`wallet-rpc: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
}

function rowAmtPico(t) {
    try { return (typeof t.amountPico === 'bigint') ? t.amountPico : BigInt(t.amountPico); } catch { return 0n; }
}

function moreCreditable(a, b) {
    if (!!a.doubleSpendSeen !== !!b.doubleSpendSeen) return a.doubleSpendSeen ? a : b;
    if (!!a.inPool !== !!b.inPool) return a.inPool ? b : a;
    const ca = Number(a.confirmations) || 0, cb = Number(b.confirmations) || 0;
    if (ca !== cb) return ca > cb ? a : b;
    if (!!a.locked !== !!b.locked) return a.locked ? a : b;
    const aa = rowAmtPico(a), bb = rowAmtPico(b);
    if (aa !== bb) return aa < bb ? a : b;
    return a;
}

function dedupByTxid(rows) {
    if (!Array.isArray(rows)) return [];
    const posByKey = new Map();
    const out = [];
    for (const t of rows) {
        if (!t || typeof t !== 'object') { out.push(t); continue; }
        const key = (t.outKey != null && t.outKey !== '') ? 'k:' + t.outKey
            : (t.txid != null && t.txid !== '') ? 't:' + t.txid : null;
        if (key === null) { out.push(t); continue; }
        const pos = posByKey.get(key);
        if (pos === undefined) { posByKey.set(key, out.length); out.push(t); }
        else out[pos] = moreCreditable(out[pos], t);
    }
    return out;
}

function summarizeTransfers(rows, expectedPico, minConfirmations = 1, tolerancePico = 0n) {

    minConfirmations = Math.max(0, minConfirmations | 0);

    rows = dedupByTxid(rows);
    let confirmedSum = 0n, pendingSum = 0n, lockedSum = 0n;
    let minConfs = Infinity;
    const txids = [];
    for (const t of rows) {

        if (!t || typeof t !== 'object') continue;
        let amt;
        try { amt = (typeof t.amountPico === 'bigint') ? t.amountPico : BigInt(t.amountPico); } catch { continue; }
        if (amt < 0n) continue;
        if (t.txid != null) txids.push(t.txid);
        const confs = Number(t.confirmations) || 0;
        if (t.locked) { lockedSum += amt; continue; }

        if (!t.inPool && !t.doubleSpendSeen && confs >= minConfirmations) {
            confirmedSum += amt;
            minConfs = Math.min(minConfs, confs);
        } else {
            pendingSum += amt;
        }
    }

    const seenPico = confirmedSum + pendingSum + lockedSum;

    const threshold = (tolerancePico > 0n && tolerancePico < expectedPico) ? expectedPico - tolerancePico : expectedPico;
    const base = {
        receivedXmr: picoToXmr(confirmedSum),
        receivedPico: confirmedSum.toString(),
        pendingXmr: picoToXmr(pendingSum),
        lockedXmr: picoToXmr(lockedSum),
        requiredXmr: picoToXmr(expectedPico),

        shortfallXmr: picoToXmrString(seenPico < threshold ? threshold - seenPico : 0n),
        confirmations: minConfs === Infinity ? 0 : minConfs,
        txids,
    };

    if (expectedPico <= 0n) return { paid: false, status: 'invalid', reason: 'expected amount must be greater than 0', ...base };
    if (confirmedSum >= threshold) {

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

        async newSubaddress(label = '') {
            const r = await rpc(url, 'create_address', { account_index: accountIndex, label });
            return { address: r.address, index: r.address_index };
        },

        async incoming(subaddressIndex) {
            const r = await rpc(url, 'get_transfers', {
                in: true, pool: true, account_index: accountIndex, subaddr_indices: [subaddressIndex],
            });
            const rows = [...(r.in || []), ...(r.pool || [])];
            return rows.map(t => ({
                txid: t.txid,

                amountPico: atomicToPico(t.amount),
                confirmations: Number(t.confirmations || 0),
                inPool: t.type === 'pool',

                doubleSpendSeen: !!t.double_spend_seen,

                locked: t.locked !== undefined ? !!t.locked && Number(t.unlock_time || 0) !== 0 : Number(t.unlock_time || 0) !== 0,
                unlockTime: Number(t.unlock_time || 0),
            }));
        },

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

async function unlockTimeViaRpc(url, id, nodes, timeoutMs) {
    try {
        const t = await rpc(url, 'get_transfer_by_txid', { txid: id }, timeoutMs);
        const tr = t && t.transfer;
        if (tr && tr.unlock_time !== undefined && tr.unlock_time !== null) return BigInt(String(tr.unlock_time));
    } catch {   }
    if (nodes && nodes.length) return fetchUnlockTime(nodes, id);
    return null;
}

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

    let check;
    try {
        check = proofKind === 'txkey'
            ? await rpc(url, 'check_tx_key', { txid: id, tx_key: proof.trim(), address }, timeoutMs)
            : await rpc(url, 'check_tx_proof', { txid: id, address, message, signature: proof.trim() }, timeoutMs);
    } catch (e) {

        if (e && e.transient) return fail('node-error', `wallet-rpc unreachable: ${e.message}`);
        return fail('invalid', `proof did not verify via wallet-rpc: ${e.message}`);
    }

    const isGood = proofKind === 'txkey' ? true : !!check.good;

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

            let elapsed;
            if (unlockTime >= 500000000n) {
                elapsed = BigInt(Math.floor(Date.now() / 1000)) >= unlockTime;
            } else {

                let tip = null;
                try { const h = await rpc(url, 'get_height', {}, timeoutMs); tip = (h && h.height != null) ? BigInt(String(h.height)) : null; } catch {   }
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
