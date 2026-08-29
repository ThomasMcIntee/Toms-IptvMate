package tv.toms.iptvmate;

import android.content.Context;
import android.content.Intent;

/**
 * Cross-process playback events between {@link NativePlayerActivity} (:nativeplayer)
 * and {@link MainActivity} (WebView UI).
 */
public final class NativePlayerEvents {
    public static final String ACTION_READY = "tv.toms.iptvmate.NATIVE_PLAYER_READY";
    public static final String ACTION_ERROR = "tv.toms.iptvmate.NATIVE_PLAYER_ERROR";
    public static final String ACTION_STOPPED = "tv.toms.iptvmate.NATIVE_PLAYER_STOPPED";
    public static final String EXTRA_MESSAGE = "message";

    private NativePlayerEvents() {}

    private static void send(Context context, String action) {
        Intent intent = new Intent(action);
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
    }

    public static void sendReady(Context context) {
        send(context, ACTION_READY);
    }

    public static void sendError(Context context, String message) {
        Intent intent = new Intent(ACTION_ERROR);
        intent.setPackage(context.getPackageName());
        intent.putExtra(EXTRA_MESSAGE, message != null ? message : "Native playback failed");
        context.sendBroadcast(intent);
    }

    public static void sendStopped(Context context) {
        send(context, ACTION_STOPPED);
    }
}
