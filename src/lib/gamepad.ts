import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { log } from "./log";
import { storage } from "./storage";

/**
 * Sofa use: a game controller drives Vela, and the interface can be enlarged for a TV.
 *
 * The controller is read with the Gamepad API and turned into the keys Vela already answers:
 * the d-pad or left stick are the arrows (with repeat), A activates the focused control (or
 * plays/pauses in the player), B is Escape (back, close), Start plays/pauses, LB/RB seek, Y
 * opens the search. Arrows the page does not handle move the focus to the nearest control in
 * that direction.
 */

/* ---------- Spatial navigation ---------- */

const FOCUSABLE =
  'button:not([disabled]), a[href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type Direction = "up" | "down" | "left" | "right";
type Box = { left: number; top: number; right: number; bottom: number };

/**
 * The candidate nearest to `from` in `direction`: it must lie beyond `from` on that axis; the
 * distance along the axis counts once, the sideways offset counts double, so the control right
 * next to it wins over one further along that happens to be aligned.
 */
export function nearest<T>(from: Box, candidates: { item: T; box: Box }[], direction: Direction): T | undefined {
  const cx = (from.left + from.right) / 2;
  const cy = (from.top + from.bottom) / 2;
  let best: T | undefined;
  let bestScore = Infinity;
  for (const { item, box } of candidates) {
    const x = (box.left + box.right) / 2;
    const y = (box.top + box.bottom) / 2;
    let along: number;
    let across: number;
    if (direction === "right") [along, across] = [box.left - from.right + 1, Math.abs(y - cy)];
    else if (direction === "left") [along, across] = [from.left - box.right + 1, Math.abs(y - cy)];
    else if (direction === "down") [along, across] = [box.top - from.bottom + 1, Math.abs(x - cx)];
    else [along, across] = [from.top - box.bottom + 1, Math.abs(x - cx)];
    if (along <= 0) continue;
    const score = along + across * 2;
    if (score < bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

/** Moves the focus to the nearest visible control in `direction` (inside an open dialog, if any). */
export function moveFocus(direction: Direction): boolean {
  const scope: ParentNode = document.querySelector("dialog[open]") ?? document;
  const active = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const elements = [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element === active) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight;
  });
  if (!active) {
    elements[0]?.focus();
    return Boolean(elements[0]);
  }
  const target = nearest(
    active.getBoundingClientRect(),
    elements.map((element) => ({ item: element, box: element.getBoundingClientRect() })),
    direction,
  );
  if (!target) return false;
  target.focus();
  target.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

/* ---------- Controller ---------- */

const ARROWS: Record<Direction, string> = { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight" };
/** Standard mapping: https://w3c.github.io/gamepad/#remapping */
const BUTTON = { a: 0, b: 1, y: 3, lb: 4, rb: 5, start: 9, up: 12, down: 13, left: 14, right: 15 } as const;
const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;
const STICK = 0.6;

function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function playerOpen() {
  return Boolean(document.querySelector(".player:not(.embedded)"));
}

function arrow(direction: Direction) {
  // The page's own handling first (rows of cards, menus, the player's seek and volume).
  const handled = press(ARROWS[direction]);
  if (!handled && !playerOpen()) moveFocus(direction);
}

function activate() {
  if (playerOpen()) {
    press("k");
    return;
  }
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) active.click();
  else moveFocus("down");
}

let running = false;
let frame = 0;
const held = new Map<string, { since: number; last: number }>();

function poll() {
  frame = 0;
  const pads = navigator.getGamepads?.() ?? [];
  const pad = pads.find((item) => item?.connected);
  if (!pad) {
    held.clear();
    return;
  }
  const now = performance.now();
  const pressed = (index: number) => Boolean(pad.buttons[index]?.pressed);
  const [x = 0, y = 0] = pad.axes;
  const state: Record<string, boolean> = {
    up: pressed(BUTTON.up) || y < -STICK,
    down: pressed(BUTTON.down) || y > STICK,
    left: pressed(BUTTON.left) || x < -STICK,
    right: pressed(BUTTON.right) || x > STICK,
    a: pressed(BUTTON.a),
    b: pressed(BUTTON.b),
    y: pressed(BUTTON.y),
    lb: pressed(BUTTON.lb),
    rb: pressed(BUTTON.rb),
    start: pressed(BUTTON.start),
  };
  for (const [name, down] of Object.entries(state)) {
    const previous = held.get(name);
    if (!down) {
      held.delete(name);
      continue;
    }
    const repeatable = name in ARROWS;
    const fire = !previous || (repeatable && now - previous.since > REPEAT_DELAY && now - previous.last > REPEAT_EVERY);
    if (!previous) held.set(name, { since: now, last: now });
    else if (fire) previous.last = now;
    if (!fire) continue;
    if (repeatable) arrow(name as Direction);
    else if (name === "a") activate();
    else if (name === "b") press("Escape");
    else if (name === "start") press("k");
    else if (name === "lb") press("j");
    else if (name === "rb") press("l");
    else if (name === "y") press("k", { ctrlKey: true });
  }
  if (running) frame = requestAnimationFrame(poll);
}

/** Starts reading controllers when one connects; stops when the last one goes. */
export function startGamepad() {
  if (typeof window === "undefined" || !("getGamepads" in navigator)) return;
  const start = () => {
    if (running) return;
    running = true;
    frame = requestAnimationFrame(poll);
  };
  const stop = () => {
    if ((navigator.getGamepads?.() ?? []).some((pad) => pad?.connected)) return;
    running = false;
    cancelAnimationFrame(frame);
    held.clear();
  };
  window.addEventListener("gamepadconnected", start);
  window.addEventListener("gamepaddisconnected", stop);
  if ((navigator.getGamepads?.() ?? []).some((pad) => pad?.connected)) start();
}

/* ---------- Interface size ---------- */

export const interfaceScales = [100, 125, 150, 175] as const;
export type InterfaceScale = (typeof interfaceScales)[number];
const scaleKey = "vela.device.scale";

let scale: InterfaceScale | undefined;
const listeners = new Set<() => void>();

function readScale(): InterfaceScale {
  const value = Number(storage.getItem(scaleKey));
  return (interfaceScales as readonly number[]).includes(value) ? (value as InterfaceScale) : 100;
}

function applyScale(value: InterfaceScale) {
  if (!isTauri()) {
    document.documentElement.style.zoom = value === 100 ? "" : String(value / 100);
    return;
  }
  // The WebView's own zoom: devicePixelRatio follows it, so native overlays stay aligned.
  void getCurrentWebview()
    .setZoom(value / 100)
    .catch((error: unknown) => log.warn("interface size could not be applied", error));
}

export const interfaceScale = {
  get(): InterfaceScale {
    return (scale ??= readScale());
  },
  set(value: InterfaceScale) {
    scale = value;
    if (value === 100) storage.removeItem(scaleKey);
    else storage.setItem(scaleKey, String(value));
    applyScale(value);
    for (const listener of [...listeners]) listener();
  },
  restore() {
    const value = interfaceScale.get();
    if (value !== 100) applyScale(value);
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

export function useInterfaceScale(): InterfaceScale {
  return useSyncExternalStore(interfaceScale.subscribe, interfaceScale.get, interfaceScale.get);
}
