package tv.toms.iptvmate;

import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

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
            
            // Some devices need this to register mouse clicks properly
            webView.setOnHoverListener((v, event) -> false);

            // Allow Mixed Content (HTTP resources on HTTPS page)
            // This is critical for IPTV apps where APIs often use insecure HTTP.
            WebSettings settings = webView.getSettings();
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            
            // Critical for video playback from different origins
            settings.setAllowUniversalAccessFromFileURLs(true);
            settings.setAllowFileAccessFromFileURLs(true);
            settings.setMediaPlaybackRequiresUserGesture(false);
            
            // Many IPTV providers require a custom or standard browser User-Agent
            // Defaulting to a standard Chrome UA can help.
            settings.setUserAgentString("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
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
