package tv.toms.iptvmate;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Map;

import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "IPTVMate_Native";
    // Universal TiviMate identity - The absolute most trusted identity for IPTV providers.
    private static final String APP_USER_AGENT = "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)";

    private ExoPlayerManager exoPlayerManager;
    private boolean webViewConfigured = false;
    private BroadcastReceiver nativePlayerReceiver;
    private boolean nativePlayerReceiverRegistered = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativePlayerPlugin.class);
        super.onCreate(savedInstanceState);
        
        // Force the entire system to use the TiviMate identity.
        // This ensures playlist login AND stream playback both use the same trusted passport.
        System.setProperty("http.agent", APP_USER_AGENT);

        
        // Chrome remote debugging keeps a socket and metrics process alive.
        WebView.setWebContentsDebuggingEnabled(false);
        disableSSLVerification();
    }

    @Override
    public void onDestroy() {
        unregisterNativePlayerReceiver();
        if (exoPlayerManager != null) {
            exoPlayerManager.release();
            exoPlayerManager = null;
        }
        webViewConfigured = false;
        super.onDestroy();
    }

    private void disableSSLVerification() {
        TrustManager[] trustAllCerts = new TrustManager[] {
            new X509TrustManager() {
                public X509Certificate[] getAcceptedIssuers() { return null; }
                public void checkClientTrusted(X509Certificate[] certs, String authType) {}
                public void checkServerTrusted(X509Certificate[] certs, String authType) {}
            }
        };

        try {
            SSLContext sc = SSLContext.getInstance("SSL");
            sc.init(null, trustAllCerts, new java.security.SecureRandom());
            HttpsURLConnection.setDefaultSSLSocketFactory(sc.getSocketFactory());
            HttpsURLConnection.setDefaultHostnameVerifier((hostname, session) -> true);
        } catch (Exception e) {
            Log.e(TAG, "SSL Bypass Failed", e);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        setupWebViewFocus();
        registerNativePlayerReceiver();
    }

    @Override
    public void onPause() {
        pauseWebView();
        super.onPause();
    }

    @Override
    public void onResume() {
        super.onResume();
        resumeWebView();
    }

    @Override
    public void onStop() {
        unregisterNativePlayerReceiver();
        super.onStop();
    }

    private WebView getActivityWebView() {
        try {
            if (getBridge() == null) return null;
            return getBridge().getWebView();
        } catch (Exception ignored) {
            return null;
        }
    }

    private void pauseWebView() {
        WebView webView = getActivityWebView();
        if (webView != null) {
            webView.onPause();
        }
    }

    private void resumeWebView() {
        WebView webView = getActivityWebView();
        if (webView != null) {
            webView.onResume();
        }
    }

    private void registerNativePlayerReceiver() {
        if (nativePlayerReceiverRegistered) return;

        nativePlayerReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (intent == null || exoPlayerManager == null) return;

                String action = intent.getAction();
                if (NativePlayerEvents.ACTION_READY.equals(action)) {
                    exoPlayerManager.handleNativePlaybackReady();
                } else if (NativePlayerEvents.ACTION_ERROR.equals(action)) {
                    exoPlayerManager.handleNativePlaybackError(
                        intent.getStringExtra(NativePlayerEvents.EXTRA_MESSAGE)
                    );
                } else if (NativePlayerEvents.ACTION_STOPPED.equals(action)) {
                    exoPlayerManager.handleNativePlaybackStopped();
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction(NativePlayerEvents.ACTION_READY);
        filter.addAction(NativePlayerEvents.ACTION_ERROR);
        filter.addAction(NativePlayerEvents.ACTION_STOPPED);
        registerReceiver(nativePlayerReceiver, filter);
        nativePlayerReceiverRegistered = true;
    }

    private void unregisterNativePlayerReceiver() {
        if (!nativePlayerReceiverRegistered || nativePlayerReceiver == null) return;
        try {
            unregisterReceiver(nativePlayerReceiver);
        } catch (Exception ignored) {
            // Receiver may already be unregistered.
        }
        nativePlayerReceiver = null;
        nativePlayerReceiverRegistered = false;
    }

    private void setupWebViewFocus() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.setClickable(true);
        webView.setDescendantFocusability(WebView.FOCUS_AFTER_DESCENDANTS);
        // NONE during boot uses less GPU memory on Fire TV; ExoPlayerManager switches
        // to hardware when native playback starts.
        webView.setLayerType(View.LAYER_TYPE_NONE, null);
        webView.setBackgroundColor(Color.BLACK);

        WebSettings settings = webView.getSettings();
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setOffscreenPreRaster(false);
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(APP_USER_AGENT);

        if (webViewConfigured) {
            return;
        }
        webViewConfigured = true;

        // Setup the Native Proxy Relay once — re-attaching on every focus change leaks memory.
        webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    handler.proceed();
                }

                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    String path = uri.getPath();
                    
                    if (path != null && (path.contains("/__stream") || path.contains("/__playlist"))) {
                        String targetUrl = uri.getQueryParameter("url");
                        if (targetUrl == null) return null;
                        
                        try {
                            if (path.contains("/__playlist")) {
                                Log.i(TAG, "Relay: Virtual HLS for: " + targetUrl);
                                // Stay on the 'app' hostname to avoid cross-origin protocol blocks
                                String segmentUrl = "http://app/__stream?url=" + Uri.encode(targetUrl);
                                boolean isLiveTs = targetUrl.toLowerCase().contains(".ts");
                                String manifest = "#EXTM3U\n" +
                                                 "#EXT-X-VERSION:3\n" +
                                                 "#EXT-X-TARGETDURATION:60\n" +
                                                 "#EXT-X-MEDIA-SEQUENCE:0\n";
                                if (isLiveTs) {
                                    manifest += "#EXT-X-PLAYLIST-TYPE:EVENT\n";
                                }
                                manifest += "#EXTINF:60.0,\n" +
                                            segmentUrl + "\n";
                                if (!isLiveTs) {
                                    manifest += "#EXT-X-ENDLIST";
                                }
                                
                                InputStream is = new ByteArrayInputStream(manifest.getBytes("UTF-8"));
                                WebResourceResponse resp = new WebResourceResponse("application/vnd.apple.mpegurl", "UTF-8", is);
                                Map<String, String> headers = new HashMap<>();
                                headers.put("Access-Control-Allow-Origin", "*");
                                resp.setResponseHeaders(headers);
                                return resp;
                            }

                            // Perform the real fetch on behalf of the player
                            String method = request.getMethod();
                            Log.i(TAG, "Relay: Fetching [" + method + "]: " + targetUrl);
                            
                            HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
                            conn.setRequestMethod(method);
                            conn.setInstanceFollowRedirects(true);
                            conn.setConnectTimeout(25000);
                            conn.setReadTimeout(30000);
                            
                            conn.setRequestProperty("User-Agent", APP_USER_AGENT);
                            
                            Map<String, String> requestHeaders = request.getRequestHeaders();
                            for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
                                String key = header.getKey();
                                if (key.equalsIgnoreCase("Range")) {
                                    conn.setRequestProperty(key, header.getValue());
                                }
                            }

                            int status = conn.getResponseCode();
                            int redirects = 0;
                            while ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308) && redirects < 5) {
                                String loc = conn.getHeaderField("Location");
                                if (loc == null) break;
                                conn = (HttpURLConnection) new URL(loc).openConnection();
                                conn.setRequestMethod(method);
                                conn.setRequestProperty("User-Agent", APP_USER_AGENT);
                                status = conn.getResponseCode();
                                redirects++;
                            }

                            InputStream stream;
                            if (status >= 400) stream = conn.getErrorStream();
                            else stream = (method.equalsIgnoreCase("HEAD")) ? null : conn.getInputStream();

                            String contentType = conn.getContentType();
                            if (contentType == null || contentType.contains("text/plain") || contentType.contains("octet-stream")) {
                                if (targetUrl.toLowerCase().contains(".ts")) contentType = "video/mp2t";
                                else if (targetUrl.toLowerCase().contains(".m3u8")) contentType = "application/vnd.apple.mpegurl";
                                else contentType = "video/mpeg";
                            }
                            
                            WebResourceResponse response = new WebResourceResponse(contentType, conn.getContentEncoding(), stream);
                            Map<String, String> responseHeaders = new HashMap<>();
                            responseHeaders.put("Access-Control-Allow-Origin", "*");
                            responseHeaders.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
                            responseHeaders.put("Access-Control-Allow-Headers", "*");
                            
                            for (Map.Entry<String, java.util.List<String>> header : conn.getHeaderFields().entrySet()) {
                                String key = header.getKey();
                                if (key != null && (key.equalsIgnoreCase("Content-Length") || 
                                                  key.equalsIgnoreCase("Content-Range") ||
                                                  key.equalsIgnoreCase("Accept-Ranges"))) {
                                    responseHeaders.put(key, header.getValue().get(0));
                                }
                            }
                            
                            response.setResponseHeaders(responseHeaders);
                            response.setStatusCodeAndReasonPhrase(status, status == 200 || status == 206 ? "OK" : "Error");
                            return response;
                        } catch (Exception e) {
                            Log.e(TAG, "Proxy Error: " + targetUrl, e);
                        }
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });
    }

    public ExoPlayerManager getOrCreateExoPlayerManager() {
        if (exoPlayerManager == null) {
            WebView webView = getBridge().getWebView();
            exoPlayerManager = new ExoPlayerManager(
                this,
                APP_USER_AGENT,
                script -> {
                    if (webView != null) {
                        webView.post(() -> webView.evaluateJavascript(script, null));
                    }
                }
            );
        }
        return exoPlayerManager;
    }

    private long lastBackDispatchMs = 0;

    private void dispatchBackKeyToWebApp() {
        long now = System.currentTimeMillis();
        if (now - lastBackDispatchMs < 250) return;
        lastBackDispatchMs = now;

        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        webView.post(() -> webView.evaluateJavascript(
            "(function(){" +
            "var e=new KeyboardEvent('keydown',{" +
            "key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true" +
            "});" +
            "window.dispatchEvent(e);" +
            "})();",
            null
        ));
    }

    @Override
    public void onBackPressed() {
        dispatchBackKeyToWebApp();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            dispatchBackKeyToWebApp();
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
