import { html, nothing, type TemplateResult } from "lit";
import type { TooltipItem } from "../../../client/hud/layers/RadialMenu";
import type {
  MenuElement,
  MenuElementParams,
} from "../../../client/hud/layers/RadialMenuElements";
import { showToast, translateText } from "../../../client/Utils";
import type { GameView } from "../../../client/view";
import type { Gold, UnitType } from "../../../core/game/Game";
import { blocksUnit, NUKE_WEAPON_TYPES } from "../../core/defcon/DefconRules";
import { defconClientState } from "./DefconClientState";
import { defconLockedHint, type TextRef } from "./DefconText";

/**
 * What the build menus call (MOD hooks in UnitDisplay, BuildMenu and
 * RadialMenuElements). Reads the client state the DefconController keeps per
 * GameView and returns neutral values (upstream behaviour) when DEFCON is off
 * or not started for that game.
 *
 * The red look and the "Only available from DEFCON 2" hint only appear for a
 * nuke type that is locked by DEFCON alone: never for a type the host
 * disabled, never when nukes are impossible, never once the game is over (the
 * rules live in DefconText.defconLockedHint).
 */

/** Hotbar: DEFCON blocks this unit type right now (same rule as the core). */
export function modDefconBlocksUnitView(
  game: GameView | null | undefined,
  unitType: UnitType,
): boolean {
  const state = defconClientState(game);
  if (state === null || game === null || game === undefined) return false;
  return blocksUnit(state.level, unitType, state.tuning, state.gameOver);
}

/** The translated red hint for a DEFCON-locked nuke button, or null. */
export function modDefconLockedHint(
  game: GameView | null | undefined,
  unitType: UnitType,
): string | null {
  const ref = lockedHintRef(game, unitType);
  return ref === null ? null : translateText(ref.key, ref.params);
}

function lockedHintRef(
  game: GameView | null | undefined,
  unitType: UnitType,
): TextRef | null {
  const state = defconClientState(game);
  if (state === null || game === null || game === undefined) return null;
  return defconLockedHint(
    unitType,
    state.level,
    state.tuning,
    game.config(),
    state.gameOver,
  );
}

// ---------------------------------------------------------------- hotbar

/**
 * Extra classes for a hotbar button: red while locked by DEFCON. Important
 * (trailing "!"), because they must win over the button's own "opacity-40"
 * and hover background.
 */
export function modDefconHotbarClass(
  game: GameView | null | undefined,
  unitType: UnitType,
): string {
  if (lockedHintRef(game, unitType) === null) return "";
  return "opacity-90! border-red-500! bg-red-900/60!";
}

/** A red line for the hotbar's hover tooltip while locked by DEFCON. */
export function modDefconHotbarHint(
  game: GameView | null | undefined,
  unitType: UnitType,
): TemplateResult | null {
  const hint = modDefconLockedHint(game, unitType);
  if (hint === null) return null;
  return html`<div class="px-2 pb-1 font-bold text-red-400">${hint}</div>`;
}

// ------------------------------------------------------------ build menu

/**
 * Inline style for a build menu button (the menu uses shadow DOM, so our
 * classes would not reach it): red while locked by DEFCON, else no attribute.
 */
export function modDefconBuildButtonStyle(
  game: GameView | null | undefined,
  unitType: UnitType,
): string | typeof nothing {
  if (lockedHintRef(game, unitType) === null) return nothing;
  return "background-color: #450a0a; border-color: #ef4444;";
}

/**
 * The build menu button's native tooltip. Upstream says "Not enough money"
 * for every disabled button. When DEFCON is what locks the nuke and the player
 * can afford it, that would be wrong: no tooltip then, only the red DEFCON
 * hint. When gold is missing as well, upstream's text stays.
 */
export function modDefconBuildTitle(
  game: GameView | null | undefined,
  unitType: UnitType,
  cost: Gold,
  upstreamTitle: string,
): string {
  if (lockedHintRef(game, unitType) === null) return upstreamTitle;
  const gold = game?.myPlayer()?.gold() ?? 0n;
  return gold >= cost ? "" : upstreamTitle;
}

/**
 * The red hint inside a DEFCON-locked build menu button. Shown on hover (which
 * also matches disabled buttons), always on touch screens without hover. The
 * style element is scoped to the menu's shadow root.
 */
export function modDefconBuildHint(
  game: GameView | null | undefined,
  unitType: UnitType,
): TemplateResult | null {
  const hint = modDefconLockedHint(game, unitType);
  if (hint === null) return null;
  return html`<style>
      .mod-defcon-hint {
        display: none;
        position: absolute;
        top: 6px;
        left: 6px;
        right: 6px;
        padding: 3px 4px;
        border-radius: 6px;
        background-color: rgba(127, 29, 29, 0.95);
        color: #fecaca;
        font-size: 11px;
        font-weight: bold;
        line-height: 1.2;
        text-align: center;
        pointer-events: none;
      }
      .build-button:hover .mod-defcon-hint {
        display: block;
      }
      @media (hover: none) {
        .mod-defcon-hint {
          display: block;
        }
      }
    </style>
    <span class="mod-defcon-hint">${hint}</span>`;
}

// ----------------------------------------------------------- radial menu

/** Dark red: the attack submenu's normal red already means "available". */
const RADIAL_LOCKED_COLOR = "#7f1d1d";
/** RadialMenu's own fallback fill. */
const RADIAL_DEFAULT_COLOR = "#1e3a5f";
const RADIAL_HINT_CLASS = "mod-defcon-locked";

let radialStyleInjected = false;

/** The tooltip line's style, once per page, next to RadialMenu's own. */
function injectRadialHintStyle(): void {
  if (radialStyleInjected || typeof document === "undefined") return;
  radialStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .radial-tooltip .${RADIAL_HINT_CLASS} {
      margin-top: 4px;
      color: #f87171;
      font-weight: bold;
    }
  `;
  document.head.appendChild(style);
}

/** The nuke type of an attack submenu item (ids are `attack_<UnitType>`). */
function radialNukeType(item: MenuElement): UnitType | null {
  return NUKE_WEAPON_TYPES.find((t) => item.id === `attack_${t}`) ?? null;
}

function withHint(items: readonly TooltipItem[], hint: string): TooltipItem[] {
  const line: TooltipItem = { text: hint, className: RADIAL_HINT_CLASS };
  const at = items.findIndex((i) => i.className === "description");
  if (at === -1) return [...items, line];
  return [...items.slice(0, at + 1), line, ...items.slice(at + 1)];
}

/**
 * The attack submenu, with DEFCON-locked nukes in dark red and the hint in
 * their tooltip. Returns new element objects, never changes the given ones.
 *
 * RadialMenu paints every disabled item grey and ignores its color, so a
 * locked nuke stays "enabled" to show the dark red; clicking it only closes
 * the menu and shows the hint as a toast (the simulation rejects a locked nuke
 * anyway). Once DEFCON unlocks
 * nukes, every function falls back to the upstream element.
 */
export function modDefconDecorateRadial(
  items: MenuElement[],
  params: MenuElementParams,
): MenuElement[] {
  const game = params.game;
  if (defconClientState(game) === null) return items;
  return items.map((item) => decorateRadialItem(item, game));
}

function decorateRadialItem(item: MenuElement, game: GameView): MenuElement {
  const unitType = radialNukeType(item);
  if (unitType === null || lockedHintRef(game, unitType) === null) {
    return item;
  }
  injectRadialHintStyle();
  const locked = () => lockedHintRef(game, unitType) !== null;
  const upstreamColor = (p: MenuElementParams): string => {
    const color = item.color;
    if (typeof color === "function") return color(p);
    return color ?? RADIAL_DEFAULT_COLOR;
  };
  const upstreamSubMenu = item.subMenu;
  return {
    ...item,
    disabled: (p) => (locked() ? false : item.disabled(p)),
    color: (p) => (locked() ? RADIAL_LOCKED_COLOR : upstreamColor(p)),
    get tooltipItems(): TooltipItem[] | undefined {
      const hint = modDefconLockedHint(game, unitType);
      if (hint === null) return item.tooltipItems;
      return withHint(item.tooltipItems ?? [], hint);
    },
    subMenu:
      upstreamSubMenu === undefined
        ? undefined
        : (p) => (locked() ? [] : upstreamSubMenu(p)),
    action: (p) => {
      if (locked()) {
        // Tooltips only show on mouse hover, so tell touch players too.
        const hint = modDefconLockedHint(game, unitType);
        if (hint !== null) showToast(hint, "red", 2500);
        p.closeMenu();
        return;
      }
      item.action?.(p);
    },
  };
}
