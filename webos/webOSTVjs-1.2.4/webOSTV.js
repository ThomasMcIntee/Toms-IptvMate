/**
 * webOSTVjs SDK for Toms IPTVmate
 * Handles Back key interception at the EARLIEST possible point
 */

(function() {
  'use strict';

  // Create webOS namespace
  window.webOS = window.webOS || {};
  window.webOS.platform = { tv: true };
  window.webOS.platformBack = false;
  window.webOS.libVersion = '1.2.5';

  // This file is a local Back-key stub, not LG's full SDK. Packaged apps still
  // get PalmServiceBridge; wrap it so luna:// calls (DB8, JS services) work.
  if (!window.webOS.service || typeof window.webOS.service.request !== 'function') {
    window.webOS.service = {
      request: function (uri, options) {
        options = options || {};
        var Bridge = window.PalmServiceBridge;
        if (typeof Bridge !== 'function') {
          if (options.onFailure) {
            options.onFailure({ returnValue: false, errorText: 'PalmServiceBridge missing' });
          }
          return {};
        }
        var bridge = new Bridge();
        var url = String(uri || '').replace(/\/$/, '') + '/' + String(options.method || '');
        bridge.onservicecallback = function (msg) {
          var res = {};
          try {
            res = typeof msg === 'string' ? JSON.parse(msg) : (msg || {});
          } catch (e) {
            res = { returnValue: false, errorText: String(msg || e) };
          }
          if (res && res.returnValue === false) {
            if (options.onFailure) options.onFailure(res);
          } else if (options.onSuccess) {
            options.onSuccess(res || {});
          }
          if (options.onComplete) options.onComplete(res || {});
        };
        try {
          bridge.call(url, JSON.stringify(options.parameters || {}));
        } catch (err) {
          if (options.onFailure) {
            options.onFailure({ returnValue: false, errorText: String(err) });
          }
        }
        return {
          cancel: function () {
            try {
              if (bridge.cancel) bridge.cancel();
            } catch (e) {}
          }
        };
      }
    };
  }

  // Back key codes - all possible values on webOS
  var BACK_KEYS = ['Backspace', 'Escape', 'GoBack', 'BrowserBack', 'Back', 'XF86Back', 'Return'];
  var BACK_CODES = [8, 27, 461, 10009];
  var keyboardVisible = false;

  function isBackKey(event) {
    var key = String(event.key || '');
    var keyCode = event.keyCode || event.which || 0;
    return BACK_KEYS.indexOf(key) !== -1 || BACK_CODES.indexOf(keyCode) !== -1;
  }

  function isTextEntryElement(el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    var tag = String(el.tagName).toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function isTypingContext(event) {
    if (keyboardVisible) return true;
    if (document.body && document.body.dataset && document.body.dataset.webosKeyboard === 'open') {
      return true;
    }
    if (isTextEntryElement(event && event.target)) return true;
    return isTextEntryElement(document.activeElement);
  }

  function onKeyboardStateChange(event) {
    var detail = event && event.detail;
    keyboardVisible = !!(
      detail &&
      (detail.visibility === true ||
        detail.visibility === 'visible' ||
        detail.state === 'opened' ||
        detail.state === 'visible')
    );
    if (document.body && document.body.dataset) {
      document.body.dataset.webosKeyboard = keyboardVisible ? 'open' : 'closed';
    }
  }

  // PRIMARY Back key handler - runs FIRST before anything else
  // This is registered at document level in capture phase
  function handleBackKey(event) {
    if (!isBackKey(event)) return;

    // Virtual-keyboard Erase/Back must edit text, not leave the form.
    if (isTypingContext(event)) {
      console.log('[webOS SDK] BACK ignored during text entry: ' + event.key + ' code=' + event.keyCode);
      return;
    }
    
    console.log('[webOS SDK] BACK KEY INTERCEPTED: ' + event.key + ' code=' + event.keyCode);
    
    // CRITICAL: Stop this event from reaching webOS system handlers
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    
    // Also try to return false (older browsers)
    event.returnValue = false;
    
    // Dispatch custom event for the React app to handle
    try {
      window.dispatchEvent(new CustomEvent('webosBackKey', {
        detail: { key: event.key, keyCode: event.keyCode },
        bubbles: false,
        cancelable: false
      }));
      console.log('[webOS SDK] webosBackKey event dispatched');
    } catch (e) {
      console.log('[webOS SDK] Failed to dispatch event: ' + e);
    }
    
    return false;
  }

  // History stack to absorb any Back that gets through
  function initHistoryStack() {
    if (window.history && window.history.pushState) {
      for (var i = 0; i < 20; i++) {
        window.history.pushState({ webosNav: i }, '', window.location.href);
      }
      console.log('[webOS SDK] History stack initialized (20 states)');
    }
  }

  function handlePopState(event) {
    console.log('[webOS SDK] popstate triggered');
    // Replenish history
    if (window.history && window.history.pushState) {
      window.history.pushState({ webosNav: Date.now() }, '', window.location.href);
    }
    if (isTypingContext(null)) {
      console.log('[webOS SDK] popstate ignored during text entry');
      return;
    }
    // Dispatch back event
    window.dispatchEvent(new CustomEvent('webosBackKey', { bubbles: false }));
  }

  function init() {
    console.log('[webOS SDK] Initializing v1.2.5');
    console.log('[webOS SDK] UA: ' + navigator.userAgent.substring(0, 80));
    
    document.addEventListener('keyboardStateChange', onKeyboardStateChange);
    
    // Register Back handler at DOCUMENT level with CAPTURE phase
    // This runs before any other handlers
    document.addEventListener('keydown', handleBackKey, true);
    
    // Also on window for double coverage
    window.addEventListener('keydown', handleBackKey, true);
    
    // History stack as backup
    initHistoryStack();
    window.addEventListener('popstate', handlePopState);
    
    console.log('[webOS SDK] Ready - Back key handler registered');
  }

  // Initialize immediately if possible, or on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
