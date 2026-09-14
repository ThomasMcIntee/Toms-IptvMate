import { useEffect, useRef } from "react";
import { translate, useAppLanguage, type AppTranslationKey } from "../core/appLanguage";
import { normalizeRemoteNavKey } from "../core/remoteKeys";

type Props = {
  visible: boolean;
  onClose: () => void;
};

type HelpSection = {
  title: string;
  items: string[];
};

const HELP_SECTIONS: Record<string, HelpSection[]> = {
  en: [
    {
      title: "Remote basics",
      items: [
        "D-pad / arrows move between buttons, lists, and posters.",
        "OK / Select / Enter chooses the highlighted item.",
        "Back goes back one screen. From the main menu, Back exits the app.",
        "On a keyboard, Esc works like Back and also reopens the main menu."
      ]
    },
    {
      title: "Main menu",
      items: [
        "Live TV, Movies, and Series open your loaded content.",
        "If you have no playlist yet, Live TV takes you to Playlist Manager so you can add one.",
        "Playlist Manager is where you add, load, and hide or show categories.",
        "TV Guide Search shows what is on now.",
        "Setup has login codes, theme, buffer, language, and child hours.",
        "Logout signs out of the current profile."
      ]
    },
    {
      title: "Playlist Manager",
      items: [
        "Add Playlist saves Xtream, M3U, or Stalker details.",
        "Load downloads Live TV, Movies, Series, and the TV Guide for that playlist.",
        "Tick boxes hide or show categories. Save Adult or Child visibility to keep those choices.",
        "Live TV / Movies / Series on this screen open those libraries from the saved list.",
        "Movies, Series, and the TV Guide also refresh quietly in the background, at most once a day."
      ]
    },
    {
      title: "Live TV",
      items: [
        "Left column is categories. Right column is channels. OK plays the channel.",
        "The star marks a favourite.",
        "While watching, Play/Pause, Rewind, and Fast Forward work on the remote. OK or space also pauses.",
        "Down or Up while watching shows the player bar. OK on a bar button uses it.",
        "Back leaves fullscreen, then stops and returns to the previous screen.",
        "Info (I on a keyboard) shows Now / Next."
      ]
    },
    {
      title: "Movies and Series",
      items: [
        "Arrows move across posters. OK opens details.",
        "Search and Sort sit on the top bar. Search uses the on-screen keyboard on a TV remote.",
        "Series: pick a season, then an episode.",
        "While a title is playing, Left / Right skip 15 seconds, OK play/pauses, and Back exits.",
        "The player bar also has mute, favourite, and audio language when the stream has more than one."
      ]
    },
    {
      title: "TV Guide",
      items: [
        "D-pad moves Close, search, categories, and programme rows.",
        "OK on a listing tunes that channel when it is available.",
        "Back closes the guide. Listings stay put while the guide is open."
      ]
    },
    {
      title: "Setup",
      items: [
        "D-pad moves around the setup grid. OK opens a control.",
        "If Child Hours is open, Back closes that overlay first, then Back again leaves Setup."
      ]
    },
    {
      title: "Keyboard extras",
      items: [
        "While watching: Space play/pause, M mute, F fullscreen.",
        "R refreshes TV Guide data now. P opens this Help screen."
      ]
    }
  ]
};

export default function HelpScreen({ visible, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const language = useAppLanguage();
  const t = (key: AppTranslationKey) => translate(key, language);
  const sections = HELP_SECTIONS[language] || HELP_SECTIONS.en;

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => {
      rootRef.current?.querySelector<HTMLButtonElement>(".help-screen-close")?.focus();
    }, 60);
    return () => window.clearTimeout(timer);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      const body = bodyRef.current;
      if (!root || !body) return;

      const key = normalizeRemoteNavKey(event);
      if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Enter") return;

      const active = document.activeElement as HTMLElement | null;
      if (active && !root.contains(active) && active !== document.body) return;

      if (key === "Enter") {
        if (active?.classList.contains("help-screen-close")) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      const step = Math.max(80, Math.floor(body.clientHeight * 0.35));
      body.scrollBy({ top: key === "ArrowDown" ? step : -step, behavior: "smooth" });
      root.querySelector<HTMLButtonElement>(".help-screen-close")?.focus();
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [visible, onClose]);

  if (!visible) return null;

  return (
    <div
      ref={rootRef}
      className="help-screen"
      role="dialog"
      aria-modal="true"
      aria-label={t("help")}
    >
      <div className="help-screen-panel">
        <div className="help-screen-header">
          <h2>{t("help")}</h2>
          <button type="button" className="btn-secondary help-screen-close" onClick={onClose}>
            {t("helpClose")}
          </button>
        </div>
        <div ref={bodyRef} className="help-screen-body">
          <p className="help-screen-intro">
            Use the D-pad to move, OK to choose, and Back to go back. Down and Up here also scroll this page.
          </p>
          {sections.map((section) => (
            <section key={section.title} className="help-screen-section">
              <h3>{section.title}</h3>
              <ul>
                {section.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
