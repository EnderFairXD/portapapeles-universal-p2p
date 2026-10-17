// Solo conecta eventos y comandos de Tauri con `render`; no pinta nada por sí mismo.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { render } from "./render";
import type { UiState } from "./types";

const NO_PEER_TEXT = "Conecta el móvil para enviar";
const CLIPBOARD_TEXT = "No se pudo acceder al portapapeles";

/** Estado inicial: la ventana se ve completa aunque el backend aún no haya contestado. */
const EMPTY_STATE: UiState = {
  pcName: "",
  peers: [],
  history: [],
  transfers: [],
  clipboardError: null,
  clipNotice: null,
  serverError: null,
  paired: [],
  pairing: null,
  pairNotice: null,
};

const app = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;
let state: UiState = EMPTY_STATE;

/** Repinta cada segundo mientras haya un QR vigente, para que la cuenta atrás avance. */
let countdownTimer: number | undefined;

function syncCountdown(): void {
  const live = state.pairing !== null && state.pairing.expiresAtMs > Date.now();
  if (live && countdownTimer === undefined) {
    countdownTimer = window.setInterval(() => {
      render(app, state);
      syncCountdown(); // se detiene solo al caducar el QR
    }, 1000);
  } else if (!live && countdownTimer !== undefined) {
    window.clearInterval(countdownTimer);
    countdownTimer = undefined;
  }
}

function apply(next: UiState): void {
  state = next;
  render(app, next);
  syncCountdown();
}

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove("show"), 1800);
}

/** Textos para el usuario de los códigos que devuelven los comandos. */
const COMMAND_ERROR = new Map([
  ["no_peer", NO_PEER_TEXT],
  ["read_error", "No se pudo leer el archivo"],
  [CLIPBOARD_TEXT, CLIPBOARD_TEXT],
  // Los de start_pairing ya vienen en español del backend.
  ["No hay ninguna red disponible", "No hay ninguna red disponible"],
  ["No se pudo generar el código QR", "No se pudo generar el código QR"],
]);

/** Un error desconocido (p. ej. en inglés, de arboard o del sistema) solo va a la consola. */
function errorMessage(e: unknown, fallback: string): string {
  const code = e instanceof Error ? e.message : String(e);
  const known = COMMAND_ERROR.get(code);
  if (known) return known;
  console.error("ClipSync:", e);
  return fallback;
}

async function sendFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  if (state.peers.length === 0) {
    toast(NO_PEER_TEXT);
    return;
  }
  try {
    await invoke("send_files", { paths });
  } catch (e) {
    toast(errorMessage(e, "No se pudo enviar el archivo"));
  }
}

async function pickFiles(): Promise<void> {
  const picked = await open({ multiple: true });
  const paths = picked == null ? [] : Array.isArray(picked) ? picked : [picked];
  await sendFiles(paths);
}

/** Aviso si falla una acción sin un código conocido. */
const ACTION_FALLBACK = new Map([
  ["pick-files", "No se pudo abrir el selector de archivos"],
  ["cancel", "No se pudo cancelar"],
  ["copy", CLIPBOARD_TEXT],
  ["reveal", "No se pudo abrir la carpeta"],
  ["start-pairing", "No se pudo iniciar el emparejamiento"],
  ["cancel-pairing", "No se pudo cancelar el emparejamiento"],
  ["forget", "No se pudo olvidar el móvil"],
]);

async function onAction(action: string, el: HTMLElement): Promise<void> {
  const item = state.history.find((h) => String(h.id) === el.dataset.historyId);
  try {
    switch (action) {
      case "pick-files":
        await pickFiles();
        break;
      case "cancel":
        await invoke("cancel_transfer", { transferId: el.dataset.transferId });
        break;
      case "copy":
        if (item?.text != null) {
          await invoke("copy_text", { text: item.text });
          toast("Copiado");
        }
        break;
      case "reveal":
        if (item?.location) await revealItemInDir(item.location);
        break;
      case "start-pairing":
        await invoke("start_pairing");
        break;
      case "cancel-pairing":
        await invoke("cancel_pairing");
        break;
      case "forget": {
        const deviceKey = el.dataset.deviceKey;
        const device = state.paired.find((d) => d.deviceKey === deviceKey);
        if (!deviceKey || !device) break;
        const yes = await ask(`¿Olvidar «${device.deviceName}»? Tendrá que volver a escanear el QR.`, {
          title: "ClipSync",
          kind: "warning",
        });
        if (yes) await invoke("forget_device", { deviceKey });
        break;
      }
    }
  } catch (e) {
    toast(errorMessage(e, ACTION_FALLBACK.get(action) ?? "Algo salió mal"));
  }
}

// Un solo oyente: render reutiliza los botones, así que sobrevive a cada pintado.
app.addEventListener("click", (ev) => {
  if (!(ev.target instanceof Element)) return;
  const el = ev.target.closest<HTMLElement>("[data-action]");
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return;
  void onAction(el.dataset.action!, el);
});

async function watchDrops(): Promise<void> {
  await getCurrentWebview().onDragDropEvent((event) => {
    const zone = app.querySelector(".drop");
    const enabled = state.peers.length > 0;
    const p = event.payload;
    if (p.type === "enter" || p.type === "over") {
      zone?.classList.toggle("is-over", enabled);
    } else {
      zone?.classList.remove("is-over");
      if (p.type === "drop") void sendFiles(p.paths);
    }
  });
}

function logFailure(what: string): (e: unknown) => void {
  return (e) => console.error(`ClipSync: ${what}`, e);
}

async function main(): Promise<void> {
  render(app, EMPTY_STATE);

  // Cada paso es independiente: que uno falle no deja a la ventana sin los demás.
  const drops = watchDrops().catch(logFailure("no se pudo vigilar el arrastre de archivos"));

  // Primero el oyente y después `get_state`: no hay evento inicial, y si llega
  // uno mientras se pide el estado, el evento es más reciente y gana.
  let gotEvent = false;
  await listen<UiState>("ui-state", (e) => {
    gotEvent = true;
    apply(e.payload);
  }).catch(logFailure("no se pudo escuchar ui-state"));

  try {
    const initial = await invoke<UiState>("get_state");
    if (!gotEvent) apply(initial);
  } catch (e) {
    logFailure("no se pudo cargar el estado")(e);
    toast("No se pudo cargar el estado de la app");
  }

  await drops;
}

main().catch(logFailure("no se pudo iniciar la interfaz"));
