package tv.toms.iptvmate;

import android.graphics.Color;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;

/**
 * Fullscreen SurfaceView overlay + in-process ExoPlayer (Activity context for Fire TV HDMI audio).
 */
public class ExoPlayerManager {
    private static final String TAG = "IPTVMate_ExoPlayer";

    public interface JsNotifier {
        void evaluateJs(String script);
    }

    private final MainActivity activity;
    private final JsNotifier jsNotifier;
    private final Handler mainHandler;
    private final NativeExoPlayerController playerController;

    private int sessionId = 0;
    private int activeSessionId = 0;
    private boolean isPlayingNative = false;
    private String pendingPlayUrl = null;
    private int overlayRetryCount = 0;
    private static final int MAX_OVERLAY_RETRIES = 40;

    private FrameLayout overlay;
    private SurfaceView surfaceView;

    public ExoPlayerManager(MainActivity activity, String userAgent, JsNotifier jsNotifier) {
        this.activity = activity;
        this.jsNotifier = jsNotifier;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.playerController = new NativeExoPlayerController(activity, new NativeExoPlayerController.Callback() {
            @Override
            public void onReady(int session) {
                mainHandler.post(() -> {
                    if (session != activeSessionId) return;
                    handleNativePlaybackReady();
                });
            }

            @Override
            public void onError(int session, String message) {
                mainHandler.post(() -> {
                    if (session != activeSessionId) return;
                    handleNativePlaybackError(message);
                });
            }
        });
    }

    public void warmUp() {
        Log.i(TAG, "Warm-up requested (in-process ExoPlayer)");
        runOnMain(null, this::ensureOverlayOnMain);
    }

    public void setBounds(int left, int top, int width, int height) {
        Log.i(TAG, "setBounds ignored — fullscreen overlay");
    }

    public void play(String url) {
        play(url, null);
    }

    public void play(String url, @Nullable Runnable onComplete) {
        if (url == null || url.trim().isEmpty()) {
            if (onComplete != null) onComplete.run();
            return;
        }
        final String trimmed = url.trim();
        final int session = ++sessionId;
        runOnMain(onComplete, () -> {
            activeSessionId = session;
            pendingPlayUrl = trimmed;
            overlayRetryCount = 0;
            isPlayingNative = true;
            Log.i(TAG, "play requested [session=" + session + "]: " + trimmed);
            startPendingPlayOnMain(session);
        });
    }

    public void stop() {
        stop(null);
    }

    public void stop(@Nullable Runnable onComplete) {
        final int session = ++sessionId;
        runOnMain(onComplete, () -> {
            activeSessionId = session;
            pendingPlayUrl = null;
            isPlayingNative = false;
            Log.i(TAG, "Stopping native player [session=" + session + "]");
            stopOnMain();
        });
    }

    private void runOnMain(@Nullable Runnable onComplete, Runnable action) {
        mainHandler.post(() -> {
            try {
                action.run();
            } catch (Exception e) {
                Log.e(TAG, "Native player operation failed", e);
            } finally {
                if (onComplete != null) {
                    onComplete.run();
                }
            }
        });
    }

    private void startPendingPlayOnMain(int session) {
        if (session != activeSessionId || pendingPlayUrl == null) {
            Log.w(TAG, "start aborted — stale session or no pending url");
            return;
        }

        Log.i(TAG, "startPendingPlay attempt " + (overlayRetryCount + 1));
        ensureOverlayOnMain();
        if (overlay == null || surfaceView == null) {
            overlayRetryCount++;
            if (overlayRetryCount >= MAX_OVERLAY_RETRIES) {
                Log.e(TAG, "Overlay not ready after retries — aborting play");
                pendingPlayUrl = null;
                isPlayingNative = false;
                handleNativePlaybackError("Video surface not ready");
                return;
            }
            Log.w(TAG, "Overlay not ready — retry " + overlayRetryCount + "/" + MAX_OVERLAY_RETRIES);
            mainHandler.postDelayed(() -> startPendingPlayOnMain(session), 150);
            return;
        }

        String url = pendingPlayUrl;
        pendingPlayUrl = null;
        silenceWebViewMedia();
        playBoundOnMain(session, url);
    }

    private void playBoundOnMain(int session, String url) {
        if (session != activeSessionId) return;

        Log.i(TAG, "Playing in-process [session=" + session + "]: " + url);
        overlay.setVisibility(View.VISIBLE);
        overlay.bringToFront();
        overlay.setElevation(10000f);
        if (overlay.getParent() instanceof ViewGroup) {
            ((ViewGroup) overlay.getParent()).bringChildToFront(overlay);
        }

        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "document.querySelectorAll('video,audio').forEach(function(el){" +
            "try{el.pause();el.muted=true;el.volume=0;el.removeAttribute('src');if(el.load)el.load();}catch(e){}" +
            "});"
        );

        playerController.attachSurfaceView(surfaceView);
        playerController.play(session, url);
    }

    private void silenceWebViewMedia() {
        AudioManager am = (AudioManager) activity.getSystemService(MainActivity.AUDIO_SERVICE);
        if (am != null) {
            am.setMode(AudioManager.MODE_NORMAL);
        }
    }

    private void stopOnMain() {
        playerController.cancelPrepareTimeout();
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
        jsNotifier.evaluateJs("document.body.classList.remove('native-exo-active');");
        playerController.stop();
    }

    public void release() {
        runOnMain(null, () -> {
            sessionId++;
            activeSessionId = sessionId;
            pendingPlayUrl = null;
            isPlayingNative = false;
            playerController.release();
        });
    }

    public boolean isPlayingNative() {
        return isPlayingNative;
    }

    void handleNativePlaybackReady() {
        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "window.dispatchEvent(new CustomEvent('playerPlaying'));"
        );
    }

    void handleNativePlaybackError(String message) {
        isPlayingNative = false;
        pendingPlayUrl = null;
        String escaped = message != null
            ? message.replace("\\", "\\\\").replace("'", "\\'")
            : "Native playback failed";
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
        jsNotifier.evaluateJs(
            "document.body.classList.remove('native-exo-active');" +
            "window.dispatchEvent(new CustomEvent('playerError'," +
            "{detail:{source:'native-exo',message:'" + escaped + "'}}));"
        );
    }

    private void ensureOverlayOnMain() {
        if (overlay != null && surfaceView != null) return;
        if (activity.isFinishing()) {
            Log.e(TAG, "Activity finishing — cannot create overlay");
            return;
        }

        try {
            ViewGroup parent = resolveOverlayParent();
            if (parent == null) {
                Log.e(TAG, "Unable to find overlay parent");
                return;
            }

            if (overlay != null && overlay.getParent() instanceof ViewGroup) {
                ((ViewGroup) overlay.getParent()).removeView(overlay);
            }

            overlay = new FrameLayout(activity);
            overlay.setBackgroundColor(Color.BLACK);
            overlay.setVisibility(View.GONE);

            surfaceView = new SurfaceView(activity);
            overlay.addView(
                surfaceView,
                new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER
                )
            );

            parent.addView(
                overlay,
                new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            );
            overlay.bringToFront();
            Log.i(TAG, "Native SurfaceView overlay attached to " + parent.getClass().getSimpleName());
        } catch (Exception e) {
            Log.e(TAG, "Failed to attach native overlay", e);
            overlay = null;
            surfaceView = null;
        }
    }

    @Nullable
    private ViewGroup resolveOverlayParent() {
        WebView webView = activity.getBridge().getWebView();
        if (webView != null && webView.getParent() instanceof ViewGroup) {
            return (ViewGroup) webView.getParent();
        }
        View content = activity.findViewById(android.R.id.content);
        if (content instanceof ViewGroup) {
            return (ViewGroup) content;
        }
        return null;
    }
}
