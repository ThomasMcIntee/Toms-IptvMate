package tv.toms.iptvmate;

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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        // Force the entire system to use the TiviMate identity.
        // This ensures playlist login AND stream playback both use the same trusted passport.
        System.setProperty("http.agent", APP_USER_AGENT);

        
        WebView.setWebContentsDebuggingEnabled(true);
        disableSSLVerification();
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
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            setupWebViewFocus();
        }
    }

    private void setupWebViewFocus() {
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setFocusable(true);
            webView.setFocusableInTouchMode(true);
            webView.setClickable(true);
            webView.setDescendantFocusability(WebView.FOCUS_AFTER_DESCENDANTS);
            
            // Required for 4K video hardware layering
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            webView.setBackgroundColor(Color.TRANSPARENT);

            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            
            settings.setUserAgentString(APP_USER_AGENT);

            // Setup the Native Proxy Relay
            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
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
                                String manifest = "#EXTM3U\n" +
                                                 "#EXT-X-VERSION:3\n" +
                                                 "#EXT-X-TARGETDURATION:60\n" +
                                                 "#EXT-X-MEDIA-SEQUENCE:0\n" +
                                                 "#EXTINF:60.0,\n" +
                                                 segmentUrl + "\n" +
                                                 "#EXT-X-ENDLIST";
                                
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
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                String url = webView.getUrl();
                // Standard Exit: If we are on the main menu, close the app immediately.
                if (url != null && (url.endsWith("/") || url.contains("index.html") || url.contains("/#"))) {
                    finish();
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }
}
