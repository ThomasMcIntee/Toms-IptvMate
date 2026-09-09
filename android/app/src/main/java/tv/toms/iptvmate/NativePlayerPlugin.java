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
        if (!(getActivity() instanceof MainActivity)) return null;
        return ((MainActivity) getActivity()).getOrCreateExoPlayerManager();
    }

    private boolean requireManager(PluginCall call, ExoPlayerManager manager) {
        if (manager != null) return true;
        call.reject("Native player is not ready");
        return false;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void warmUp(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.warmUp();
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.trim().isEmpty()) {
            call.reject("Missing url");
            return;
        }

        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;

        // "movie"/"series" play as progressive VOD; anything else is live.
        String contentType = call.getString("contentType", "live");
        boolean isLive = !"movie".equals(contentType) && !"series".equals(contentType);
        Log.i("IPTVMate_NativePlayer", "plugin play isLive=" + isLive + " url=" + url);
        player.play(url, isLive);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.resume();
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.setMuted(Boolean.TRUE.equals(call.getBoolean("muted", false)));
        call.resolve();
    }

    @PluginMethod
    public void setGuide(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        String title = call.getString("title", "");
        Double start = call.getDouble("startMs");
        Double end = call.getDouble("endMs");
        player.setGuide(
            title != null ? title : "",
            start != null ? start.longValue() : 0L,
            end != null ? end.longValue() : 0L
        );
        call.resolve();
    }

    @PluginMethod
    public void revealControls(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.revealControls();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.stop();
        call.resolve();
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        if (getActivity() == null) {
            call.reject("Activity is not available");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                getActivity().finishAffinity();
            } catch (Exception ignored) {
                if (getActivity() != null) {
                    getActivity().finish();
                }
            }
        });
        call.resolve();
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.setBounds(
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
