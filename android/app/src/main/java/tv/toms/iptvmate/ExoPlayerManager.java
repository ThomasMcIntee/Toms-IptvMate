package tv.toms.iptvmate;

import android.graphics.Color;
import android.media.AudioManager;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Button;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import androidx.coordinatorlayout.widget.CoordinatorLayout;
import androidx.media3.ui.PlayerView;

import java.util.ArrayList;
import java.util.List;

/**
 * Bounded PlayerView overlay + in-process ExoPlayer (Activity context for Fire TV HDMI audio).
 *
 * TextureView (not SurfaceView) so Fire TV does not create a SurfaceFlinger
 * hardware overlay. SurfaceView hole-punch produced continuous
 * HWComposer "Invalid display" / vendor.dpframework dumpbuffer errors.
 * Place the overlay AFTER the WebView so the texture draws on top.
 */
public class ExoPlayerManager {
    private static final String TAG = "IPTVMate_ExoPlayer";
    private static final int CONTROLS_HIDE_MS = 3500;

    public interface JsNotifier {
        void evaluateJs(String script);
    }

    private final MainActivity activity;
    private final JsNotifier jsNotifier;
    private final Handler mainHandler;
    private final NativeExoPlayerController playerController;

    private boolean isPlayingNative = false;
    private Runnable overlayHideRunnable;

    private FrameLayout overlay;
    private PlayerView playerView;
    private View controlsBar;
    private ProgressBar progressBar;
    private ImageButton playButton;
    private ImageButton languageButton;
    private ImageButton muteButton;
    private ImageButton fullscreenButton;
    private LinearLayout languagePanel;
    private LinearLayout languageList;
    private TextView timeView;
    private TextView titleView;
    private View liveBadge;
    private Runnable controlsTicker;
    private Runnable hideControlsRunnable;
    private boolean controlsRevealed = true;
    private boolean focusListenerAttached = false;
    private String guideTitle = "";
    private long guideStartMs;
    private long guideEndMs;
    private boolean overlayLooksFullscreen;
    private boolean languagePickerOpen;
    private int selectedControlIndex = -1;

    private int boundLeft;
    private int boundTop;
    private int boundWidth;
    private int boundHeight;
    private int cssViewportWidth;
    private int cssViewportHeight;
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

            @Override
            public void onAudioTracksChanged() {
                mainHandler.post(() -> {
                    refreshLanguageControlsOnMain();
                    jsNotifier.evaluateJs(
                        "try{window.dispatchEvent(new Event('playerAudioTracks'));}catch(e){}"
                    );
                });
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
            this.cssViewportWidth = Math.max(0, cssViewportWidth);
            this.cssViewportHeight = Math.max(0, cssViewportHeight);
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
                cancelHideOverlay();
                isPlayingNative = true;
                playIsLive = isLive;
                closeLanguagePickerOnMain();
                ensureOverlayOnMain();
                if (overlay != null) {
                    overlay.setVisibility(View.VISIBLE);
                    overlay.bringToFront();
                }
                applyBoundsOnMain();
                setWebViewOpaque(true);
                silenceWebViewMedia();
                playBound(trimmed, isLive);
                startControlsTicker();
                revealControls();
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
            refreshControlsOnMain();
            notifyJsPlayerState();
        });
    }

    public void resume() {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            playerController.resume();
            refreshControlsOnMain();
            notifyJsPlayerState();
        });
    }

    public void setMuted(boolean muted) {
        runOnMain(() -> {
            playerController.setMuted(muted);
            refreshControlsOnMain();
        });
    }

    public void setGuide(String title, long startMs, long endMs) {
        runOnMain(() -> {
            guideTitle = title != null ? title : "";
            guideStartMs = Math.max(0, startMs);
            guideEndMs = Math.max(0, endMs);
            refreshControlsOnMain();
        });
    }

    public void revealControls() {
        runOnMain(this::revealControlsOnMain);
    }

    private void playBound(String url, boolean isLive) {
        Log.i(TAG, "Playing in-process: " + url + " isLive=" + isLive);
        if (overlay != null) {
            overlay.setVisibility(View.VISIBLE);
            overlay.bringToFront();
        }

        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "document.querySelectorAll('video,audio').forEach(function(el){" +
            "try{el.pause();el.muted=true;el.volume=0;el.removeAttribute('src');}catch(e){}" +
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

    private void setWebViewOpaque(boolean opaque) {
        WebView webView = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
        if (webView == null) return;
        webView.setBackgroundColor(opaque ? Color.BLACK : Color.TRANSPARENT);
    }

    private void hideNativeSurface() {
        if (overlay != null) {
            overlay.setVisibility(View.GONE);
        }
        setWebViewOpaque(true);
    }

    private void cancelHideOverlay() {
        if (overlayHideRunnable != null) {
            mainHandler.removeCallbacks(overlayHideRunnable);
            overlayHideRunnable = null;
        }
    }

    private void scheduleHideOverlay() {
        cancelHideOverlay();
        overlayHideRunnable = () -> {
            overlayHideRunnable = null;
            if (!isPlayingNative) {
                hideNativeSurface();
            }
        };
        mainHandler.postDelayed(overlayHideRunnable, 180);
    }

    public void stop() {
        runOnMain(() -> {
            if (!isPlayingNative && overlayHideRunnable == null) return;

            isPlayingNative = false;
            Log.i(TAG, "Stopping native player");
            closeLanguagePickerOnMain();
            stopControlsTicker();
            cancelHideControls();
            clearControlSelection();
            jsNotifier.evaluateJs(
                "document.body.classList.remove('native-exo-active');" +
                "document.body.classList.remove('native-exo-vod');"
            );
            playerController.stop();
            // Delay hiding the overlay so a quick channel change does not
            // tear down the compositor layer.
            scheduleHideOverlay();
        });
    }

    public void release() {
        runOnMain(() -> {
            isPlayingNative = false;
            cancelHideOverlay();
            stopControlsTicker();
            cancelHideControls();
            clearControlSelection();
            hideNativeSurface();
            setWebViewOpaque(true);
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

    public void focusControls() {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            revealControlsOnMain();
            focusDefaultControlOnMain();
        });
    }

    public void moveControlFocus(int delta) {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            revealControlsOnMain();
            if (delta == 0) {
                focusDefaultControlOnMain();
                return;
            }
            moveControlSelection(delta);
        });
    }

    public void activateSelectedControl() {
        runOnMain(() -> {
            if (!isPlayingNative) return;
            revealControlsOnMain();
            ImageButton current = selectedControl();
            if (current == null) {
                focusDefaultControlOnMain();
                return;
            }
            current.performClick();
        });
    }

    /**
     * Movies and fullscreen live use the native overlay. D-pad must stay on those
     * ImageButtons so lime {@code state_focused} paints. Live preview leaves keys
     * with the WebView channel list.
     */
    public boolean offerRemoteKey(KeyEvent event) {
        if (!isPlayingNative) return false;
        if (playIsLive && !overlayLooksFullscreen) return false;
        int code = event.getKeyCode();
        if (!isRemoteControlKey(code)) return false;
        if (event.getAction() != KeyEvent.ACTION_DOWN) return true;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            return handleRemoteKeyOnMain(code);
        }
        mainHandler.post(() -> handleRemoteKeyOnMain(code));
        return true;
    }

    private boolean handleRemoteKeyOnMain(int code) {
        if (!isPlayingNative) return false;
        revealControlsOnMain();

        if (languagePickerOpen) {
            return handleLanguagePickerKeyOnMain(code);
        }

        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
            ImageButton current = selectedControl();
            if (current == null) {
                focusDefaultControlOnMain();
                return true;
            }
            current.performClick();
            return true;
        }

        if (code == KeyEvent.KEYCODE_DPAD_LEFT) {
            moveControlSelection(-1);
            return true;
        }
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) {
            moveControlSelection(1);
            return true;
        }

        if (selectedControl() == null) {
            focusDefaultControlOnMain();
        }
        return true;
    }

    private boolean handleLanguagePickerKeyOnMain(int code) {
        View focused = activity.getCurrentFocus();
        if (code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) {
            if (focused != null && isUnderLanguagePanel(focused)) {
                focused.performClick();
            }
            return true;
        }
        if (focused == null || !isUnderLanguagePanel(focused)) {
            focusSelectedLanguageOption();
            return true;
        }
        int direction = remoteFocusDirection(code);
        if (direction == 0) return true;
        View next = focused.focusSearch(direction);
        if (next != null && isUnderLanguagePanel(next)) {
            next.requestFocus();
        }
        return true;
    }

    private void focusDefaultControlOnMain() {
        List<ImageButton> controls = visibleControls();
        if (languageButton != null
            && languageButton.getVisibility() == View.VISIBLE
            && controls.contains(languageButton)) {
            paintControlSelection(languageButton);
            return;
        }
        paintControlSelection(controls.isEmpty() ? playButton : controls.get(0));
    }

    private void moveControlSelection(int delta) {
        List<ImageButton> controls = visibleControls();
        if (controls.isEmpty()) return;
        if (selectedControl() == null) {
            paintControlSelection(controls.get(0));
            return;
        }
        int next = Math.max(0, Math.min(controls.size() - 1, selectedControlIndex + delta));
        paintControlSelection(controls.get(next));
    }

    private ImageButton selectedControl() {
        List<ImageButton> controls = visibleControls();
        if (selectedControlIndex < 0 || selectedControlIndex >= controls.size()) return null;
        return controls.get(selectedControlIndex);
    }

    private List<ImageButton> visibleControls() {
        List<ImageButton> out = new ArrayList<>();
        ImageButton[] order = new ImageButton[] { playButton, languageButton, muteButton, fullscreenButton };
        for (ImageButton button : order) {
            if (button != null && button.getVisibility() == View.VISIBLE) {
                makeControlFocusable(button);
                out.add(button);
            }
        }
        return out;
    }

    private void paintControlSelection(ImageButton target) {
        List<ImageButton> controls = visibleControls();
        selectedControlIndex = -1;
        for (int i = 0; i < controls.size(); i++) {
            ImageButton button = controls.get(i);
            boolean on = button == target;
            button.setSelected(on);
            if (on) {
                selectedControlIndex = i;
                button.requestFocus();
            }
        }
    }

    private void clearControlSelection() {
        selectedControlIndex = -1;
        ImageButton[] order = new ImageButton[] { playButton, languageButton, muteButton, fullscreenButton };
        for (ImageButton button : order) {
            if (button != null) button.setSelected(false);
        }
    }

    private static boolean isRemoteControlKey(int code) {
        return code == KeyEvent.KEYCODE_DPAD_UP
            || code == KeyEvent.KEYCODE_DPAD_DOWN
            || code == KeyEvent.KEYCODE_DPAD_LEFT
            || code == KeyEvent.KEYCODE_DPAD_RIGHT
            || code == KeyEvent.KEYCODE_DPAD_CENTER
            || code == KeyEvent.KEYCODE_ENTER;
    }

    private static int remoteFocusDirection(int code) {
        if (code == KeyEvent.KEYCODE_DPAD_UP) return View.FOCUS_UP;
        if (code == KeyEvent.KEYCODE_DPAD_DOWN) return View.FOCUS_DOWN;
        if (code == KeyEvent.KEYCODE_DPAD_LEFT) return View.FOCUS_LEFT;
        if (code == KeyEvent.KEYCODE_DPAD_RIGHT) return View.FOCUS_RIGHT;
        return 0;
    }

    private static void makeControlFocusable(ImageButton button) {
        if (button == null) return;
        button.setEnabled(true);
        button.setClickable(true);
        button.setFocusable(true);
        button.setFocusableInTouchMode(true);
    }

    void handleNativePlaybackReady() {
        refreshLanguageControlsOnMain();
        jsNotifier.evaluateJs(
            "document.body.classList.add('native-exo-active');" +
            "window.dispatchEvent(new CustomEvent('playerPlaying'));" +
            "window.dispatchEvent(new Event('playerAudioTracks'));"
        );
    }

    void handleNativePlaybackError(String message) {
        isPlayingNative = false;
        String escaped = message != null
            ? message.replace("\\", "\\\\").replace("'", "\\'")
            : "Native playback failed";
        mainHandler.post(() -> {
            clearControlSelection();
            hideNativeSurface();
            setWebViewOpaque(true);
        });
        jsNotifier.evaluateJs(
            "document.body.classList.remove('native-exo-active');" +
            "document.body.classList.remove('native-exo-vod');" +
            "window.dispatchEvent(new CustomEvent('playerError'," +
            "{detail:{source:'native-exo',message:'" + escaped + "'}}));"
        );
    }

    void handleNativePlaybackStopped() {
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
        overlay.setClickable(true);
        overlay.setFocusable(false);
        overlay.setFocusableInTouchMode(false);
        overlay.setOnClickListener(v -> {
            if (closeLanguagePickerOnMain()) return;
            revealControlsOnMain();
        });

        playerView = overlay.findViewById(R.id.native_exo_player_view);
        if (playerView == null) {
            throw new IllegalStateException("native_exo_player_view missing from overlay layout");
        }
        playerView.setUseController(false);
        playerView.setKeepContentOnPlayerReset(false);
        playerView.setShutterBackgroundColor(Color.BLACK);
        playerView.setKeepScreenOn(true);
        playerView.setClickable(false);
        playerView.setFocusable(false);
        playerView.setFocusableInTouchMode(false);
        playerController.attachPlayerView(playerView);
        bindControlsOnMain();
        configureSurfaceZOrderOnMain();

        // Overlay must sit AFTER the WebView so TextureView paints on top of
        // Chromium. SurfaceView hole-punch is no longer used.
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
        WebView webView = activity.getBridge() != null ? activity.getBridge().getWebView() : null;
        int hostWidth = webView != null && webView.getWidth() > 0
            ? webView.getWidth()
            : (parent != null ? parent.getWidth() : 0);
        int hostHeight = webView != null && webView.getHeight() > 0
            ? webView.getHeight()
            : (parent != null ? parent.getHeight() : 0);

        boolean jsLooksFullscreen = hasBounds && (
            cssViewportWidth > 0 && cssViewportHeight > 0
                ? boundWidth >= (int) (cssViewportWidth * 0.85f)
                    && boundHeight >= (int) (cssViewportHeight * 0.70f)
                : hostWidth > 0
                    && boundWidth >= (int) (hostWidth * 0.85f)
                    && boundHeight >= (int) (hostHeight * 0.70f)
        );

        int nextWidth;
        int nextHeight;
        int nextLeft;
        int nextTop;
        int nextRight = 0;
        int nextBottom = 0;

        if (!playIsLive || jsLooksFullscreen) {
            nextWidth = ViewGroup.LayoutParams.MATCH_PARENT;
            nextHeight = ViewGroup.LayoutParams.MATCH_PARENT;
            nextLeft = 0;
            nextTop = 0;
            overlayLooksFullscreen = true;
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
            // Fill the preview window; the control bar overlays the picture.
            nextWidth = previewWidth;
            nextHeight = previewHeight;
            nextLeft = Math.max(0, hostWidth - previewWidth - margin);
            nextTop = margin;
            overlayLooksFullscreen = false;
            Log.i(TAG, "applyBounds live-preview " + nextLeft + "," + nextTop
                + " " + previewWidth + "x" + nextHeight + " host=" + hostWidth + "x" + hostHeight);
        } else if (hasBounds) {
            nextWidth = boundWidth;
            nextHeight = boundHeight;
            nextLeft = boundLeft;
            nextTop = boundTop;
            overlayLooksFullscreen = jsLooksFullscreen;
        } else {
            return;
        }

        ViewGroup.LayoutParams raw = overlay.getLayoutParams();
        ViewGroup.MarginLayoutParams lp;
        if (raw instanceof ViewGroup.MarginLayoutParams) {
            lp = (ViewGroup.MarginLayoutParams) raw;
            if (lp.width == nextWidth
                && lp.height == nextHeight
                && lp.leftMargin == nextLeft
                && lp.topMargin == nextTop
                && lp.rightMargin == nextRight
                && lp.bottomMargin == nextBottom) {
                return;
            }
        } else {
            lp = parent != null
                ? createOverlayLayoutParams(parent, nextWidth, nextHeight)
                : new FrameLayout.LayoutParams(nextWidth, nextHeight);
        }

        lp.width = nextWidth;
        lp.height = nextHeight;
        lp.leftMargin = nextLeft;
        lp.topMargin = nextTop;
        lp.rightMargin = nextRight;
        lp.bottomMargin = nextBottom;

        if (lp instanceof CoordinatorLayout.LayoutParams) {
            ((CoordinatorLayout.LayoutParams) lp).gravity = Gravity.TOP | Gravity.START;
        } else if (lp instanceof FrameLayout.LayoutParams) {
            ((FrameLayout.LayoutParams) lp).gravity = Gravity.TOP | Gravity.START;
        }

        overlay.setLayoutParams(lp);
        overlay.requestLayout();
        refreshControlsOnMain();
        applyControlsVisibilityOnMain();
    }

    private void bindControlsOnMain() {
        if (overlay == null) return;
        controlsBar = overlay.findViewById(R.id.native_exo_controls);
        progressBar = overlay.findViewById(R.id.native_exo_progress);
        playButton = overlay.findViewById(R.id.native_exo_play);
        languageButton = overlay.findViewById(R.id.native_exo_language);
        muteButton = overlay.findViewById(R.id.native_exo_mute);
        fullscreenButton = overlay.findViewById(R.id.native_exo_fullscreen);
        languagePanel = overlay.findViewById(R.id.native_exo_language_panel);
        languageList = overlay.findViewById(R.id.native_exo_language_list);
        timeView = overlay.findViewById(R.id.native_exo_time);
        titleView = overlay.findViewById(R.id.native_exo_title);
        liveBadge = overlay.findViewById(R.id.native_exo_live);

        makeControlFocusable(playButton);
        makeControlFocusable(languageButton);
        makeControlFocusable(muteButton);
        makeControlFocusable(fullscreenButton);

        if (playButton != null) {
            playButton.setOnClickListener(v -> {
                playerController.togglePlayPause();
                refreshControlsOnMain();
                notifyJsPlayerState();
                revealControlsOnMain();
            });
        }
        if (muteButton != null) {
            muteButton.setOnClickListener(v -> {
                playerController.toggleMuted();
                refreshControlsOnMain();
                notifyJsPlayerState();
                revealControlsOnMain();
            });
        }
        if (fullscreenButton != null) {
            fullscreenButton.setOnClickListener(v -> {
                revealControlsOnMain();
                jsNotifier.evaluateJs(
                    "try{window.dispatchEvent(new CustomEvent('nativePlayerCommand',"
                        + "{detail:{action:'fullscreen'}}));}catch(e){}"
                );
            });
        }
        if (languageButton != null) {
            languageButton.setOnClickListener(v -> toggleLanguagePickerOnMain());
        }
        attachControlsFocusListener();
        refreshControlsOnMain();
        revealControlsOnMain();
    }

    private void startControlsTicker() {
        stopControlsTicker();
        controlsTicker = () -> {
            refreshControlsOnMain();
            if (isPlayingNative && overlay != null && overlay.getVisibility() == View.VISIBLE) {
                mainHandler.postDelayed(controlsTicker, 500);
            }
        };
        mainHandler.post(controlsTicker);
    }

    private void stopControlsTicker() {
        if (controlsTicker != null) {
            mainHandler.removeCallbacks(controlsTicker);
            controlsTicker = null;
        }
    }

    private void refreshControlsOnMain() {
        if (controlsBar == null) return;

        boolean paused = playerController.isPlaybackPaused();
        boolean muted = playerController.isMuted();
        if (playButton != null) {
            playButton.setImageResource(paused ? R.drawable.ic_player_play : R.drawable.ic_player_pause);
        }
        if (muteButton != null) {
            muteButton.setImageResource(muted ? R.drawable.ic_player_volume_off : R.drawable.ic_player_volume_on);
        }
        if (fullscreenButton != null) {
            fullscreenButton.setImageResource(
                overlayLooksFullscreen ? R.drawable.ic_player_fullscreen_exit : R.drawable.ic_player_fullscreen
            );
        }

        long now = System.currentTimeMillis();
        boolean hasGuide = guideEndMs > guideStartMs && guideEndMs > now - 60_000;
        int progress = 0;
        if (hasGuide) {
            long span = Math.max(1, guideEndMs - guideStartMs);
            progress = (int) Math.max(0, Math.min(1000, ((now - guideStartMs) * 1000L) / span));
        }
        if (progressBar != null) {
            progressBar.setProgress(progress);
        }
        if (timeView != null) {
            timeView.setText(hasGuide ? formatGuideRange(guideStartMs, guideEndMs) : "Live");
        }
        if (titleView != null) {
            titleView.setText(guideTitle);
        }
        if (liveBadge != null) {
            liveBadge.setVisibility(playIsLive ? View.VISIBLE : View.GONE);
        }
        refreshLanguageControlsOnMain();
    }

    private void revealControlsOnMain() {
        controlsRevealed = true;
        applyControlsVisibilityOnMain();
        if (languagePickerOpen) {
            cancelHideControls();
            return;
        }
        scheduleHideControls();
    }

    private void scheduleHideControls() {
        if (languagePickerOpen) {
            cancelHideControls();
            return;
        }
        cancelHideControls();
        hideControlsRunnable = () -> {
            hideControlsRunnable = null;
            if (languagePickerOpen) {
                return;
            }
            clearControlSelection();
            controlsRevealed = false;
            applyControlsVisibilityOnMain();
        };
        mainHandler.postDelayed(hideControlsRunnable, CONTROLS_HIDE_MS);
    }

    private void cancelHideControls() {
        if (hideControlsRunnable != null) {
            mainHandler.removeCallbacks(hideControlsRunnable);
            hideControlsRunnable = null;
        }
    }

    private void applyControlsVisibilityOnMain() {
        if (controlsBar == null) return;
        boolean show = isPlayingNative && controlsRevealed;
        if (show) {
            controlsBar.animate().cancel();
            controlsBar.setVisibility(View.VISIBLE);
            if (controlsBar.getAlpha() < 0.99f) {
                controlsBar.animate().alpha(1f).setDuration(180).start();
            } else {
                controlsBar.setAlpha(1f);
            }
        } else if (controlsBar.getVisibility() == View.VISIBLE) {
            controlsBar.animate().cancel();
            controlsBar.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                if (!controlsRevealed || !isPlayingNative) {
                    controlsBar.setVisibility(View.GONE);
                }
            }).start();
        } else {
            controlsBar.setVisibility(View.GONE);
        }
    }

    private boolean controlsHaveFocus() {
        View focused = activity.getCurrentFocus();
        return isUnderControls(focused) || isUnderLanguagePanel(focused);
    }

    private boolean isUnderControls(View view) {
        if (controlsBar == null || view == null) return false;
        View current = view;
        while (current != null) {
            if (current == controlsBar) return true;
            if (!(current.getParent() instanceof View)) return false;
            current = (View) current.getParent();
        }
        return false;
    }

    private void attachControlsFocusListener() {
        if (focusListenerAttached || activity.getWindow() == null) return;
        View decor = activity.getWindow().getDecorView();
        if (decor.getViewTreeObserver() == null) return;
        decor.getViewTreeObserver().addOnGlobalFocusChangeListener((oldFocus, newFocus) -> {
            if (!isPlayingNative || controlsBar == null) return;
            if (isUnderControls(newFocus) || isUnderLanguagePanel(newFocus)) {
                controlsRevealed = true;
                applyControlsVisibilityOnMain();
                cancelHideControls();
            } else if (isUnderControls(oldFocus) || isUnderLanguagePanel(oldFocus)) {
                scheduleHideControls();
            }
        });
        focusListenerAttached = true;
    }

    private String formatGuideRange(long startMs, long endMs) {
        java.text.DateFormat format = android.text.format.DateFormat.getTimeFormat(activity);
        return format.format(new java.util.Date(startMs)) + " – " + format.format(new java.util.Date(endMs));
    }

    public boolean consumeBackPress() {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post(this::consumeBackPress);
            return isPlayingNative && !playIsLive && (languagePickerOpen || controlsRevealed);
        }
        if (closeLanguagePickerOnMain()) {
            return true;
        }
        if (isPlayingNative && !playIsLive && controlsRevealed) {
            hideControlsNowOnMain();
            return true;
        }
        return false;
    }

    private void hideControlsNowOnMain() {
        cancelHideControls();
        languagePickerOpen = false;
        if (languagePanel != null) {
            languagePanel.setVisibility(View.GONE);
        }
        controlsRevealed = false;
        applyControlsVisibilityOnMain();
        View focused = activity.getCurrentFocus();
        if (focused != null && (isUnderControls(focused) || isUnderLanguagePanel(focused))) {
            focused.clearFocus();
        }
        clearControlSelection();
    }

    public List<NativeExoPlayerController.AudioTrackOption> getAudioTracks() {
        return playerController.getAudioTracks();
    }

    public boolean setAudioTrack(String id) {
        boolean selected = playerController.setAudioTrack(id);
        refreshLanguageControlsOnMain();
        if (selected) {
            closeLanguagePickerOnMain();
        }
        return selected;
    }

    private void toggleLanguagePickerOnMain() {
        if (languagePickerOpen) {
            closeLanguagePickerOnMain();
            return;
        }
        if (playerController.getAudioTracks().size() < 2) {
            revealControlsOnMain();
            return;
        }
        openLanguagePickerOnMain();
    }

    private void wireLanguageFocusStops(boolean languageVisible) {
        if (playButton == null || muteButton == null || languageButton == null) return;
        if (languageVisible) {
            playButton.setNextFocusRightId(R.id.native_exo_language);
            languageButton.setNextFocusLeftId(R.id.native_exo_play);
            languageButton.setNextFocusRightId(R.id.native_exo_mute);
            muteButton.setNextFocusLeftId(R.id.native_exo_language);
        } else {
            playButton.setNextFocusRightId(R.id.native_exo_mute);
            muteButton.setNextFocusLeftId(R.id.native_exo_play);
        }
    }

    private void openLanguagePickerOnMain() {
        List<NativeExoPlayerController.AudioTrackOption> tracks = playerController.getAudioTracks();
        if (tracks.size() < 2) return;

        languagePickerOpen = true;
        rebuildLanguageListOnMain(tracks);
        if (languagePanel != null) {
            languagePanel.setVisibility(View.VISIBLE);
        }
        controlsRevealed = true;
        applyControlsVisibilityOnMain();
        cancelHideControls();
        focusSelectedLanguageOption();
    }

    private boolean closeLanguagePickerOnMain() {
        boolean wasOpen = languagePickerOpen;
        languagePickerOpen = false;
        if (languagePanel != null) {
            languagePanel.setVisibility(View.GONE);
        }
        if (wasOpen && languageButton != null && languageButton.getVisibility() == View.VISIBLE) {
            languageButton.requestFocus();
            revealControlsOnMain();
        }
        return wasOpen;
    }

    private void refreshLanguageControlsOnMain() {
        if (languageButton == null) return;

        List<NativeExoPlayerController.AudioTrackOption> tracks =
            isPlayingNative ? playerController.getAudioTracks() : java.util.Collections.emptyList();
        boolean show = isPlayingNative && !playIsLive;
        languageButton.setVisibility(show ? View.VISIBLE : View.GONE);
        languageButton.setEnabled(true);
        languageButton.setClickable(true);
        languageButton.setFocusable(show);
        languageButton.setFocusableInTouchMode(show);
        languageButton.setContentDescription(show && tracks.size() >= 2
            ? selectedLanguageLabel(tracks)
            : activity.getString(R.string.native_exo_language));
        wireLanguageFocusStops(show);

        if (!show && languagePickerOpen) {
            closeLanguagePickerOnMain();
            return;
        }
        if (languagePickerOpen) {
            rebuildLanguageListOnMain(tracks);
        }
    }

    private void rebuildLanguageListOnMain(List<NativeExoPlayerController.AudioTrackOption> tracks) {
        if (languageList == null) return;
        languageList.removeAllViews();

        float density = activity.getResources().getDisplayMetrics().density;
        int padH = Math.round(14 * density);
        int padV = Math.round(10 * density);
        int gap = Math.round(6 * density);

        for (NativeExoPlayerController.AudioTrackOption track : tracks) {
            Button option = new Button(activity, null, android.R.attr.borderlessButtonStyle);
            option.setText(track.selected ? track.label + "  ✓" : track.label);
            option.setAllCaps(false);
            option.setTextColor(Color.WHITE);
            option.setTextSize(15);
            option.setBackgroundResource(R.drawable.native_exo_language_option);
            option.setPadding(padH, padV, padH, padV);
            option.setFocusable(true);
            option.setFocusableInTouchMode(true);
            option.setSelected(track.selected);
            option.setTag(track.id);
            option.setOnClickListener(v -> {
                playerController.setAudioTrack(track.id);
                refreshLanguageControlsOnMain();
                closeLanguagePickerOnMain();
            });

            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            );
            lp.topMargin = gap;
            languageList.addView(option, lp);
        }
    }

    private void focusSelectedLanguageOption() {
        if (languageList == null) return;
        View selected = null;
        for (int i = 0; i < languageList.getChildCount(); i++) {
            View child = languageList.getChildAt(i);
            if (child.isSelected()) {
                selected = child;
                break;
            }
        }
        View target = selected != null ? selected : languageList.getChildAt(0);
        if (target != null) {
            target.requestFocus();
        }
    }

    private boolean isUnderLanguagePanel(View view) {
        return isUnderView(languagePanel, view);
    }

    private boolean isUnderView(View root, View view) {
        if (root == null || view == null) return false;
        View current = view;
        while (current != null) {
            if (current == root) return true;
            if (!(current.getParent() instanceof View)) return false;
            current = (View) current.getParent();
        }
        return false;
    }

    private static String selectedLanguageLabel(List<NativeExoPlayerController.AudioTrackOption> tracks) {
        for (NativeExoPlayerController.AudioTrackOption track : tracks) {
            if (track.selected) return "Audio language: " + track.label;
        }
        return "Audio language";
    }

    private void notifyJsPlayerState() {
        boolean paused = playerController.isPlaybackPaused();
        boolean muted = playerController.isMuted();
        jsNotifier.evaluateJs(
            "try{window.dispatchEvent(new CustomEvent('nativePlayerCommand',"
                + "{detail:{action:'state',paused:" + paused + ",muted:" + muted + "}}));}catch(e){}"
        );
    }

    private void configureSurfaceZOrderOnMain() {
        // TextureView has no SurfaceFlinger overlay plane. Leave z-order alone
        // if a SurfaceView is ever restored — setZOrderMediaOverlay reboots Fire TV.
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
