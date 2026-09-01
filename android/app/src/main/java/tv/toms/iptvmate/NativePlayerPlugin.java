package tv.toms.iptvmate;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NativePlayer")
public class NativePlayerPlugin extends Plugin {

    private ExoPlayerManager manager() {
        return ((MainActivity) getActivity()).getOrCreateExoPlayerManager();
    }

    private ExoPlayerManager existingManager() {
        MainActivity activity = (MainActivity) getActivity();
        return activity != null ? activity.peekExoPlayerManager() : null;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void warmUp(PluginCall call) {
        // Do not instantiate Media3 on the opening menu — that ANRs Fire TV.
        ExoPlayerManager existing = existingManager();
        if (existing != null) {
            existing.warmUp();
        }
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing url");
            return;
        }

        // "movie"/"series" play as progressive VOD; anything else is live.
        String contentType = call.getString("contentType", "live");
        boolean isLive = !"movie".equals(contentType) && !"series".equals(contentType);
        Log.i("IPTVMate_NativePlayer", "plugin play isLive=" + isLive + " url=" + url);
        manager().play(url, isLive);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        ExoPlayerManager existing = existingManager();
        if (existing != null) {
            existing.pause();
        }
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        ExoPlayerManager existing = existingManager();
        if (existing != null) {
            existing.resume();
        }
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        ExoPlayerManager existing = existingManager();
        if (existing != null) {
            existing.setMuted(Boolean.TRUE.equals(call.getBoolean("muted", false)));
        }
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ExoPlayerManager existing = existingManager();
        if (existing != null) {
            existing.stop();
        }
        call.resolve();
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        ExoPlayerManager existing = existingManager();
        if (existing == null) {
            call.resolve();
            return;
        }
        existing.setBounds(
            call.getInt("left", 0),
            call.getInt("top", 0),
            call.getInt("width", 0),
            call.getInt("height", 0),
            call.getInt("viewportWidth", 0),
            call.getInt("viewportHeight", 0)
        );
        call.resolve();
    }
}
