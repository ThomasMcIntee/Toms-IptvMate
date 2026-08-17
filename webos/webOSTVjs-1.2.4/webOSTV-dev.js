/**
 * webOSTV-dev.js - Development helpers (minimal stub)
 * Not needed for production but included for compatibility
 */

(function() {
  'use strict';
  
  window.webOS = window.webOS || {};
  window.webOS.dev = {
    log: function(msg) {
      console.log('[webOS Dev]', msg);
    }
  };
})();
