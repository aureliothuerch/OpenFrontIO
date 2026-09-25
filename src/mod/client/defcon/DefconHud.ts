import { html, LitElement, type TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../../../client/Utils";
import type { BannerText, IndicatorText, TextRef } from "./DefconText";

/** Everything the HUD shows. Pushed by DefconController every tick. */
export interface DefconHudView {
  readonly level: number;
  /** The permanent "DEFCON X" box; null hides it. */
  readonly indicator: IndicatorText | null;
  /** The banner of a change that is being announced; null hides it. */
  readonly banner: BannerText | null;
}

/** Title colour per level, from calm (5) to alarm (1). */
const LEVEL_COLOR: Readonly<Record<number, string>> = {
  5: "text-sky-300",
  4: "text-green-400",
  3: "text-yellow-300",
  2: "text-orange-400",
  1: "text-red-500",
};

/**
 * The DEFCON indicator (top right, under the timer) and the change banner.
 * Light DOM, so the page's Tailwind classes apply. Renders only what the
 * controller pushed: it never reads the game.
 */
@customElement("mod-defcon-hud")
export class DefconHud extends LitElement {
  /** Mounted outside the sidebar stack: position the indicator itself. */
  public floating = false;

  @state()
  private view: DefconHudView | null = null;
  /** The last view pushed, serialised, to skip renders when nothing changed. */
  private viewKey = "";

  createRenderRoot() {
    return this;
  }

  show(view: DefconHudView): void {
    const key = JSON.stringify(view);
    if (key === this.viewKey) return;
    this.viewKey = key;
    this.view = view;
  }

  /** Hides everything; called at the start of every game. */
  reset(): void {
    this.viewKey = "";
    this.view = null;
  }

  render() {
    const view = this.view;
    if (view === null) return null;
    return html`
      ${view.indicator === null
        ? null
        : this.renderIndicator(view.level, view.indicator)}
      ${view.banner === null ? null : this.renderBanner(view.banner)}
    `;
  }

  private renderIndicator(
    level: number,
    indicator: IndicatorText,
  ): TemplateResult {
    const color = LEVEL_COLOR[level] ?? "text-white";
    return html`
      <div
        class="${this.floating
          ? "fixed top-12 right-0 z-[1000]"
          : ""} w-fit flex flex-col items-end gap-0.5 py-1.5 px-3 bg-gray-800/92 backdrop-blur-sm shadow-xs rounded-l-lg text-white pointer-events-none"
        role="status"
      >
        <span class="text-sm lg:text-base font-bold tracking-widest ${color}">
          ${text(indicator.title)}
        </span>
        ${indicator.hint === null
          ? null
          : html`<span class="text-xs text-gray-300">
              ${text(indicator.hint)}
            </span>`}
      </div>
    `;
  }

  private renderBanner(banner: BannerText): TemplateResult {
    const line = bannerLine(banner);
    return html`
      <div
        class="fixed top-[22%] left-1/2 -translate-x-1/2 z-[800] pointer-events-none
               flex flex-col items-center gap-1 w-fit max-w-[90vw]
               px-4 lg:px-6 py-2 lg:py-3 rounded-md lg:rounded-lg
               bg-red-900/85 border border-red-500 shadow-lg backdrop-blur-xs
               text-white text-center break-words"
        role="alert"
      >
        <div class="text-2xl lg:text-4xl font-bold tracking-widest">
          ${text(banner.title)}
        </div>
        ${line === null
          ? null
          : html`<div class="text-sm lg:text-lg text-red-100">${line}</div>`}
      </div>
    `;
  }
}

function text(ref: TextRef): string {
  return translateText(ref.key, ref.params);
}

/** The banner's second line; unit names are joined into {units}. */
function bannerLine(banner: BannerText): string | null {
  if (banner.line === null) return null;
  if (banner.unitKeys.length === 0) return text(banner.line);
  const units = banner.unitKeys.map((key) => translateText(key)).join(", ");
  return translateText(banner.line.key, { ...banner.line.params, units });
}
