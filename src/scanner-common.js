'use strict';

const big = value => BigInt(value == null ? 0 : (value.toString ? value.toString() : value));
const read = (object, method, property) => object && typeof object[method] === 'function'
    ? object[method]()
    : (object ? object[property] : undefined);

function toRow(transfer) {
    const tx = typeof transfer.getTx === 'function' ? transfer.getTx() : (transfer.tx || {});
    const confirmations = Number(read(tx, 'getNumConfirmations', 'numConfirmations') ?? 0) || 0;
    const confirmed = !!read(tx, 'getIsConfirmed', 'isConfirmed');
    const inPool = !confirmed || !!read(tx, 'getInTxPool', 'inTxPool');
    let unlockTime = 0n;
    try {
        const value = read(tx, 'getUnlockTime', 'unlockTime');
        if (value != null && String(value) !== '') unlockTime = BigInt(String(value));
    } catch { unlockTime = 0n; }
    const txid = read(tx, 'getHash', 'hash') || read(transfer, 'getTxHash', 'txHash') || null;
    const amountPico = big(read(transfer, 'getAmount', 'amount') ?? 0n);
    const doubleSpendSeen = !!read(tx, 'getIsDoubleSpendSeen', 'isDoubleSpendSeen');
    const height = Number(read(tx, 'getHeight', 'height') ?? 0) || 0;
    let locked = false;
    if (unlockTime > 0n) {
        if (unlockTime < 500000000n) {
            const currentHeight = BigInt(height > 0 ? height + confirmations - 1 : 0);
            locked = currentHeight < unlockTime;
        } else {
            locked = BigInt(Math.floor(Date.now() / 1000)) < unlockTime;
        }
    }
    const rawIndex = Number(read(transfer, 'getSubaddressIndex', 'subaddressIndex'));
    const subaddressIndex = Number.isFinite(rawIndex) ? rawIndex : null;
    return { txid, amountPico, confirmations, inPool, locked, height, doubleSpendSeen, subaddressIndex };
}

const BIRTHDAY_GRACE = 3;
function creditableRows(rows, minHeight, grace = BIRTHDAY_GRACE) {
    if (minHeight == null) return rows;
    const floor = minHeight - grace;
    return rows.filter(row => !row.height || row.height >= floor);
}

module.exports = { BIRTHDAY_GRACE, creditableRows, read, toRow };
