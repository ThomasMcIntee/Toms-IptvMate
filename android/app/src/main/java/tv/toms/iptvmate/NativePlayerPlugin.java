package tv.toms.iptvmate;

import android.util.Log;

import com.getcapacitor.JSArray;
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
    public void focusControls(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.focusControls();
        call.resolve();
    }

    @PluginMethod
    public void moveControlFocus(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.moveControlFocus(call.getInt("delta", 0));
        call.resolve();
    }

    @PluginMethod
    public void activateSelectedControl(PluginCall call) {
        ExoPlayerManager player = manager();
        if (!requireManager(call, player)) return;
        player.activateSelectedControl();
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
    public void getAudioTracks(PluginCall call) {
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            JSArray tracks = new JSArray();
            for (NativeExoPlayerController.AudioTrackOption track : manager().getAudioTracks()) {
                JSObject item = new JSObject();
                item.put("id", track.id);
                item.put("language", track.language);
                item.put("label", track.label);
                item.put("selected", track.selected);
                tracks.put(item);
            }
            JSObject ret = new JSObject();
            ret.put("tracks", tracks);
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void setAudioTrack(PluginCall call) {
        String id = call.getString("id");
        if (id == null || id.trim().isEmpty()) {
            call.reject("Missing audio track id");
            return;
        }
        MainActivity activity = (MainActivity) getActivity();
        if (activity == null) {
            call.reject("Activity unavailable");
            return;
        }
        activity.runOnUiThread(() -> {
            boolean ok = manager().setAudioTrack(id.trim());
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            if (ok) {
                call.resolve(ret);
            } else {
                call.reject("Audio track was not available");
            }
        });
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
