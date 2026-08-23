package tv.toms.iptvmate;

import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
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

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
            webView.requestFocus();
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            webView.setOnHoverListener((v, event) -> false);

            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            
            // Professional Player identity for the browser
            settings.setUserAgentString("Mozilla/5.0 (Linux; Android 9; AFTKM Build/PS7279) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36");

            // Setup the Native Proxy Relay
            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    Uri uri = request.getUrl();
                    String path = uri.getPath();
                    
                    if (path != null && (path.contains("/__stream") || path.contains("/__playlist.m3u8"))) {
                        String targetUrl = uri.getQueryParameter("url");
                        if (targetUrl != null) {
                            try {
                                if (path.contains("/__playlist.m3u8")) {
                                    // Generate a stable HLS manifest that tricks the hardware player
                                    Log.i(TAG, "Generating Virtual HLS for: " + targetUrl);
                                    String segmentUrl = "http://localhost/__stream?url=" + Uri.encode(targetUrl);
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

                                // Native Fetch Logic
                                String method = request.getMethod();
                                Log.i(TAG, "Proxying [" + method + "]: " + targetUrl);
                                
                                HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
                                conn.setRequestMethod(method);
                                conn.setInstanceFollowRedirects(true);
                                conn.setConnectTimeout(25000);
                                conn.setReadTimeout(30000);
                                
                                // Forward ALL request headers (Critical for Range/Seeks in Movies)
                                Map<String, String> requestHeaders = request.getRequestHeaders();
                                for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
                                    String key = header.getKey();
                                    if (!key.equalsIgnoreCase("Host") && !key.equalsIgnoreCase("Origin") && !key.equalsIgnoreCase("Referer")) {
                                        conn.setRequestProperty(key, header.getValue());
                                    }
                                }
                                
                                // Consistent TiviMate identity to bypass provider filters
                                conn.setRequestProperty("User-Agent", "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)");

                                if (method.equalsIgnoreCase("OPTIONS")) {
                                    WebResourceResponse optionsResponse = new WebResourceResponse("text/plain", "UTF-8", null);
                                    Map<String, String> headers = new HashMap<>();
                                    headers.put("Access-Control-Allow-Origin", "*");
                                    headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
                                    headers.put("Access-Control-Allow-Headers", "*");
                                    optionsResponse.setResponseHeaders(headers);
                                    return optionsResponse;
                                }

                                int status = conn.getResponseCode();
                                
                                // Manual Redirect following for reliability
                                int redirects = 0;
                                while ((status == 301 || status == 302 || status == 303 || status == 307 || status == 308) && redirects < 5) {
                                    String loc = conn.getHeaderField("Location");
                                    if (loc == null) break;
                                    Log.i(TAG, "Follow Redirect: " + loc);
                                    conn = (HttpURLConnection) new URL(loc).openConnection();
                                    conn.setRequestMethod(method);
                                    conn.setRequestProperty("User-Agent", "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)");
                                    for (Map.Entry<String, String> header : requestHeaders.entrySet()) {
                                        String k = header.getKey();
                                        if (!k.equalsIgnoreCase("Host") && !k.equalsIgnoreCase("Origin")) {
                                            conn.setRequestProperty(k, header.getValue());
                                        }
                                    }
                                    status = conn.getResponseCode();
                                    redirects++;
                                }

                                InputStream stream;
                                if (status >= 400) {
                                    stream = conn.getErrorStream();
                                } else {
                                    stream = (method.equalsIgnoreCase("HEAD")) ? null : conn.getInputStream();
                                }

                                String contentType = conn.getContentType();
                                if (contentType == null || contentType.contains("text/plain") || contentType.contains("octet-stream")) {
                                    if (targetUrl.toLowerCase().contains(".ts")) contentType = "video/mp2t";
                                    else if (targetUrl.toLowerCase().contains(".m3u8")) contentType = "application/vnd.apple.mpegurl";
                                    else if (targetUrl.toLowerCase().contains(".mp4")) contentType = "video/mp4";
                                    else if (targetUrl.toLowerCase().contains(".mkv")) contentType = "video/x-matroska";
                                    else contentType = "video/mpeg";
                                }
                                
                                WebResourceResponse response = new WebResourceResponse(contentType, conn.getContentEncoding(), stream);
                                
                                Map<String, String> responseHeaders = new HashMap<>();
                                responseHeaders.put("Access-Control-Allow-Origin", "*");
                                responseHeaders.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD");
                                responseHeaders.put("Access-Control-Allow-Headers", "*");
                                
                                // Forward hardware-sync headers back to the player
                                for (Map.Entry<String, java.util.List<String>> header : conn.getHeaderFields().entrySet()) {
                                    String key = header.getKey();
                                    if (key != null) {
                                        if (key.equalsIgnoreCase("Content-Length") || 
                                            key.equalsIgnoreCase("Content-Range") ||
                                            key.equalsIgnoreCase("Accept-Ranges") ||
                                            key.equalsIgnoreCase("Content-Type")) {
                                            responseHeaders.put(key, header.getValue().get(0));
                                        }
                                    }
                                }
                                
                                response.setResponseHeaders(responseHeaders);
                                response.setStatusCodeAndReasonPhrase(status, status == 200 || status == 206 ? "OK" : "Error");
                                
                                return response;
                            } catch (Exception e) {
                                Log.e(TAG, "Relay Error: " + targetUrl, e);
                            }
                        }
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        WebView webView = getBridge().getWebView();
        if (webView != null && !webView.hasFocus()) {
            webView.requestFocus();
        }
        return super.dispatchKeyEvent(event);
    }
}
