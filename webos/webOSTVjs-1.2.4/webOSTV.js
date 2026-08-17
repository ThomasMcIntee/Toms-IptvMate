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

  // Back key codes - all possible values on webOS
  var BACK_KEYS = ['Backspace', 'Escape', 'GoBack', 'BrowserBack', 'Back', 'XF86Back', 'Return'];
  var BACK_CODES = [8, 27, 461, 10009];

  function isBackKey(event) {
    var key = String(event.key || '');
    var keyCode = event.keyCode || event.which || 0;
    return BACK_KEYS.indexOf(key) !== -1 || BACK_CODES.indexOf(keyCode) !== -1;
  }

  // PRIMARY Back key handler - runs FIRST before anything else
  // This is registered at document level in capture phase
  function handleBackKey(event) {
    if (!isBackKey(event)) return;
    
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
    // Dispatch back event
    window.dispatchEvent(new CustomEvent('webosBackKey', { bubbles: false }));
  }

  function init() {
    console.log('[webOS SDK] Initializing v1.2.5');
    console.log('[webOS SDK] UA: ' + navigator.userAgent.substring(0, 80));
    
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
