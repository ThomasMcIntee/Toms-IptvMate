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

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void warmUp(PluginCall call) {
        manager().warmUp();
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
        manager().pause();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        manager().resume();
        call.resolve();
    }

    @PluginMethod
    public void setMuted(PluginCall call) {
        manager().setMuted(Boolean.TRUE.equals(call.getBoolean("muted", false)));
        call.resolve();
    }

    @PluginMethod
    public void setGuide(PluginCall call) {
        String title = call.getString("title", "");
        Double start = call.getDouble("startMs");
        Double end = call.getDouble("endMs");
        manager().setGuide(
            title != null ? title : "",
            start != null ? start.longValue() : 0L,
            end != null ? end.longValue() : 0L
        );
        call.resolve();
    }

    @PluginMethod
    public void revealControls(PluginCall call) {
        manager().revealControls();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        manager().stop();
        call.resolve();
    }

    @PluginMethod
    public void setBounds(PluginCall call) {
        manager().setBounds(
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
