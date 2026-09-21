// Render and update the merchant checkout.
(function () {
  'use strict';

  var query = new URLSearchParams(location.search);
  var hash = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  var get = function (k) { var v = hash.get(k); return (v === null ? query.get(k) : v); };

  var mount = document.getElementById('xp-mount');
  var address = (get('address') || '').trim();
  var config = (get('config') || '').trim();

  var addressLooksValid = /^[1-9A-HJ-NP-Za-km-z]{95,106}$/.test(address);
  if (!config && !addressLooksValid) {
    mount.innerHTML = '<p class="xp-broken"><b>This payment link looks incomplete.</b> Please go back and open the full link your merchant sent you, or ask them for a new one.</p>';
    document.getElementById('xp-eyebrow').textContent = 'Monero · link error';
    var foot = document.querySelector('.xp-foot');
    if (foot) foot.style.display = 'none';
    return;
  }

  var label = get('label');
  var amount = get('amount');
  if (label) { setText('xp-label', label); document.title = label + ' · Monero'; }
  if (amount) {
    var amtEl = document.getElementById('xp-amount');
    amtEl.textContent = amount + ' XMR';
    amtEl.hidden = false;
  }

  var el = document.createElement('xmr-pay');
  if (config) el.setAttribute('config', config);
  else el.setAttribute('address', address);

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
