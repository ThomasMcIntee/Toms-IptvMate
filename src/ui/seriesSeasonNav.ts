export function focusSeriesControl(el: HTMLElement | null | undefined) {
  if (!el) return;
  el.focus();
  try {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    try {
      el.scrollIntoView();
    } catch {
      // Older WebViews may not support scrollIntoView.
    }
  }
}

function seasonRowTop(el: HTMLElement): number {
  return Math.round(el.getBoundingClientRect().top);
}

export function moveSeasonTabFocus(
  seasons: HTMLButtonElement[],
  active: HTMLElement | null,
  key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"
): "moved" | "leave" | "stay" {
  const currentIndex = seasons.indexOf(active as HTMLButtonElement);
  if (currentIndex < 0) return "stay";

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const nextIndex =
      key === "ArrowLeft"
        ? Math.max(0, currentIndex - 1)
        : Math.min(seasons.length - 1, currentIndex + 1);
    const next = seasons[nextIndex];
    if (!next) return "stay";
    selectSeasonTab(next, active);
    return "moved";
  }

  const current = seasons[currentIndex];
  const currentTop = seasonRowTop(current);
  const downward = key === "ArrowDown";
  const currentCenter =
    (current.getBoundingClientRect().left + current.getBoundingClientRect().right) / 2;

  let best: HTMLButtonElement | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const tab of seasons) {
    const top = seasonRowTop(tab);
    const onNextRow = downward ? top > currentTop + 8 : top < currentTop - 8;
    if (!onNextRow) continue;
    const center = (tab.getBoundingClientRect().left + tab.getBoundingClientRect().right) / 2;
    const score = Math.abs(top - currentTop) * 20 + Math.abs(center - currentCenter);
    if (score < bestScore) {
      bestScore = score;
      best = tab;
    }
  }

  if (best) {
    selectSeasonTab(best, active);
    return "moved";
  }

  return "leave";
}

function selectSeasonTab(next: HTMLButtonElement, active: HTMLElement | null) {
  focusSeriesControl(next);
  if (next !== active) next.click();
}

export function restoreActiveSeasonTabFocus(overlay: HTMLElement | null) {
  if (!overlay) return;
  const active = document.activeElement as HTMLElement | null;
  if (!active || !overlay.contains(active)) return;
  if (!active.classList.contains("series-season-tab")) return;
  const selected = overlay.querySelector<HTMLButtonElement>(".series-season-tab-active");
  if (selected && selected !== active) {
    focusSeriesControl(selected);
  }
}
