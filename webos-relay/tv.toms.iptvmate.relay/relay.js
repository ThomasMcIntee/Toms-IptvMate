/* eslint-disable */
"use strict";

// ES5 only: webOS 4.x ships Node 0.12.
var http = require("http");
var https = require("https");
var urlMod = require("url");
var Service = require("webos-service");

var SERVICE_ID = "tv.toms.iptvmate.relay";
var svc = new Service(SERVICE_ID);

var server = null;
var listenPort = 0;
var activityHeld = null;
var starting = false;
var startWaiters = [];

function log(msg) {
  console.log("[iptvmate-relay] " + msg);
}

function rewriteHttpsToHttp(target) {
  return String(target || "").replace(/^https:\/\//i, "http://");
}

function isHttpsUrl(target) {
  return /^https:\/\//i.test(String(target || ""));
}

function consume(res) {
  res.resume();
}

function looksLikePlaylist(buf) {
  if (!buf || !buf.length) return false;
  var head = buf.slice(0, 16).toString("utf8");
  return head.indexOf("#EXTM3U") === 0;
}

function proxyFetchUrl(target, proxyOrigin) {
  return proxyOrigin + "/?u=" + encodeURIComponent(target);
}

function rewritePlaylist(text, playlistUrl, proxyOrigin) {
  var lines = String(text || "").split(/\r?\n/);
  var out = [];
  var i;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) {
      out.push(line);
      continue;
    }
    if (line.charAt(0) === "#") {
      out.push(
        line.replace(/URI="([^"]+)"/gi, function (_match, uri) {
          var abs = urlMod.resolve(playlistUrl, uri);
          return 'URI="' + proxyFetchUrl(abs, proxyOrigin) + '"';
        })
      );
      continue;
    }
    out.push(proxyFetchUrl(urlMod.resolve(playlistUrl, line), proxyOrigin));
  }
  return out.join("\n");
}

function bufferFromString(text) {
  if (typeof Buffer.from === "function") return Buffer.from(text, "utf8");
  return new Buffer(text, "utf8");
}

function requestOnce(targetUrl, callback) {
  var parsed;
  var settled = false;
  var finish = function (err, res) {
    if (settled) return;
    settled = true;
    callback(err, res);
  };

  try {
    parsed = urlMod.parse(targetUrl);
  } catch (err) {
    finish(err);
    return;
  }

  if (!parsed || !parsed.hostname) {
    finish(new Error("invalid url"));
    return;
  }

  var isHttps = parsed.protocol === "https:";
  var lib = isHttps ? https : http;
  var opts = {
    hostname: parsed.hostname,
    port: parsed.port || (isHttps ? 443 : 80),
    path: parsed.path,
    method: "GET",
    headers: {
      "User-Agent": "VLC/3.0.18 LibVLC/3.0.18",
      Accept: "*/*",
      Connection: "close"
    }
  };

  if (isHttps) {
    opts.rejectUnauthorized = false;
    opts.ciphers = "ALL:!aNULL:!eNULL:!EXPORT";
  }

  var req;
  try {
    req = lib.request(opts, function (res) {
      finish(null, res);
    });
  } catch (err) {
    finish(err);
    return;
  }

  req.on("error", function (err) {
    finish(err);
  });
  if (req.setTimeout) {
    req.setTimeout(15000, function () {
      try {
        req.abort();
      } catch (e) {}
      finish(new Error("timeout"));
    });
  }
  req.end();
}

function fetchFollow(targetUrl, remaining, callback) {
  if (remaining < 0) {
    callback(new Error("too many redirects"));
    return;
  }

  requestOnce(targetUrl, function (err, res) {
    if (err) {
      if (isHttpsUrl(targetUrl)) {
        fetchFollow(rewriteHttpsToHttp(targetUrl), remaining - 1, callback);
        return;
      }
      callback(err);
      return;
    }

    var status = res.statusCode || 0;
    var location = res.headers.location || res.headers.Location;
    if (status >= 300 && status < 400 && location) {
      consume(res);
      var next = urlMod.resolve(targetUrl, location);
      if (isHttpsUrl(next)) {
        fetchFollow(rewriteHttpsToHttp(next), remaining - 1, function (httpErr, httpResult) {
          if (!httpErr && httpResult && httpResult.status < 400) {
            callback(null, httpResult);
            return;
          }
          fetchFollow(next, remaining - 1, callback);
        });
        return;
      }
      fetchFollow(next, remaining - 1, callback);
      return;
    }

    var chunks = [];
    res.on("data", function (chunk) {
      chunks.push(chunk);
    });
    res.on("end", function () {
      callback(null, {
        status: status,
        url: targetUrl,
        headers: res.headers || {},
        body: Buffer.concat(chunks)
      });
    });
    res.on("error", function (readErr) {
      callback(readErr);
    });
  });
}

function originFromPort(port) {
  return "http://127.0.0.1:" + port;
}

function handleProxyRequest(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  var parsed = urlMod.parse(req.url, true);
  var target = parsed.query && parsed.query.u;
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing url");
    return;
  }

  fetchFollow(target, 8, function (err, result) {
    if (err || !result) {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end(String((err && err.message) || err || "fetch failed"));
      return;
    }

    var contentType =
      result.headers["content-type"] || result.headers["Content-Type"] || "application/octet-stream";
    var body = result.body || bufferFromString("");
    if (looksLikePlaylist(body)) {
      body = bufferFromString(
        rewritePlaylist(body.toString("utf8"), result.url, originFromPort(listenPort))
      );
      contentType = "application/vnd.apple.mpegurl";
    }

    res.writeHead(result.status && result.status < 400 ? result.status : 200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store"
    });
    res.end(body);
  });
}

function finishStart(err, port) {
  var waiters = startWaiters;
  startWaiters = [];
  starting = false;
  var i;
  for (i = 0; i < waiters.length; i++) {
    waiters[i](err, port);
  }
}

function ensureServer(callback) {
  if (server && listenPort) {
    callback(null, listenPort);
    return;
  }
  startWaiters.push(callback);
  if (starting) return;
  starting = true;

  try {
    server = http.createServer(handleProxyRequest);
  } catch (err) {
    server = null;
    finishStart(err, 0);
    return;
  }

  server.on("error", function (err) {
    server = null;
    listenPort = 0;
    finishStart(err, 0);
  });

  server.listen(0, "127.0.0.1", function () {
    var addr = server.address();
    listenPort = addr && addr.port ? addr.port : 0;
    log("listening on " + listenPort);
    finishStart(null, listenPort);
  });
}

function holdActivity() {
  if (activityHeld) return;
  try {
    svc.activityManager.create("iptvmate-relay", function (activity) {
      activityHeld = activity;
    });
  } catch (err) {
    log("activity create failed");
  }
}

svc.register("start", function (message) {
  holdActivity();
  ensureServer(function (err, port) {
    if (err || !port) {
      message.respond({
        returnValue: false,
        errorText: String((err && err.message) || err || "listen failed")
      });
      return;
    }
    message.respond({
      returnValue: true,
      origin: originFromPort(port),
      port: port
    });
  });
});

svc.register("ping", function (message) {
  holdActivity();
  message.respond({
    returnValue: true,
    origin: listenPort ? originFromPort(listenPort) : ""
  });
});

svc.register("fetch", function (message) {
  holdActivity();
  var target = message.payload && message.payload.url;
  if (!target || !/^https?:\/\//i.test(String(target))) {
    message.respond({ returnValue: false, errorText: "missing url" });
    return;
  }

  fetchFollow(String(target), 8, function (err, result) {
    if (err || !result) {
      message.respond({
        returnValue: false,
        errorText: String((err && err.message) || err || "fetch failed")
      });
      return;
    }

    var text = (result.body || bufferFromString("")).toString("utf8");
    if (text.length > 900000) {
      message.respond({
        returnValue: false,
        errorText: "body too large for luna fetch",
        status: result.status,
        bytes: text.length
      });
      return;
    }

    message.respond({
      returnValue: true,
      status: result.status,
      url: result.url,
      body: text
    });
  });
});
