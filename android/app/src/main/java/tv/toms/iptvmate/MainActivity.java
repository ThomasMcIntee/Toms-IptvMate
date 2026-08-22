package tv.toms.iptvmate;

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

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "IPTVMate_Native";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
            
            // Standard Fire TV 4K User-Agent
            settings.setUserAgentString("Mozilla/5.0 (Linux; Android 9; AFTKM Build/PS7279) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36");

            // Setup the Native IPTV Relay
            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    if (url.contains("/__stream?url=")) {
                        String targetUrl = "";
                        try {
                            targetUrl = url.substring(url.indexOf("url=") + 4);
                            targetUrl = URLDecoder.decode(targetUrl, "UTF-8");
                            
                            Log.d(TAG, "Relaying: " + targetUrl);
                            
                            HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
                            conn.setRequestMethod("GET");
                            conn.setInstanceFollowRedirects(true);
                            conn.setConnectTimeout(15000);
                            conn.setReadTimeout(15000);
                            
                            // Use a standard Android Native UA for the stream fetch
                            conn.setRequestProperty("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 9; AFTKM Build/PS7279)");
                            
                            // Pass through Range header for the player
                            String range = request.getRequestHeaders().get("Range");
                            if (range != null) {
                                conn.setRequestProperty("Range", range);
                            }

                            int status = conn.getResponseCode();
                            
                            // Follow redirects manually (up to 5 hops)
                            int redirectCount = 0;
                            while ((status == 301 || status == 302 || status == 307 || status == 308) && redirectCount < 5) {
                                String newUrl = conn.getHeaderField("Location");
                                if (newUrl == null) break;
                                Log.d(TAG, "Redirect: " + newUrl);
                                conn = (HttpURLConnection) new URL(newUrl).openConnection();
                                conn.setRequestMethod("GET");
                                conn.setRequestProperty("User-Agent", "Dalvik/2.1.0 (Linux; U; Android 9; AFTKM Build/PS7279)");
                                if (range != null) conn.setRequestProperty("Range", range);
                                status = conn.getResponseCode();
                                redirectCount++;
                            }

                            InputStream is = conn.getInputStream();
                            String mimeType = conn.getContentType();
                            
                            // Critical: Ensure the player knows this is a video stream
                            if (mimeType == null || mimeType.contains("text/plain") || mimeType.contains("octet-stream")) {
                                if (targetUrl.toLowerCase().contains(".ts")) mimeType = "video/mp2t";
                                else if (targetUrl.toLowerCase().contains(".m3u8")) mimeType = "application/vnd.apple.mpegurl";
                                else mimeType = "video/mpeg";
                            }
                            
                            Map<String, String> responseHeaders = new HashMap<>();
                            responseHeaders.put("Access-Control-Allow-Origin", "*");
                            responseHeaders.put("Access-Control-Allow-Methods", "GET, OPTIONS, HEAD");
                            responseHeaders.put("Access-Control-Allow-Headers", "*");
                            
                            // Pass through content details
                            String contentLength = conn.getHeaderField("Content-Length");
                            if (contentLength != null) responseHeaders.put("Content-Length", contentLength);
                            
                            String contentRange = conn.getHeaderField("Content-Range");
                            if (contentRange != null) responseHeaders.put("Content-Range", contentRange);

                            WebResourceResponse response = new WebResourceResponse(mimeType, conn.getContentEncoding(), is);
                            response.setResponseHeaders(responseHeaders);
                            
                            if (status == 206) {
                                response.setStatusCodeAndReasonPhrase(206, "Partial Content");
                            } else if (status >= 200 && status < 300) {
                                response.setStatusCodeAndReasonPhrase(200, "OK");
                            } else {
                                response.setStatusCodeAndReasonPhrase(status, "Stream Error");
                            }
                            
                            return response;
                        } catch (Exception e) {
                            Log.e(TAG, "Relay Error for " + targetUrl, e);
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
