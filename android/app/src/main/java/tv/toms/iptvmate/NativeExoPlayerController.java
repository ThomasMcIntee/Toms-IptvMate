package tv.toms.iptvmate;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.hls.HlsMediaSource;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.exoplayer.source.MediaSource;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.extractor.ts.TsExtractor;
import androidx.media3.ui.PlayerView;

/**
 * ExoPlayer owned by {@link MainActivity}. Uses {@link PlayerView} so Fire TV routes HDMI audio.
 */
public class NativeExoPlayerController {
    public interface Callback {
        void onReady();
        void onError(String message);
        void onStopped();
        void onEnded();
    }

    private static final String TAG = "IPTVMate_NativeExo";
    private static final String USER_AGENT = "TiviMate/4.7.0 (Linux; Android 9; AFTKM Build/PS7279)";

    private final Context playbackContext;
    private final Handler mainHandler;
    private final Callback callback;

    private ExoPlayer exoPlayer;
    private PlayerView playerView;
    private DefaultHttpDataSource.Factory dataSourceFactory;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;

    private String originalStreamUrl;
    private String activeStreamUrl;
    private boolean triedTsFallback = false;
    private boolean isLiveContent = true;
    private boolean muted = false;

    private final AudioManager.OnAudioFocusChangeListener audioFocusListener = focusChange ->
        Log.i(TAG, "audioFocusChange=" + focusChange + " (ignored — no duck/pause on Fire TV)");

    public NativeExoPlayerController(Context activityContext, Callback callback) {
        // Activity context — ApplicationContext breaks HDMI audio routing on Fire TV.
        this.playbackContext = activityContext;
        this.callback = callback;
        this.mainHandler = new Handler(Looper.getMainLooper());
        this.audioManager = (AudioManager) playbackContext.getSystemService(Context.AUDIO_SERVICE);
    }

    public void attachPlayerView(@Nullable PlayerView view) {
        runOnMain(() -> {
            playerView = view;
            if (exoPlayer != null && playerView != null) {
                playerView.setPlayer(exoPlayer);
            }
        });
    }

    public void play(String url) {
        // Legacy entry point — treated as live (matches original behavior).
        play(url, true);
    }

    public void play(String url, boolean isLive) {
        if (url == null || url.trim().isEmpty()) return;

        final String trimmed = url.trim();
        // Capacitor plugin methods run on the CapacitorPlugins thread. ExoPlayer is
        // bound to the main looper, so every player call must hop to main first.
        runOnMain(() -> {
            isLiveContent = isLive;
            muted = false;
            originalStreamUrl = trimmed;
            // Only live streams get the .ts -> .m3u8 HLS preference. Rewriting a VOD
            // .ts movie/episode to .m3u8 targets a playlist that usually doesn't exist
            // and breaks progressive playback.
            activeStreamUrl = isLive ? preferHlsUrl(originalStreamUrl) : originalStreamUrl;
            triedTsFallback = false;
            Log.i(TAG, "play original=" + originalStreamUrl + " active=" + activeStreamUrl + " isLive=" + isLive);
            preparePlayer();
        });
    }

    public void pause() {
        runOnMain(() -> {
            if (exoPlayer != null) {
                exoPlayer.pause();
            }
        });
    }

    public void resume() {
        runOnMain(() -> {
            if (exoPlayer != null) {
                exoPlayer.play();
            }
        });
    }

    public void setMuted(boolean muted) {
        runOnMain(() -> {
            this.muted = muted;
            if (exoPlayer != null) {
                exoPlayer.setVolume(muted ? 0f : 1f);
            }
        });
    }

    public void togglePlayPause() {
        runOnMain(() -> {
            if (exoPlayer == null) return;
            if (exoPlayer.getPlayWhenReady()) {
                exoPlayer.pause();
            } else {
                exoPlayer.play();
            }
        });
    }

    public void toggleMuted() {
        setMuted(!muted);
    }

    public boolean isPlaybackPaused() {
        return exoPlayer == null || !exoPlayer.getPlayWhenReady();
    }

    public boolean isMuted() {
        return muted;
    }

    public void stop() {
        runOnMain(() -> {
            Log.i(TAG, "stopPlayback");
            abandonAudioFocus();
            if (exoPlayer != null) {
                exoPlayer.stop();
                exoPlayer.clearMediaItems();
                exoPlayer.setPlayWhenReady(false);
            }
            callback.onStopped();
        });
    }

    public void release() {
        runOnMain(() -> {
            Log.i(TAG, "stopPlayback");
            abandonAudioFocus();
            if (exoPlayer != null) {
                exoPlayer.stop();
                exoPlayer.clearMediaItems();
                exoPlayer.release();
                exoPlayer = null;
            }
            if (playerView != null) {
                playerView.setPlayer(null);
            }
            playerView = null;
            callback.onStopped();
        });
    }

    private void runOnMain(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            action.run();
        } else {
            mainHandler.post(action);
        }
    }

    private void preparePlayer() {
        try {
            if (dataSourceFactory == null) {
                dataSourceFactory = new DefaultHttpDataSource.Factory()
                    .setUserAgent(USER_AGENT)
                    .setAllowCrossProtocolRedirects(true)
                    .setConnectTimeoutMs(15000)
                    .setReadTimeoutMs(15000)
                    .setDefaultRequestProperties(java.util.Collections.singletonMap("Accept", "*/*"));
            }

            if (exoPlayer == null) {
                exoPlayer = buildExoPlayer();
                if (playerView != null) {
                    playerView.setPlayer(exoPlayer);
                }
            }

            ensureSystemAudible();
            acquireAudioFocus();
            if (playerView != null) {
                playerView.setKeepContentOnPlayerReset(false);
                playerView.setShutterBackgroundColor(android.graphics.Color.BLACK);
            }
            exoPlayer.stop();
            exoPlayer.clearMediaItems();
            exoPlayer.setVolume(muted ? 0f : 1f);
            setMediaOnPlayer(exoPlayer, activeStreamUrl, isLiveContent);
            exoPlayer.prepare();
            exoPlayer.setPlayWhenReady(true);
            logAudioDiagnostics("prepare");
            Log.i(TAG, "prepare hls=" + isHlsUrl(activeStreamUrl) + " volume=" + exoPlayer.getVolume());
        } catch (Exception e) {
            Log.e(TAG, "prepare failed", e);
            callback.onError("Failed to start native playback");
        }
    }

    private ExoPlayer buildExoPlayer() {
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
            .setBufferDurationsMs(1500, 5000, 500, 1000)
            .setTargetBufferBytes(512 * 1024)
            .setPrioritizeTimeOverSizeThresholds(true)
            .setBackBuffer(0, false)
            .build();

        DefaultExtractorsFactory extractorsFactory = new DefaultExtractorsFactory()
            .setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES)
            .setTsExtractorTimestampSearchBytes(1500 * TsExtractor.TS_PACKET_SIZE);

        DefaultMediaSourceFactory mediaSourceFactory = new DefaultMediaSourceFactory(
            dataSourceFactory,
            extractorsFactory
        );

        DefaultRenderersFactory renderersFactory = new DefaultRenderersFactory(playbackContext)
            .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
            .setEnableDecoderFallback(true);

        ExoPlayer player = new ExoPlayer.Builder(playbackContext)
            .setLooper(Looper.getMainLooper())
            .setRenderersFactory(renderersFactory)
            .setMediaSourceFactory(mediaSourceFactory)
            .setLoadControl(loadControl)
            .build();

        try {
            androidx.media3.common.AudioAttributes attrs =
                new androidx.media3.common.AudioAttributes.Builder()
                    .setUsage(C.USAGE_MEDIA)
                    .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                    .build();
            player.setAudioAttributes(attrs, false);
            player.setHandleAudioBecomingNoisy(false);
            player.setWakeMode(C.WAKE_MODE_NETWORK);
            player.setVolume(1f);
        } catch (RuntimeException e) {
            player.release();
            throw e;
        }

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                if (playbackState == Player.STATE_READY) {
                    ensureSystemAudible();
                    player.setVolume(muted ? 0f : 1f);
                    logAudioDiagnostics("ready");
                    Log.i(TAG, "Playback ready volume=" + player.getVolume()
                        + " playing=" + player.isPlaying());
                    callback.onReady();
                } else if (playbackState == Player.STATE_ENDED) {
                    Log.i(TAG, "Playback ended");
                    callback.onEnded();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "Playback error url=" + activeStreamUrl, error);
                if (isLiveContent
                    && !triedTsFallback
                    && originalStreamUrl != null
                    && isProgressiveTsUrl(originalStreamUrl)
                    && !originalStreamUrl.equals(activeStreamUrl)) {
                    triedTsFallback = true;
                    activeStreamUrl = originalStreamUrl;
                    Log.i(TAG, "HLS failed, retrying TS");
                    preparePlayer();
                    return;
                }

                String message = error.getMessage() != null ? error.getMessage() : "Native playback failed";
                callback.onError(message);
            }
        });

        return player;
    }

    private void ensureSystemAudible() {
        if (audioManager == null) return;

        audioManager.setMode(AudioManager.MODE_NORMAL);
        int stream = AudioManager.STREAM_MUSIC;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && audioManager.isStreamMute(stream)) {
            audioManager.adjustStreamVolume(stream, AudioManager.ADJUST_UNMUTE, 0);
            Log.i(TAG, "Unmuted STREAM_MUSIC");
        }
        int vol = audioManager.getStreamVolume(stream);
        if (vol == 0) {
            int raised = Math.max(1, audioManager.getStreamMaxVolume(stream) / 2);
            audioManager.setStreamVolume(stream, raised, 0);
            Log.i(TAG, "Raised STREAM_MUSIC from 0 to " + raised);
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
            int result = audioManager.requestAudioFocus(audioFocusRequest);
            Log.i(TAG, "requestAudioFocus result=" + result);
        } else {
            int result = audioManager.requestAudioFocus(
                audioFocusListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN
            );
            Log.i(TAG, "requestAudioFocus legacy result=" + result);
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

    private void logAudioDiagnostics(String phase) {
        if (audioManager == null) return;

        int stream = AudioManager.STREAM_MUSIC;
        int vol = audioManager.getStreamVolume(stream);
        int max = audioManager.getStreamMaxVolume(stream);
        boolean muted = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            muted = audioManager.isStreamMute(stream);
        }
        Log.i(TAG, "audioDiag[" + phase + "] streamVol=" + vol + "/" + max
            + " muted=" + muted
            + " mode=" + audioManager.getMode()
            + " exoVol=" + (exoPlayer != null ? exoPlayer.getVolume() : -1)
            + " playWhenReady=" + (exoPlayer != null ? exoPlayer.getPlayWhenReady() : false));
    }

    private void setMediaOnPlayer(ExoPlayer player, String url, boolean isLive) {
        if (isHlsUrl(url)) {
            MediaSource source = new HlsMediaSource.Factory(dataSourceFactory)
                .setAllowChunklessPreparation(true)
                .createMediaSource(buildMediaItem(url, isLive));
            player.setMediaSource(source);
            return;
        }
        player.setMediaItem(buildMediaItem(url, isLive));
    }

    private MediaItem buildMediaItem(String url, boolean isLive) {
        MediaItem.Builder builder = new MediaItem.Builder().setUri(url);
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) {
            builder.setMimeType(MimeTypes.APPLICATION_M3U8);
            if (isLive) {
                builder.setLiveConfiguration(
                    new MediaItem.LiveConfiguration.Builder()
                        .setTargetOffsetMs(3000)
                        .setMinOffsetMs(1500)
                        .setMaxOffsetMs(8000)
                        .build()
                );
            }
        } else if (lower.contains(".ts")) {
            builder.setMimeType(MimeTypes.VIDEO_MP2T);
        }
        return builder.build();
    }

    private static String preferHlsUrl(String url) {
        if (url == null) return null;
        String lower = url.toLowerCase();
        if (lower.contains(".m3u8")) return url;
        if (lower.contains(".ts")) {
            return url.replaceAll("(?i)\\.ts(\\?.*)?$", ".m3u8$1");
        }
        return url;
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
