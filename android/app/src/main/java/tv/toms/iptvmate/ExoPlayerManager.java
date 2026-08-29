package tv.toms.iptvmate;

import android.graphics.Color;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.ui.PlayerView;

/**
 * Fullscreen PlayerView overlay + in-process ExoPlayer (Activity context for Fire TV HDMI audio).
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
        });
    }

    public void warmUp() {
        Log.i(TAG, "Warm-up requested (in-process ExoPlayer)");
    }

    public void setBounds(int left, int top, int width, int height) {
        Log.i(TAG, "setBounds ignored — fullscreen overlay");
    }

    public void play(String url) {
        if (url == null || url.trim().isEmpty()) return;

        isPlayingNative = true;
        String trimmed = url.trim();
        ensureOverlay();
        silenceWebViewMedia();
        playBound(trimmed);
    }

    private void playBound(String url) {
        Log.i(TAG, "Playing in-process: " + url);
        mainHandler.post(() -> {
            if (overlay != null) {
                overlay.setVisibility(View.VISIBLE);
                overlay.bringToFront();
            }
        });

        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "document.querySelectorAll('video,audio').forEach(function(el){" +
            "try{el.pause();el.muted=true;el.volume=0;el.removeAttribute('src');if(el.load)el.load();}catch(e){}" +
            "});"
        );

        playerController.play(url);
    }

    private void silenceWebViewMedia() {
        AudioManager am = (AudioManager) activity.getSystemService(MainActivity.AUDIO_SERVICE);
        if (am != null) {
            am.setMode(AudioManager.MODE_NORMAL);
        }
    }

    public void stop() {
        if (!isPlayingNative) return;

        isPlayingNative = false;
        Log.i(TAG, "Stopping native player");

        mainHandler.post(() -> {
            if (overlay != null) {
                overlay.setVisibility(View.GONE);
            }
            jsNotifier.evaluateJs("document.body.classList.remove('native-exo-active');");
        });

        playerController.stop();
    }

    public void release() {
        stop();
        playerController.release();
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
        mainHandler.post(() -> {
            if (overlay != null) {
                overlay.setVisibility(View.GONE);
            }
        });
        jsNotifier.evaluateJs(
            "document.body.classList.remove('native-exo-active');" +
            "window.dispatchEvent(new CustomEvent('playerError'," +
            "{detail:{source:'native-exo',message:'" + escaped + "'}}));"
        );
    }

    void handleNativePlaybackStopped() {
        isPlayingNative = false;
        mainHandler.post(() -> {
            if (overlay != null) {
                overlay.setVisibility(View.GONE);
            }
        });
        jsNotifier.evaluateJs("document.body.classList.remove('native-exo-active');");
    }

    private void ensureOverlay() {
        if (overlay != null) return;

        mainHandler.post(() -> {
            if (overlay != null) return;

            WebView webView = activity.getBridge().getWebView();
            if (webView == null) return;

            ViewGroup parent = (ViewGroup) webView.getParent();
            if (parent == null) return;

            overlay = new FrameLayout(activity);
            overlay.setBackgroundColor(Color.BLACK);
            overlay.setVisibility(View.GONE);

            playerView = new PlayerView(activity);
            playerView.setUseController(false);
            playerView.setKeepContentOnPlayerReset(true);
            playerView.setShutterBackgroundColor(Color.BLACK);
            overlay.addView(
                playerView,
                new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    Gravity.CENTER
                )
            );

            playerController.attachPlayerView(playerView);

            parent.addView(
                overlay,
                new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            );
            Log.i(TAG, "Native PlayerView overlay attached");
        });
    }
}
