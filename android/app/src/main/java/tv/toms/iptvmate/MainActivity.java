package tv.toms.iptvmate;

import android.os.Bundle;
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
            // Force the WebView to be focusable and clickable
            webView.setFocusable(true);
            webView.setFocusableInTouchMode(true);
            webView.setClickable(true);
            
            // Prevent native focus navigation from leaving the WebView
            webView.setDescendantFocusability(WebView.FOCUS_AFTER_DESCENDANTS);
            
            // Explicitly request focus
            webView.requestFocus();
            
            // Force hardware acceleration for video rendering
            webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
            
            // Some devices need this to register mouse clicks properly
            webView.setOnHoverListener((v, event) -> false);

            // Allow Mixed Content (HTTP resources on HTTPS page)
            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            
            // Critical for video playback and data storage
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setDatabaseEnabled(true);
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            
            // Standard Fire TV 4K User-Agent to bypass provider blocks.
            // This identifies the device as a standard media player.
            settings.setUserAgentString("Mozilla/5.0 (Linux; Android 9; AFTKM Build/PS7279) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.114 Mobile Safari/537.36");

            // Setup the Native IPTV Relay to bypass CORS
            webView.setWebViewClient(new BridgeWebViewClient(getBridge()) {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    String url = request.getUrl().toString();
                    if (url.contains("/__stream?url=")) {
                        try {
                            String targetUrl = url.substring(url.indexOf("url=") + 4);
                            targetUrl = URLDecoder.decode(targetUrl, "UTF-8");
                            
                            HttpURLConnection conn = (HttpURLConnection) new URL(targetUrl).openConnection();
                            conn.setRequestMethod("GET");
                            // Pass through standard headers to the IPTV provider
                            conn.setRequestProperty("User-Agent", "VLC/3.0.11 LibVLC/3.0.11");
                            
                            InputStream is = conn.getInputStream();
                            String mimeType = conn.getContentType();
                            if (mimeType == null) mimeType = "video/mp2t";
                            
                            // Check if this is an HLS manifest - if so, rewrite relative URLs
                            if (mimeType.contains("mpegurl") || targetUrl.toLowerCase().endsWith(".m3u8")) {
                                java.util.Scanner scanner = new java.util.Scanner(is, "UTF-8").useDelimiter("\\A");
                                String manifest = scanner.hasNext() ? scanner.next() : "";
                                scanner.close();
                                
                                // Rewrite relative URLs to absolute URLs wrapped in proxy
                                String[] lines = manifest.split("\\r?\\n");
                                StringBuilder rewritten = new StringBuilder();
                                java.net.URI baseUri = new java.net.URI(targetUrl);
                                
                                for (String line : lines) {
                                    String trimmed = line.trim();
                                    // Skip comments and empty lines
                                    if (trimmed.isEmpty() || trimmed.startsWith("#")) {
                                        rewritten.append(line).append("\n");
                                    } else {
                                        // This is a segment URL - resolve it relative to the manifest
                                        java.net.URI segmentUri = baseUri.resolve(trimmed);
                                        String absoluteUrl = segmentUri.toString();
                                        // Wrap in proxy URL
                                        String proxiedUrl = "/__stream?url=" + 
                                            java.net.URLEncoder.encode(absoluteUrl, "UTF-8");
                                        rewritten.append(proxiedUrl).append("\n");
                                    }
                                }
                                
                                byte[] manifestBytes = rewritten.toString().getBytes("UTF-8");
                                java.io.ByteArrayInputStream manifestStream = 
                                    new java.io.ByteArrayInputStream(manifestBytes);
                                
                                WebResourceResponse response = new WebResourceResponse(
                                    "application/vnd.apple.mpegurl", 
                                    "UTF-8", 
                                    manifestStream
                                );
                                Map<String, String> headers = new HashMap<>();
                                headers.put("Access-Control-Allow-Origin", "*");
                                response.setResponseHeaders(headers);
                                return response;
                            }
                            
                            WebResourceResponse response = new WebResourceResponse(mimeType, conn.getContentEncoding(), is);
                            // Add CORS headers so the browser allows the local response
                            Map<String, String> headers = new HashMap<>();
                            headers.put("Access-Control-Allow-Origin", "*");
                            response.setResponseHeaders(headers);
                            
                            return response;
                        } catch (Exception e) {
                            // Silent fail - will fall back to standard load
                            android.util.Log.e("IPTVRelay", "Proxy failed", e);
                        }
                    }
                    return super.shouldInterceptRequest(view, request);
                }
            });
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Ensure WebView is focused when a key is pressed, but don't force dispatch.
        // Forcing dispatch causes recursive loops on some devices.
        WebView webView = getBridge().getWebView();
        if (webView != null && !webView.hasFocus()) {
            webView.requestFocus();
        }
        return super.dispatchKeyEvent(event);
    }
}
