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

import androidx.coordinatorlayout.widget.CoordinatorLayout;
import androidx.media3.ui.PlayerView;

/**
 * Bounded PlayerView overlay + in-process ExoPlayer (Activity context for Fire TV HDMI audio).
 *
 * Place the overlay AFTER the WebView in the view tree so SurfaceView's default
 * hole-punch is visible in the preview rect. Do not hide the WebView, and do not
 * call setZOrderMediaOverlay — that reboots Fire TV's compositor.
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

    private boolean isPlayingNative = false;

    private FrameLayout overlay;
    private PlayerView playerView;

    private int boundLeft;
    private int boundTop;
    private int boundWidth;
    private int boundHeight;
    private boolean hasBounds;
    private boolean playIsLive = true;

    public ExoPlayerManager(MainActivity activity, String userAgent, JsNotifier jsNotifier) {
        this.activity = activity;
        this.jsNotifier = jsNotifier;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.playerController = new NativeExoPlayerController(activity, new NativeExoPlayerController.Callback() {
            @Override
            public void onReady() {
                mainHandler.post(ExoPlayerManager.this::handleNativePlaybackReady);
            }

            @Override
            public void onError(String message) {
                mainHandler.post(() -> handleNativePlaybackError(message));
            }

            @Override
            public void onStopped() {
                mainHandler.post(ExoPlayerManager.this::handleNativePlaybackStopped);
            }

            @Override
            public void onEnded() {
                mainHandler.post(ExoPlayerManager.this::handleNativePlaybackEnded);
            }
        });
    }

    public void warmUp() {
        Log.i(TAG, "Warm-up requested (in-process ExoPlayer)");
    }

    public void setBounds(int left, int top, int width, int height) {
        setBounds(left, top, width, height, 0, 0);
    }

    public void setBounds(int left, int top, int width, int height, int cssViewportWidth, int cssViewportHeight) {
        runOnMain(() -> {
            // Keep JS bounds only as a fullscreen hint. Compact live preview is
            // pinned to the WebView's top-right in applyBoundsOnMain — Fire TV's
            // CSS pixel space (e.g. 413,20 560x315) maps to the center of a
            // 1920px activity when scale is 1.0.
            boundLeft = Math.max(0, left);
            boundTop = Math.max(0, top);
            boundWidth = Math.max(1, width);
            boundHeight = Math.max(1, height);
            hasBounds = boundWidth >= 2 && boundHeight >= 2;
            Log.i(TAG, "setBounds css=" + left + "," + top + " " + width + "x" + height
                + " viewport=" + cssViewportWidth + "x" + cssViewportHeight);
            applyBoundsOnMain();
        });
    }

    public void play(String url) {
        // Legacy entry point — treated as live (matches original behavior).
        play(url, true);
    }

    public void play(String url, boolean isLive) {
        if (url == null || url.trim().isEmpty()) return;

        final String trimmed = url.trim();
        runOnMain(() -> {
            try {
                isPlayingNative = true;
                playIsLive = isLive;
                ensureOverlayOnMain();
                if (overlay != null) {
                    overlay.bringToFront();
                }
                applyBoundsOnMain();
                silenceWebViewMedia();
                playBound(trimmed, isLive);
                requestJsBoundsOnMain();
            } catch (RuntimeException e) {
                Log.e(TAG, "play failed on main thread", e);
                handleNativePlaybackError("Failed to start native playback");
            }
        });
    }

    public void pause() {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            playerController.pause();
        });
    }

    public void resume() {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            playerController.resume();
        });
    }

    public void setMuted(boolean muted) {
        runOnMain(() -> playerController.setMuted(muted));
    }

    private void playBound(String url, boolean isLive) {
        Log.i(TAG, "Playing in-process: " + url + " isLive=" + isLive);
        if (overlay != null) {
            overlay.setVisibility(View.VISIBLE);
            overlay.bringToFront();
        }
        configureSurfaceZOrderOnMain();

        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "document.querySelectorAll('video,audio').forEach(function(el){" +
            "try{el.pause();el.muted=true;el.volume=0;el.removeAttribute('src');if(el.load)el.load();}catch(e){}" +
            "});"
        );

        playerController.play(url, isLive);
    }

    private void silenceWebViewMedia() {
        AudioManager am = (AudioManager) activity.getSystemService(MainActivity.AUDIO_SERVICE);
        if (am != null) {
            am.setMode(AudioManager.MODE_NORMAL);
        }
    }

    private void hideNativeSurface() {
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
    }

    public void stop() {
        runOnMain(() -> {
            if (!isPlayingNative) return;

            isPlayingNative = false;
            Log.i(TAG, "Stopping native player");

            if (overlay != null) {
                overlay.setVisibility(View.GONE);
            }
            jsNotifier.evaluateJs(
                "document.body.classList.remove('native-exo-active');" +
                "document.body.classList.remove('native-exo-vod');"
            );
            playerController.stop();
        });
    }

    public void release() {
        runOnMain(() -> {
            isPlayingNative = false;
            if (overlay != null) {
                overlay.setVisibility(View.GONE);
            }
            jsNotifier.evaluateJs(
                "document.body.classList.remove('native-exo-active');" +
                "document.body.classList.remove('native-exo-vod');"
            );
            playerController.release();
        });
    }

    private void runOnMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
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
        String escaped = message != null
            ? message.replace("\\", "\\\\").replace("'", "\\'")
            : "Native playback failed";
        mainHandler.post(this::hideNativeSurface);
        jsNotifier.evaluateJs(
            "document.body.classList.remove('native-exo-active');" +
            "document.body.classList.remove('native-exo-vod');" +
            "window.dispatchEvent(new CustomEvent('playerError'," +
            "{detail:{source:'native-exo',message:'" + escaped + "'}}));"
        );
    }

    void handleNativePlaybackStopped() {
        if (isPlayingNative) return;
        mainHandler.post(this::hideNativeSurface);
        jsNotifier.evaluateJs(
            "document.body.classList.remove('native-exo-active');" +
            "document.body.classList.remove('native-exo-vod');"
        );
    }

    void handleNativePlaybackEnded() {
        // Keep the overlay on the last frame; JS decides what happens next
        // (e.g. series auto-advance to the next episode).
        jsNotifier.evaluateJs("window.dispatchEvent(new CustomEvent('playerEnded'));");
    }

    private void ensureOverlayOnMain() {
        if (overlay != null) return;

        WebView webView = activity.getBridge().getWebView();
        if (webView == null) {
            throw new IllegalStateException("WebView missing; cannot attach native player");
        }

        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent == null) {
            throw new IllegalStateException("WebView parent missing; cannot attach native player");
        }

        overlay = (FrameLayout) activity.getLayoutInflater()
            .inflate(R.layout.native_exo_overlay, parent, false);
        overlay.setVisibility(View.GONE);
        overlay.setClickable(false);
        overlay.setFocusable(false);
        overlay.setFocusableInTouchMode(false);

        playerView = overlay.findViewById(R.id.native_exo_player_view);
        if (playerView == null) {
            throw new IllegalStateException("native_exo_player_view missing from overlay layout");
        }
        playerView.setUseController(false);
        playerView.setKeepContentOnPlayerReset(true);
        playerView.setShutterBackgroundColor(Color.BLACK);
        playerView.setKeepScreenOn(true);
        playerView.setClickable(false);
        playerView.setFocusable(false);
        playerView.setFocusableInTouchMode(false);
        playerController.attachPlayerView(playerView);
        configureSurfaceZOrderOnMain();

        // Overlay must sit AFTER the WebView so the hole-punch is not covered by
        // Chromium's own surface. Behind-WebView placement yields audio-only
        // (SurfaceFlinger drops every decoded frame).
        int insertAt = parent.indexOfChild(webView) + 1;
        if (insertAt < 1) {
            insertAt = parent.getChildCount();
        }
        parent.addView(overlay, insertAt, createOverlayLayoutParams(parent, 1, 1));
        applyBoundsOnMain();
        Log.i(TAG, "Native PlayerView overlay attached");
    }

    private void applyBoundsOnMain() {
        if (overlay == null) return;

        ViewGroup parent = (ViewGroup) overlay.getParent();
        ViewGroup.LayoutParams raw = overlay.getLayoutParams();
        ViewGroup.MarginLayoutParams lp;
        if (raw instanceof ViewGroup.MarginLayoutParams) {
            lp = (ViewGroup.MarginLayoutParams) raw;
        } else {
            lp = parent != null
                ? createOverlayLayoutParams(parent, boundWidth, boundHeight)
                : new FrameLayout.LayoutParams(boundWidth, boundHeight);
        }

        WebView webView = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
        int hostWidth = webView != null && webView.getWidth() > 0
            ? webView.getWidth()
            : (parent != null ? parent.getWidth() : 0);
        int hostHeight = webView != null && webView.getHeight() > 0
            ? webView.getHeight()
            : (parent != null ? parent.getHeight() : 0);

        boolean jsLooksFullscreen = hasBounds
            && hostWidth > 0
            && boundWidth >= (int) (hostWidth * 0.85f)
            && boundHeight >= (int) (hostHeight * 0.70f);

        if (!playIsLive || jsLooksFullscreen) {
            lp.width = ViewGroup.LayoutParams.MATCH_PARENT;
            lp.height = ViewGroup.LayoutParams.MATCH_PARENT;
            lp.leftMargin = 0;
            lp.topMargin = 0;
            lp.rightMargin = 0;
            lp.bottomMargin = 0;
            Log.i(TAG, "applyBounds fullscreen isLive=" + playIsLive);
        } else if (hostWidth >= 2 && hostHeight >= 2) {
            float density = activity.getResources().getDisplayMetrics().density;
            int margin = Math.max(12, Math.round(16 * density));
            int previewWidth = Math.max(280, Math.round(hostWidth * 0.38f));
            int previewHeight = Math.max(158, Math.round(previewWidth * 9f / 16f));
            if (previewWidth + margin * 2 > hostWidth) {
                previewWidth = Math.max(240, hostWidth - margin * 2);
                previewHeight = Math.round(previewWidth * 9f / 16f);
            }
            lp.width = previewWidth;
            lp.height = previewHeight;
            lp.leftMargin = Math.max(0, hostWidth - previewWidth - margin);
            lp.topMargin = margin;
            lp.rightMargin = 0;
            lp.bottomMargin = 0;
            Log.i(TAG, "applyBounds live-preview " + lp.leftMargin + "," + lp.topMargin
                + " " + previewWidth + "x" + previewHeight + " host=" + hostWidth + "x" + hostHeight);
        } else if (hasBounds) {
            lp.width = boundWidth;
            lp.height = boundHeight;
            lp.leftMargin = boundLeft;
            lp.topMargin = boundTop;
        } else {
            return;
        }

        if (lp instanceof CoordinatorLayout.LayoutParams) {
            ((CoordinatorLayout.LayoutParams) lp).gravity = Gravity.TOP | Gravity.START;
        } else if (lp instanceof FrameLayout.LayoutParams) {
            ((FrameLayout.LayoutParams) lp).gravity = Gravity.TOP | Gravity.START;
        }
        overlay.setLayoutParams(lp);
        overlay.requestLayout();
    }

    private void configureSurfaceZOrderOnMain() {
        if (playerView == null) return;
        View surface = playerView.getVideoSurfaceView();
        if (surface instanceof SurfaceView) {
            // Default z-order (behind the window) + hole punch. setZOrderMediaOverlay
            // puts a second compositor layer on top of WebView and reboots Fire TV.
            ((SurfaceView) surface).setZOrderOnTop(false);
        }
    }

    private void requestJsBoundsOnMain() {
        jsNotifier.evaluateJs(
            "try{if(window.syncNativePlayerBoundsFromNative)window.syncNativePlayerBoundsFromNative();}catch(e){}"
        );
    }

    private static ViewGroup.MarginLayoutParams createOverlayLayoutParams(
        ViewGroup parent,
        int width,
        int height
    ) {
        if (parent instanceof CoordinatorLayout) {
            CoordinatorLayout.LayoutParams lp = new CoordinatorLayout.LayoutParams(width, height);
            lp.gravity = Gravity.TOP | Gravity.START;
            return lp;
        }
        if (parent instanceof FrameLayout) {
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(width, height);
            lp.gravity = Gravity.TOP | Gravity.START;
            return lp;
        }
        return new ViewGroup.MarginLayoutParams(width, height);
    }
}
