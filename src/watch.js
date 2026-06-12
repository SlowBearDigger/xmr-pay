// optional auto-detection ("watch mode") for merchants who run their own
// monero-wallet-rpc with a view-only wallet. the view key stays on the
// merchant's machine; this module just asks that wallet what arrived, so
// buyers don't have to submit proofs. combine freely with proof mode — watch
// for convenience, proofs for disputes and zero-infra setups.
//
// talks to the stock wallet-rpc json-rpc api over http. run wallet-rpc bound
// to localhost or a private network; if you must expose it, put a reverse
// proxy with auth in front (wallet-rpc's digest auth is not implemented here).

const { xmrToPico, picoToXmr } = require('./verify');

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

module.exports = { createWatcher };
