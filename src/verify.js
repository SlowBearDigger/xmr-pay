// Verify on-chain payment evidence and exact amounts.
let monerojs = null;
function lazyMonero() {
    if (!monerojs) monerojs = require('monero-ts');
    return monerojs;
}

const _warned = new Set();
function warnOnce(msg) {
    if (_warned.has(msg)) return;
    _warned.add(msg);
    try { console.warn('[xmr-pay] ' + msg); } catch {   }
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

const MAX_PICO = 18446744073709551615n;
function xmrToPico(x) {

    if (typeof x !== 'number' && typeof x !== 'string' && typeof x !== 'bigint') {
        throw new Error(`invalid XMR amount type: ${x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x}`);
    }
    const s = typeof x === 'number'
        ? (Number.isFinite(x) ? x.toFixed(12).replace(/\.?0+$/, '') : 'NaN')
        : String(x).trim();
    if (!/^\d+(\.\d{1,12})?$/.test(s)) throw new Error(`invalid XMR amount: ${x}`);
    const [i, f = ''] = s.split('.');
    const pico = BigInt(i) * 1000000000000n + BigInt(f.padEnd(12, '0'));
    if (pico > MAX_PICO) throw new Error(`XMR amount exceeds the maximum supply: ${x}`);
    return pico;
}
function picoToXmr(p) {
    return Number(p) / 1e12;
}

function picoToXmrString(pico) {

    const neg = pico < 0n;
    const s = (neg ? -pico : pico).toString().padStart(13, '0');
    const i = s.slice(0, -12);
    let f = s.slice(-12);
    let fend = f.length; while (fend > 0 && f.charCodeAt(fend - 1) === 48) fend--;
    f = f.slice(0, fend);
    return (neg ? '-' : '') + (f ? `${i}.${f}` : i);
}

function atomicToPico(v) {
    if (v === undefined || v === null) return 0n;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') {
        if (!Number.isInteger(v)) throw new Error(`non-integer atomic amount: ${v}`);

        if (!Number.isSafeInteger(v)) throw new Error(`atomic amount ${v} exceeds JS safe-integer precision: pass it as a string or BigInt`);
        return BigInt(v);
    }

    if (typeof v !== 'string') throw new Error(`invalid atomic amount type: ${Array.isArray(v) ? 'array' : typeof v}`);
    const s = v.trim();
    if (!/^-?\d+$/.test(s)) throw new Error(`non-integer atomic amount: ${v}`);
    const r = BigInt(s);
    if (r > MAX_PICO) throw new Error(`atomic amount exceeds uint64 max: ${v}`);
    return r;
}

function detectProofKind(proof) {
    if (typeof proof !== 'string') return null;
    const p = proof.trim();
    if (/^[0-9a-f]{64}$/i.test(p)) return 'txkey';
    if (/^(Out|In)Proof[A-Za-z0-9]/.test(p)) return 'txproof';
    return null;
}

function classifyResult({ isGood, receivedPico, confirmations, inTxPool }, { expectedPico, tolerancePico = 0n, minConfirmations = 1 }) {
    if (!isGood) return { status: 'invalid', reason: 'proof does not verify for this txid/address' };
    if (receivedPico <= 0n) return { status: 'no-funds', reason: 'this transaction sent nothing to this address' };

    const threshold = (tolerancePico > 0n && tolerancePico < expectedPico) ? expectedPico - tolerancePico : expectedPico;
    if (receivedPico < threshold) {

        return {
            status: 'underpaid',
            reason: `received ${picoToXmr(receivedPico)} XMR, expected ${picoToXmr(expectedPico)}`,
            shortfallXmr: picoToXmrString(expectedPico - receivedPico),
        };
    }

    if (confirmations < Math.max(0, minConfirmations | 0)) {
        return { status: inTxPool ? 'mempool' : 'unconfirmed', reason: `${confirmations}/${minConfirmations} confirmations` };
    }
    const overpaid = receivedPico > expectedPico;

    return { status: 'ok', overpaid, overpaidXmr: overpaid ? picoToXmrString(receivedPico - expectedPico) : '0' };
}

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
        if (timer.unref) timer.unref();
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

        if (e && e.transient === undefined) {
            try { e.transient = isTransientError(e); } catch {   }
        }
        if (e.transient !== false) dropWallet(key);
        throw e;
    }
}

const rtrimSlash = u => { u = String(u); let e = u.length; while (e > 0 && u.charCodeAt(e - 1) === 47) e--; return u.slice(0, e); };

function assertNodeUri(uri) {
    const u = new URL(String(uri));
    if (u.protocol !== 'http:' && u.protocol !== 'https:')
        throw new Error(`node URI scheme must be http or https, got: ${u.protocol} (${uri})`);
}

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

        if (!tx.tx_hash || String(tx.tx_hash).toLowerCase() !== txid) return null;
        const decoded = JSON.parse(tx.as_json);
        if (decoded.unlock_time === undefined || decoded.unlock_time === null) return null;
        return BigInt(String(decoded.unlock_time));
    } catch { return null; }
}

async function daemonHeightFromNode(uri) {
    try {
        const r = await fetch(rtrimSlash(uri) + '/get_height', { method: 'GET', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;
        const j = await r.json();
        const h = j && (j.height ?? j.count);
        return (h == null) ? null : BigInt(String(h));
    } catch { return null; }
}

async function minHeightAcross(nodes) {
    const hs = (await Promise.all(nodes.map(daemonHeightFromNode))).filter(h => h !== null);
    return hs.length ? hs.reduce((m, h) => (h < m ? h : m)) : null;
}

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
    if (answered.length < want) return null;
    return answered.every(t => t === answered[0]) ? answered[0] : null;
}

function resolveQuorum(answers, want) {
    const clusters = new Map();
    for (const a of answers) {
        const k = `${a.isGood}|${a.receivedPico}`;
        if (!clusters.has(k)) clusters.set(k, []);
        clusters.get(k).push(a);
    }
    const ranked = [...clusters.values()].sort((x, y) => y.length - x.length);
    const majority = ranked[0] || [];
    const quorumClusters = ranked.filter(c => c.length >= want).length;
    return { head: majority[0] || null, agreed: majority.length >= want && quorumClusters === 1 };
}

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

    if (skipUnlockTimeCheck) warnOnce('skipUnlockTimeCheck is on: time-locked (unspendable) payments will be accepted as paid. leave it off unless you know exactly why.');

    const id = String(txid == null ? '' : txid).trim().toLowerCase();

    const fail = (status, reason, extra = {}) => ({
        paid: false, status, reason,
        receivedXmr: 0, confirmations: 0, txid: id || null, nodesAgreed: 0,
        ...extra,
    });

    if (!isValidTxid(id)) return fail('invalid', 'txid must be 64 hex chars');
    if (!isValidAddress(address, networkType)) return fail('invalid', `address is not a valid ${networkType} address`);
    if (!Array.isArray(nodes) || nodes.length === 0) return fail('invalid', 'at least one node URI required');
    nodes.forEach(assertNodeUri);

    if (nodes.length === 1 && (quorum | 0) <= 1) warnOnce('quorum=1 with a single node: that node controls confirmations and unlock_time. set nodes to 2+ and quorum=2 to require independent agreement.');
    let expectedPico;
    try { expectedPico = xmrToPico(amount); } catch (e) { return fail('invalid', e.message); }
    if (expectedPico <= 0n) return fail('invalid', 'amount must be greater than 0');

    const proofKind = detectProofKind(proof);
    if (!proofKind) return fail('invalid', 'proof must be a tx secret key (64 hex) or a tx proof signature (OutProofV*/InProofV*)');

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

        const proofRejected = errs.length > 0 && errs.every(e => e && e.transient === false);
        return proofRejected
            ? fail('invalid', `proof rejected by the verifier (${msgs.join('; ')})`)
            : fail('node-error', `only ${answers.length}/${want} nodes answered (${msgs.join('; ') || 'no errors'})`);
    }

    const { head, agreed } = resolveQuorum(answers, want);
    if (!agreed) {
        return fail('node-disagreement',
            'nodes returned different results: verify against different nodes',
            { detail: answers.map(a => ({ node: a.nodeUri, isGood: a.isGood, receivedXmr: picoToXmr(a.receivedPico) })) });
    }

    const confirmations = Math.min(...answers.map(a => a.confirmations));
    const receivedXmr = picoToXmr(head.receivedPico);

    const base = { receivedXmr, receivedPico: head.receivedPico.toString(), confirmations, txid: id, nodesAgreed: answers.length, expectedXmr: picoToXmr(expectedPico) };

    const tolerancePico = toleranceXmr ? xmrToPico(toleranceXmr) : 0n;
    const cls = classifyResult(
        { isGood: head.isGood, receivedPico: head.receivedPico, confirmations, inTxPool: head.inTxPool },
        { expectedPico, tolerancePico, minConfirmations });
    if (cls.status !== 'ok') return { paid: false, status: cls.status, reason: cls.reason, shortfallXmr: cls.shortfallXmr, ...base };

    if (!skipUnlockTimeCheck) {
        const unlockTime = await fetchUnlockTime(nodes, id, want);
        if (unlockTime === null) {
            return { paid: false, status: 'invalid', reason: 'could not verify unlock_time: nodes did not return the tx or disagreed; not marking paid (add nodes or retry)', ...base };
        }
        if (unlockTime !== 0n) {

            let elapsed;
            if (unlockTime >= 500000000n) {
                elapsed = BigInt(Math.floor(Date.now() / 1000)) >= unlockTime;
            } else {
                const tip = await minHeightAcross(nodes);

                elapsed = tip !== null && tip >= unlockTime;
            }
            if (!elapsed) {
                return { paid: false, status: 'locked', reason: `outputs are time-locked (unlock_time=${unlockTime}): not spendable yet, not accepted`, ...base };
            }
        }
    }

    if (alreadyUsed && await alreadyUsed(id)) {
        return { paid: false, status: 'replay', reason: 'this txid was already used to pay another order', ...base };
    }

    return {
        paid: true, status: 'paid', reason: 'verified on-chain',
        overpaid: cls.overpaid, overpaidXmr: cls.overpaidXmr,
        ...base,
    };
}

module.exports = { verifyPayment, resolveQuorum, fetchUnlockTime, minHeightAcross, xmrToPico, picoToXmr, picoToXmrString, atomicToPico, isValidAddress, isValidTxid, detectProofKind, classifyResult, isTransientError };
