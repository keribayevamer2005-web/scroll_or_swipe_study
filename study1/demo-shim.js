/* ============================================================
 * demo-shim.js
 * ------------------------------------------------------------
 * Makes a study site run as a self-contained demonstration,
 * with no backend server.
 *
 * Background
 * ----------
 * The sites originally asked https://mktresearch.co/php/... which
 * navigation condition to show. That server no longer exists.
 *
 * There is also a fault in the original code of three of the four
 * projects: the request is written as
 *     uni.$post('getcondition', params)
 * but `params` is never declared at that point, so the call raises
 * an error before anything is sent. The condition was therefore
 * never applied through that path, even while the server was alive.
 *
 * How this file works around it
 * -----------------------------
 * The apps read a saved session from browser storage under the key
 * "save_01". When that record exists, they take the condition from
 * it and skip the network entirely. So instead of repairing the
 * broken request, this file writes that record before the app
 * starts, using the condition given in the page address.
 *
 * Any leftover network calls are also pointed at small local JSON
 * files, so nothing tries to reach the dead server.
 *
 * Choosing a condition
 * --------------------
 *   index.html?c=2#/     vertical, finger gesture
 *   index.html?c=0#/     horizontal, finger gesture
 *
 *   0  horizontal + swipe gesture
 *   1  horizontal + tap buttons
 *   2  vertical + scroll gesture
 *   3  vertical + tap buttons
 *
 * Defaults to 2 when nothing is given.
 * ============================================================ */
(function () {
  'use strict';

  var DEFAULT_CONDITION = 2;
  var BACKEND_MARKER = 'mktresearch.co';
  var STORAGE_KEY = 'save_01';

  // ----------------------------------------------------------
  // Which condition was asked for in the address? The check
  // allows it before or after the # part, because the app uses
  // hash based routing and the two can appear in either order.
  // ----------------------------------------------------------
  function readCondition() {
    var m = window.location.href.match(/[?&](?:c|condition)=([0-3])(?:\D|$)/);
    return m ? Number(m[1]) : DEFAULT_CONDITION;
  }

  var condition = readCondition();

  // ----------------------------------------------------------
  // Reset everything the app remembers between visits.
  //
  // All five demonstrations sit on one web address, so they share
  // the same browser storage. Without this, a cart filled in one
  // study reappears in another, and the badge on the photo studies
  // shows a count left over from the shopping task while the
  // collection itself is empty.
  //
  // The list keys are set to an empty list rather than removed.
  // When a key is missing the app falls into its "storage read
  // failed" branch, where the cart is written back before the
  // read has finished, and the counter on the cart icon stops
  // matching its contents. Leaving an empty list in place keeps
  // the app on its normal path.
  // ----------------------------------------------------------
  var LIST_KEYS = [
    'shop_card',          // cart contents
    'shoppingCardList',   // cart contents, second copy
    'user_commdity',      // items the participant chose
    'love_list',          // liked photographs
    'statistics',         // interaction log
    'statisticsALineList',// interaction log, pending batch
  ];
  var DROP_KEYS = ['now_countdown']; // timer state, safe to remove

  try {
    LIST_KEYS.forEach(function (key) {
      localStorage.setItem(key, JSON.stringify({ type: 'object', data: [] }));
    });
    DROP_KEYS.forEach(function (key) {
      localStorage.removeItem(key);
    });
  } catch (e) {
    console.warn('[demo] could not reset previous session:', e);
  }

  // ----------------------------------------------------------
  // Write the session record the app expects.
  //
  // uni-app stores values as {"type":"object","data":{...}}, so the
  // record has to be wrapped the same way or the app will not
  // recognise it. Writing it fresh on every load means the address
  // always decides the condition.
  // ----------------------------------------------------------
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        type: 'object',
        data: {
          _id: 'demo-' + Date.now(),
          condition: condition,
        },
      })
    );
  } catch (e) {
    console.warn('[demo] could not write session record:', e);
  }

  // ----------------------------------------------------------
  // Point any remaining backend calls at local files, so nothing
  // waits on a server that is not there.
  // ----------------------------------------------------------
  var basePath = window.location.pathname.replace(/[^/]*$/, '');

  function localFileFor(url) {
    if (url.indexOf('getcondition') !== -1) {
      return basePath + 'api/condition-' + condition + '.json';
    }
    return basePath + 'api/ok.json'; // logging calls: accept and discard
  }

  function isBackendCall(url) {
    return typeof url === 'string' && url.indexOf(BACKEND_MARKER) !== -1;
  }

  // The method is switched to GET because static hosting will not
  // accept POST for a plain file.
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isBackendCall(url)) {
      var rest = Array.prototype.slice.call(arguments, 2);
      return open.apply(this, ['GET', localFileFor(url)].concat(rest));
    }
    return open.apply(this, arguments);
  };

  if (window.fetch) {
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      if (!isBackendCall(url)) return nativeFetch(input, init);
      return nativeFetch(localFileFor(url), { method: 'GET' });
    };
  }

  var layout = condition === 0 || condition === 1 ? 'horizontal' : 'vertical';
  var control = condition === 0 || condition === 2 ? 'gesture' : 'buttons';
  console.log('[demo] condition ' + condition + ': ' + layout + ', ' + control);

  // ----------------------------------------------------------
  // Catch the jump to the survey site.
  //
  // When the participant confirmed their choices, the task site
  // sent them on to a separate survey website on the old domain,
  // through a fixed address written into the code. That domain is
  // gone, so the browser lands on an error page and the demo
  // appears to stop working.
  //
  // Only the task half is published here, so instead of following
  // that jump we stay on the page and show a short closing notice.
  // ----------------------------------------------------------
  function showEndNotice() {
    if (document.getElementById('demo-end-notice')) return;

    var veil = document.createElement('div');
    veil.id = 'demo-end-notice';
    veil.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:rgba(255,255,255,.97)',
      'display:flex', 'align-items:center', 'justify-content:center',
      'padding:28px', 'text-align:center',
      'font-family:-apple-system,"Segoe UI",Roboto,Arial,sans-serif',
    ].join(';'));

    var box = document.createElement('div');
    box.setAttribute('style', 'max-width:340px;color:#1a1a1a');
    box.innerHTML =
      '<div style="font-size:17px;font-weight:600;margin-bottom:10px">' +
        'End of the task' +
      '</div>' +
      '<div style="font-size:14px;line-height:1.55;color:#444">' +
        'In the original study, participants were taken to a separate ' +
        'survey website at this point. This demonstration covers the ' +
        'browsing task only.' +
      '</div>' +
      '<div style="margin-top:20px">' +
        '<a href="../index.html" style="display:inline-block;padding:10px 18px;' +
        'border:1px solid #ccd;border-radius:8px;text-decoration:none;' +
        'color:#0b4f9e;font-size:14px;background:#fafcff">Back to all studies</a>' +
      '</div>';

    veil.appendChild(box);
    document.body.appendChild(veil);
  }

  // location.href is assigned directly in the page code, so the
  // property itself is replaced with one that checks the address.
  try {
    var realLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      get: function () { return realLocation; },
      set: function (value) {
        if (isBackendCall(String(value))) {
          showEndNotice();
          return;
        }
        realLocation.href = value;
      },
    });
  } catch (e) {
    /* some browsers refuse to redefine location; the guard below still helps */
  }

  // Same guard for location.href, which is the form actually used.
  try {
    var hrefDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
    if (hrefDescriptor && hrefDescriptor.set) {
      Object.defineProperty(Location.prototype, 'href', {
        configurable: true,
        get: hrefDescriptor.get,
        set: function (value) {
          if (isBackendCall(String(value))) {
            showEndNotice();
            return;
          }
          hrefDescriptor.set.call(this, value);
        },
      });
    }
  } catch (e) {
    /* nothing further to try */
  }
})();
