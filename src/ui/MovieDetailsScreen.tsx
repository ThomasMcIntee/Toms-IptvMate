import { useEffect, useRef, useState } from "react";
import { normalizeRemoteNavKey } from "../core/remoteKeys";
import type { XtreamVodInfo } from "../core/loaders/xtreamLoader";

type Props = {
  visible: boolean;
  movie: { name?: string; logo?: string } | null;
  info: XtreamVodInfo | null;
  loading: boolean;
  favoriteLabel: string;
  onPlay: () => void;
  onToggleFavorite: () => void;
  onClose: () => void;
};

export default function MovieDetailsScreen({
  visible,
  movie,
  info,
  loading,
  favoriteLabel,
  onPlay,
  onToggleFavorite,
  onClose
}: Props) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const didInitialFocusRef = useRef(false);
  const [previewOn, setPreviewOn] = useState(false);

  const title = info?.title || String(movie?.name || "Movie");
  const poster = info?.poster || (typeof movie?.logo === "string" ? movie.logo : "") || "";
  const backdrop = info?.backdrop || "";
  const hasTrailer = !!(info?.trailerEmbedUrl || info?.trailerVideoUrl);
  const plot = info?.plot || "";

  useEffect(() => {
    if (!visible) {
      setPreviewOn(false);
      didInitialFocusRef.current = false;
    }
  }, [visible, movie?.name]);

  useEffect(() => {
    if (!visible) return;

    const focusInitial = () => {
      if (didInitialFocusRef.current) return;
      didInitialFocusRef.current = true;
      overlayRef.current?.querySelector<HTMLButtonElement>(".movie-details-play")?.focus();
    };
    const timer = window.setTimeout(focusInitial, 50);

    const onKeyDown = (e: KeyboardEvent) => {
      if (document.querySelector(".vod-resume-overlay")) return;
      const overlay = overlayRef.current;
      if (!overlay) return;

      const key = normalizeRemoteNavKey(e);
      if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key)) return;

      const buttons = Array.from(
        overlay.querySelectorAll<HTMLButtonElement>(".movie-details-actions button")
      );
      if (buttons.length === 0) return;

      const active = document.activeElement as HTMLElement | null;

      e.preventDefault();
      e.stopPropagation();

      if (key === "Enter") {
        if (active instanceof HTMLButtonElement && overlay.contains(active)) {
          active.click();
          return;
        }
        buttons[0]?.focus();
        buttons[0]?.click();
        return;
      }

      const index = active instanceof HTMLButtonElement ? buttons.indexOf(active) : -1;
      if (index < 0) {
        buttons[0].focus();
        return;
      }

      if (key === "ArrowLeft") buttons[Math.max(0, index - 1)].focus();
      else if (key === "ArrowRight") buttons[Math.min(buttons.length - 1, index + 1)].focus();
      else if (key === "ArrowDown") {
        const plotEl = overlay.querySelector<HTMLElement>(".movie-details-plot");
        plotEl?.focus();
      } else if (key === "ArrowUp") {
        buttons[0].focus();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [visible, hasTrailer, favoriteLabel]);

  if (!visible) return null;

  const metaBits = [info?.year, info?.genre, info?.duration, info?.rating ? `Rating ${info.rating}` : ""]
    .map((bit) => String(bit || "").trim())
    .filter(Boolean);

  return (
    <div
      ref={overlayRef}
      className="movie-details-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      {(backdrop || poster) && (
        <div
          className="movie-details-backdrop"
          style={{ backgroundImage: `url("${(backdrop || poster).replace(/"/g, "")}")` }}
          aria-hidden="true"
        />
      )}
      <div className="movie-details-panel">
        <div className="movie-details-media">
          {previewOn && info?.trailerEmbedUrl ? (
            <iframe
              className="movie-details-trailer"
              title={`${title} trailer`}
              src={`${info.trailerEmbedUrl}&autoplay=1`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          ) : previewOn && info?.trailerVideoUrl ? (
            <video className="movie-details-trailer-video" src={info.trailerVideoUrl} controls autoPlay />
          ) : poster ? (
            <img className="movie-details-poster" src={poster} alt="" />
          ) : backdrop ? (
            <img className="movie-details-poster" src={backdrop} alt="" />
          ) : (
            <div className="movie-details-poster-fallback" aria-hidden="true">
              {title.slice(0, 1)}
            </div>
          )}
        </div>
        <div className="movie-details-body">
          <h2 className="movie-details-title">{title}</h2>
          {metaBits.length > 0 && <div className="movie-details-meta">{metaBits.join(" · ")}</div>}
          {info?.director && <div className="movie-details-credit">Director: {info.director}</div>}
          {info?.cast && <div className="movie-details-credit">Cast: {info.cast}</div>}
          {loading && <div className="movie-details-state">Loading details…</div>}
          {!loading && plot ? (
            <p className="movie-details-plot" tabIndex={-1}>
              {plot}
            </p>
          ) : !loading ? (
            <p className="movie-details-plot movie-details-plot-empty" tabIndex={-1}>
              No description is available for this title.
            </p>
          ) : null}
          <div className="movie-details-actions">
            <button type="button" className="movie-details-play" onClick={onPlay}>
              Play
            </button>
            <button type="button" className="movie-details-favorite" onClick={onToggleFavorite}>
              {favoriteLabel}
            </button>
            {hasTrailer && (
              <button type="button" className="movie-details-preview" onClick={() => setPreviewOn((on) => !on)}>
                {previewOn ? "Hide Preview" : "Preview"}
              </button>
            )}
            {!hasTrailer && !loading && (
              <span className="movie-details-preview-missing">No preview available</span>
            )}
            <button type="button" className="movie-details-close" onClick={onClose}>
              Back
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
