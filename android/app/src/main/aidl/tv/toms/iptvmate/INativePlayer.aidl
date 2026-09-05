package tv.toms.iptvmate;

interface INativePlayer {
    void play(String url);
    void setSurface(in android.view.Surface surface);
    void stop();
}
