package tv.toms.iptvmate;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;
import org.json.JSONTokener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

final class XtreamCatalogSlimmer {
    private static final String TAG = "IPTVMate_XtreamSlim";
    private static final int MAX_BODY_BYTES = 48 * 1024 * 1024;

    private XtreamCatalogSlimmer() {}

    static byte[] readLimited(InputStream stream, int maxBytes) throws Exception {
        if (stream == null) return new byte[0];
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.min(maxBytes, 256 * 1024));
        byte[] buf = new byte[16 * 1024];
        int total = 0;
        int read;
        while ((read = stream.read(buf)) != -1) {
            total += read;
            if (total > maxBytes) {
                Log.w(TAG, "catalog body exceeded native cap");
                return null;
            }
            out.write(buf, 0, read);
        }
        return out.toByteArray();
    }

    static byte[] slimIfCatalog(byte[] raw, String targetUrl) {
        if (raw == null || raw.length == 0 || targetUrl == null) return raw;
        boolean live = hasAction(targetUrl, "get_live_streams");
        boolean vod = hasAction(targetUrl, "get_vod_streams");
        boolean series = hasAction(targetUrl, "get_series")
            && !hasAction(targetUrl, "get_series_info")
            && !hasAction(targetUrl, "get_series_categories");
        if (!live && !vod && !series) return raw;

        try {
            Object parsed = new JSONTokener(new String(raw, StandardCharsets.UTF_8)).nextValue();
            JSONArray in = asArray(parsed);
            if (in == null) return raw;

            JSONArray out = new JSONArray();
            for (int i = 0; i < in.length(); i++) {
                JSONObject item = in.optJSONObject(i);
                if (item == null) continue;
                JSONObject slim = new JSONObject();
                if (series) {
                    copy(item, slim, "series_id", "name", "category_id", "category_name", "cover", "stream_icon");
                } else if (vod) {
                    copy(item, slim, "stream_id", "name", "category_id", "category_name", "container_extension", "stream_icon", "cover");
                } else {
                    copy(item, slim, "stream_id", "name", "category_id", "category_name", "container_extension", "epg_channel_id");
                }
                out.put(slim);
            }
            byte[] slimmed = out.toString().getBytes(StandardCharsets.UTF_8);
            Log.i(TAG, "slimmed catalog " + raw.length + " -> " + slimmed.length + " bytes, items=" + out.length());
            return slimmed;
        } catch (Exception e) {
            Log.w(TAG, "catalog slim failed, using original body");
            return raw;
        }
    }

    private static boolean hasAction(String url, String action) {
        return url.contains("action=" + action + "&") || url.endsWith("action=" + action);
    }

    private static void copy(JSONObject from, JSONObject to, String... keys) {
        for (String key : keys) {
            if (from.has(key) && !from.isNull(key)) {
                try {
                    to.put(key, from.get(key));
                } catch (Exception ignored) {
                    // Skip a single field rather than failing the catalog.
                }
            }
        }
    }

    private static JSONArray asArray(Object parsed) {
        if (parsed instanceof JSONArray) return (JSONArray) parsed;
        if (!(parsed instanceof JSONObject)) return null;
        JSONObject obj = (JSONObject) parsed;
        String[] wrapped = {"result", "data", "vod", "series", "items", "channels", "js"};
        for (String key : wrapped) {
            Object inner = obj.opt(key);
            JSONArray extracted = asArray(inner);
            if (extracted != null && extracted.length() > 0) return extracted;
        }
        JSONArray numeric = new JSONArray();
        JSONArray names = obj.names();
        if (names == null || names.length() == 0) return null;
        boolean allNumeric = true;
        for (int i = 0; i < names.length(); i++) {
            String name = names.optString(i, "");
            if (!name.matches("\\d+")) {
                allNumeric = false;
                break;
            }
            numeric.put(obj.opt(name));
        }
        return allNumeric && numeric.length() > 0 ? numeric : null;
    }
}
