/*
 * xmr-pay portable checkout — page shell logic. Vanilla, zero dependencies.
 * Reads the order from the URL (fragment preferred — it never reaches a server), wires the
 * <xmr-pay> widget (which does the QR, status poll / SSE, top-up and receipt), and drives an
 * advisory price-lock countdown. The widget and the chain are the source of truth; the
 * countdown is cosmetic, so a late top-up is never lost.
 */
(function () {
  'use strict';

  var query = new URLSearchParams(location.search);
  var hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var get = function (k) { var v = hash.get(k); return (v === null ? query.get(k) : v); };

  var mount = document.getElementById('xp-mount');
  var address = (get('address') || '').trim();
  var config = (get('config') || '').trim();

  // a valid payable target is EITHER a signed config envelope or a 95/106-char Monero
  // address (mainnet 4/8, stagenet 5/7, integrated 4...). keep the check loose; the widget
  // does the strict validation + the signed-config signature check.
  var addressLooksValid = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(address);
  if (!config && !addressLooksValid) {
    mount.innerHTML = '<p class="xp-broken"><b>This payment link looks incomplete.</b> Please go back and open the full link your merchant sent you, or ask them for a new one.</p>';
    document.getElementById('xp-eyebrow').textContent = 'Monero · link error';
    var foot = document.querySelector('.xp-foot');
    if (foot) foot.style.display = 'none';   // the trust copy talks about the QR; no QR here
    return;
  }

  // ---- header ----
  var label = get('label');
  var amount = get('amount');
  if (label) { setText('xp-label', label); document.title = label + ' · Monero'; }
  if (amount) {
    var amtEl = document.getElementById('xp-amount');
    amtEl.textContent = amount + ' XMR';
    amtEl.hidden = false;
  }

  // ---- build the widget, wire every attribute we were given ----
  var el = document.createElement('xmr-pay');
  if (config) el.setAttribute('config', config);
  else el.setAttribute('address', address);
  // [url-param -> widget attribute]
  var map = [
    ['amount', 'amount'], ['label', 'label'], ['order', 'order'],
    ['verify-url', 'verify-url'], ['verify', 'verify-url'],
    ['status-url', 'status-url'], ['stream-url', 'stream-url'],
    ['redirect-url', 'redirect-url'], ['redirect', 'redirect-url'],
    ['receipt-url', 'receipt-url'], ['verify-page', 'verify-page'],
    ['lang', 'lang'], ['theme', 'theme'], ['skin', 'skin'],
    ['fingerprint', 'fingerprint'], ['pubkey', 'pubkey']
  ];
  for (var i = 0; i < map.length; i++) {
    var v = get(map[i][0]);
    if (v && !el.hasAttribute(map[i][1])) el.setAttribute(map[i][1], v);
  }
  mount.appendChild(el);

  // ---- advisory price-lock countdown ----
  // `expires` (unix SECONDS) wins; else `window` MINUTES from page load (default 30).
  var paid = false;
  var expiresMs = null;
  var expires = parseInt(get('expires'), 10);
  if (isFinite(expires) && expires > 0) {
    expiresMs = expires * 1000;
  } else {
    var win = parseInt(get('window'), 10);
    if (!isFinite(win) || win <= 0) win = 30;
    expiresMs = Date.now() + win * 60 * 1000;
  }

  var timer = document.getElementById('xp-timer');
  var clock = document.getElementById('xp-clock');
  timer.classList.add('show');

  function tick() {
    if (paid) return;
    var left = Math.max(0, Math.floor((expiresMs - Date.now()) / 1000));
    if (left <= 0) {
      timer.classList.add('elapsed');
      timer.lastElementChild.innerHTML = 'Rate window elapsed — the address still works; reload for a current rate';
      clearInterval(iv);
      return;
    }
    var m = Math.floor(left / 60), s = left % 60;
    clock.textContent = (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }
  tick();
  var iv = setInterval(tick, 1000);

  // ---- stop the countdown once the widget reports a confirmed payment ----
  document.addEventListener('xmr-pay:paid', function () {
    paid = true;
    clearInterval(iv);
    timer.classList.remove('elapsed');
    timer.firstElementChild.style.background = '#16a34a';
    timer.lastElementChild.innerHTML = 'Paid';
    setText('xp-eyebrow', 'Monero · paid');
  });

  function setText(id, t) { var e = document.getElementById(id); if (e) e.textContent = t; }
})();
