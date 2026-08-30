package tv.toms.iptvmate;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.SurfaceView;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.TransferListener;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.exoplayer.source.ProgressiveMediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.extractor.ts.TsExtractor;

public class NativeExoPlayerController {
    public interface Callback {
        void onReady(int session);
        void onError(int session, String message);
    }

    private static final String TAG = "IPTVMate_NativeExo";
    private static final String USER_AGENT = "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)";
    private static final long PREPARE_TIMEOUT_MS = 15000;

    private final Context playbackContext;
    private final Handler mainHandler;
    private final Callback callback;

    private ExoPlayer exoPlayer;
    private SurfaceView surfaceView;
    private DefaultHttpDataSource.Factory dataSourceFactory;
    private DefaultExtractorsFactory extractorsFactory;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    private int activeSessionId = 0;
    private String originalStreamUrl;
    private String activeStreamUrl;
    private boolean triedAlternateUrl = false;
    private boolean readyNotified = false;
    private Runnable prepareTimeoutRunnable;
    private long bytesRead = 0;

    private final AudioManager.OnAudioFocusChangeListener audioFocusListener = focusChange ->
        Log.i(TAG, "audioFocusChange=" + focusChange);

    public NativeExoPlayerController(Context activityContext, Callback callback) {
        this.playbackContext = activityContext;
        this.callback = callback;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.audioManager = (AudioManager) playbackContext.getSystemService(Context.AUDIO_SERVICE);
    }

    private void runOnMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    public void attachSurfaceView(@Nullable SurfaceView view) {
        surfaceView = view;
        if (exoPlayer != null && surfaceView != null) {
            exoPlayer.setVideoSurfaceView(surfaceView);
            Log.i(TAG, "SurfaceView attached to ExoPlayer");
        }
    }

    public void cancelPrepareTimeout() {
        if (prepareTimeoutRunnable != null) {
            mainHandler.removeCallbacks(prepareTimeoutRunnable);
            prepareTimeoutRunnable = null;
        }
    }

    public void play(int sessionId, String url) {
        if (url == null || url.trim().isEmpty()) return;
        runOnMain(() -> playOnMain(sessionId, url.trim()));
    }

    public void stop() {
        runOnMain(this::stopOnMain);
    }

    public void release() {
        runOnMain(this::releaseOnMain);
    }

    private void playOnMain(int sessionId, String url) {
        activeSessionId = sessionId;
        originalStreamUrl = url;
        activeStreamUrl = url;
        triedAlternateUrl = false;
        readyNotified = false;
        cancelPrepareTimeout();
        Log.i(TAG, "play [session=" + sessionId + "] url=" + activeStreamUrl);
        preparePlayer(sessionId);
    }

    private void stopOnMain() {
        Log.i(TAG, "stopPlayback");
        activeSessionId++;
        cancelPrepareTimeout();
        readyNotified = false;
        abandonAudioFocus();
        if (exoPlayer != null) {
            exoPlayer.stop();
            exoPlayer.clearMediaItems();
            exoPlayer.clearVideoSurface();
        }
    }

    private void releaseOnMain() {
        stopOnMain();
        if (exoPlayer != null) {
            exoPlayer.release();
            exoPlayer = null;
        }
        surfaceView = null;
    }

    private void preparePlayer(int sessionId) {
        if (sessionId != activeSessionId) return;

        try {
            if (dataSourceFactory == null) {
                TransferListener transferListener = new TransferListener() {
                    @Override
                    public void onTransferInitializing(DataSource source, DataSpec dataSpec, boolean isNetwork) {}

                    @Override
                    public void onTransferStart(DataSource source, DataSpec dataSpec, boolean isNetwork) {
                        bytesRead = 0;
                        Log.i(TAG, "http open " + dataSpec.uri);
                    }

                    @Override
                    public void onBytesTransferred(DataSource source, DataSpec dataSpec, boolean isNetwork, int bytes) {
                        bytesRead += bytes;
                    }

                    @Override
                    public void onTransferEnd(DataSource source, DataSpec dataSpec, boolean isNetwork) {
                        Log.i(TAG, "http end bytes=" + bytesRead);
                    }
                };
                dataSourceFactory = new DefaultHttpDataSource.Factory()
                    .setUserAgent(USER_AGENT)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(20000)
                    .setDefaultRequestProperties(java.util.Collections.singletonMap("Accept", "*/*"))
                    .setTransferListener(transferListener);
            }

            if (extractorsFactory == null) {
                extractorsFactory = new DefaultExtractorsFactory()
                    .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
                    .setTsExtractorTimestampSearchBytes(1500 * TsExtractor.TS_PACKET_SIZE);
            }

            if (exoPlayer == null) {
                exoPlayer = buildExoPlayer();
            }
            if (surfaceView != null) {
                exoPlayer.setVideoSurfaceView(surfaceView);
            } else {
                Log.w(TAG, "preparePlayer: SurfaceView not attached yet");
            }

            ensureSystemAudible();
            acquireAudioFocus();
            exoPlayer.stop();
            exoPlayer.clearMediaItems();
            exoPlayer.setVolume(1f);
            setMediaOnPlayer(exoPlayer, activeStreamUrl);
            exoPlayer.prepare();
            exoPlayer.setPlayWhenReady(true);
            schedulePrepareTimeout(sessionId);
            Log.i(TAG, "prepare ts=" + isProgressiveTsUrl(activeStreamUrl)
                + " hls=" + isHlsUrl(activeStreamUrl));
        } catch (Exception e) {
            Log.e(TAG, "prepare failed", e);
            callback.onError(sessionId, "Failed to start native playback");
        }
    }

    private void schedulePrepareTimeout(int sessionId) {
        cancelPrepareTimeout();
        prepareTimeoutRunnable = () -> {
            if (sessionId != activeSessionId || readyNotified || exoPlayer == null) return;
            Log.e(TAG, "Prepare timeout state=" + playbackStateName(exoPlayer.getPlaybackState())
                + " bytesRead=" + bytesRead);
            callback.onError(sessionId, "Stream did not start in time");
        };
        mainHandler.postDelayed(prepareTimeoutRunnable, PREPARE_TIMEOUT_MS);
    }

    private ExoPlayer buildExoPlayer() {
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(1000, 3000, 500, 800)
            .setTargetBufferBytes(256 * 1024)
            .setPrioritizeTimeOverSizeThresholds(true)
            .setBackBuffer(0, false)
            .build();

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(playbackContext)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
            .setEnableDecoderFallback(true);

        ExoPlayer player = new ExoPlayer.Builder(playbackContext)
            .setRenderersFactory(renderersFactory)
            .setLoadControl(loadControl)
            .build();

        androidx.media3.common.AudioAttributes attrs =
            new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build();
        player.setAudioAttributes(attrs, false);
        player.setHandleAudioBecomingNoisy(false);
        player.setWakeMode(C.WAKE_MODE_NETWORK);
        player.setVolume(1f);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                Log.i(TAG, "state=" + playbackStateName(playbackState)
                    + " bytesRead=" + bytesRead
                    + " session=" + activeSessionId);
                if (playbackState == Player.STATE_READY && !readyNotified) {
                    readyNotified = true;
                    cancelPrepareTimeout();
                    ensureSystemAudible();
                    player.setVolume(1f);
                    Log.i(TAG, "Playback ready session=" + activeSessionId);
                    callback.onReady(activeSessionId);
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                Log.i(TAG, "First video frame rendered");
            }

            @Override
            public void onVideoSizeChanged(androidx.media3.common.VideoSize videoSize) {
                Log.i(TAG, "Video size " + videoSize.width + "x" + videoSize.height);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "Playback error url=" + activeStreamUrl, error);
                cancelPrepareTimeout();
                int session = activeSessionId;
                String alternate = alternateStreamUrl(originalStreamUrl, activeStreamUrl);
                if (!triedAlternateUrl && alternate != null) {
                    triedAlternateUrl = true;
                    activeStreamUrl = alternate;
                    readyNotified = false;
                    Log.i(TAG, "Retrying alternate url=" + activeStreamUrl);
                    preparePlayer(session);
                    return;
                }
                String message = error.getMessage() != null ? error.getMessage() : "Native playback failed";
                callback.onError(session, message);
            }
        });

        return player;
    }

    private static String playbackStateName(int state) {
        switch (state) {
            case Player.STATE_IDLE: return "IDLE";
            case Player.STATE_BUFFERING: return "BUFFERING";
            case Player.STATE_READY: return "READY";
            case Player.STATE_ENDED: return "ENDED";
            default: return String.valueOf(state);
        }
    }

    private void ensureSystemAudible() {
        if (audioManager == null) return;
        audioManager.setMode(AudioManager.MODE_NORMAL);
        int stream = AudioManager.STREAM_MUSIC;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && audioManager.isStreamMute(stream)) {
            audioManager.adjustStreamVolume(stream, AudioManager.ADJUST_UNMUTE, 0);
        }
        if (audioManager.getStreamVolume(stream) == 0) {
            int raised = Math.max(1, audioManager.getStreamMaxVolume(stream) / 2);
            audioManager.setStreamVolume(stream, raised, 0);
        }
    }

    private void acquireAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
                .build();
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setAcceptsDelayedFocusGain(true)
                .setWillPauseWhenDucked(false)
                .setOnAudioFocusChangeListener(audioFocusListener, mainHandler)
                .build();
            audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            audioManager.requestAudioFocus(
                audioFocusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            );
        }
    }

    private void abandonAudioFocus() {
        if (audioManager == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
            audioFocusRequest = null;
        } else {
            audioManager.abandonAudioFocus(audioFocusListener);
        }
    }

    private void setMediaOnPlayer(ExoPlayer player, String url) {
        MediaItem item = buildMediaItem(url);
        if (isHlsUrl(url)) {
            MediaSource source = new HlsMediaSource.Factory(dataSourceFactory)
                .setAllowChunklessPreparation(true)
                .createMediaSource(item);
            player.setMediaSource(source);
            return;
        }
        if (isProgressiveTsUrl(url)) {
            MediaSource source = new ProgressiveMediaSource.Factory(
                dataSourceFactory,
                extractorsFactory
            ).createMediaSource(item);
            player.setMediaSource(source);
            return;
        }
        player.setMediaItem(item);
    }

    private MediaItem buildMediaItem(String url) {
        MediaItem.Builder builder = new MediaItem.Builder().setUri(url);
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) {
            builder.setMimeType(MimeTypes.APPLICATION_M3U8);
        } else if (lower.contains(".ts")) {
            builder.setMimeType(MimeTypes.VIDEO_MP2T);
        }
        return builder.build();
    }

    @Nullable
    private static String alternateStreamUrl(String original, String active) {
        if (original == null || active == null) return null;
        String hls = toHlsVariant(original);
        if (isProgressiveTsUrl(original) && original.equals(active) && hls != null) {
            return hls;
        }
        if (isHlsUrl(active) && isProgressiveTsUrl(original)) {
            return original;
        }
        return null;
    }

    private static String toHlsVariant(String url) {
        if (url == null) return null;
        if (url.toLowerCase().contains(".m3u8")) return url;
        if (url.toLowerCase().contains(".ts")) {
            return url.replaceAll("(?i)\\.ts(\\?.*)?$", ".m3u8$1");
        }
        return null;
    }

    private static boolean isHlsUrl(String url) {
        return url != null && url.toLowerCase().contains(".m3u8");
    }

    private static boolean isProgressiveTsUrl(String url) {
        if (url == null) return false;
        String lower = url.toLowerCase();
        return lower.contains(".ts") && !lower.contains(".m3u8");
    }
}
