import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiState } from "./types";

// Los módulos de Tauri se sustituyen: aquí solo se comprueba el cableado de main.ts.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: tauri.onDragDropEvent }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const STATE_ERROR = "No se pudo cargar el estado de la app";

function state(over: Partial<UiState> = {}): UiState {
  return { pcName: "pop-os", peers: [], history: [], transfers: [], clipboardError: null, clipNotice: null, ...over };
}

const toastText = () => document.getElementById("toast")!.textContent;
const title = () => document.querySelector(".status-title")?.textContent;

/** Importa main.ts de cero: su código de arranque se ejecuta al cargarlo. */
async function start(): Promise<void> {
  vi.resetModules();
  document.body.innerHTML = '<main id="app"></main><div id="toast"></div>';
  await import("./main");
}

let uiStateHandler: ((e: { payload: UiState }) => void) | undefined;

beforeEach(() => {
  uiStateHandler = undefined;
  tauri.invoke.mockReset().mockResolvedValue(state());
  tauri.listen.mockReset().mockImplementation(async (event: string, cb: typeof uiStateHandler) => {
    if (event === "ui-state") uiStateHandler = cb;
    return () => {};
  });
  tauri.onDragDropEvent.mockReset().mockResolvedValue(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("arranque", () => {
  it("registra ui-state antes de pedir get_state y pinta el estado inicial", async () => {
    tauri.invoke.mockResolvedValue(state({ pcName: "mi-pc", peers: [{ sessionId: 1, deviceId: "d", deviceName: "Pixel 8", transport: "usb" }] }));
    await start();
    await vi.waitFor(() => expect(title()).toBe("Conectado con Pixel 8 por USB"));
    expect(document.querySelector(".pc-name")!.textContent).toBe("mi-pc");
    expect(tauri.listen.mock.invocationCallOrder[0]).toBeLessThan(tauri.invoke.mock.invocationCallOrder[0]);
    expect(tauri.onDragDropEvent).toHaveBeenCalledOnce();
  });

  it("si llega un ui-state mientras se pide get_state, gana el evento", async () => {
    let resolveState!: (s: UiState) => void;
    tauri.invoke.mockReturnValue(new Promise<UiState>((r) => (resolveState = r)));
    await start();
    await vi.waitFor(() => expect(uiStateHandler).toBeDefined());
    uiStateHandler!({ payload: state({ peers: [{ sessionId: 2, deviceId: "d", deviceName: "Nuevo", transport: "wifi" }] }) });
    resolveState(state()); // la respuesta vieja llega tarde
    await vi.waitFor(() => expect(title()).toBe("Conectado con Nuevo por WiFi"));
    await new Promise((r) => setTimeout(r, 20));
    expect(title()).toBe("Conectado con Nuevo por WiFi");
  });

  it("si get_state falla avisa con un toast y sigue vigilando ui-state y el arrastre", async () => {
    tauri.invoke.mockRejectedValue("boom");
    await start();
    await vi.waitFor(() => expect(toastText()).toBe(STATE_ERROR));
    expect(document.getElementById("toast")!.classList.contains("show")).toBe(true);
    expect(uiStateHandler).toBeDefined();
    expect(tauri.onDragDropEvent).toHaveBeenCalledOnce();
    // la ventana sigue viva: un evento posterior se pinta
    uiStateHandler!({ payload: state() });
    expect(title()).toBe("Esperando al móvil…");
  });

  it("si falla el oyente de ui-state, aun así carga el estado y vigila el arrastre", async () => {
    tauri.listen.mockRejectedValue(new Error("sin eventos"));
    tauri.invoke.mockResolvedValue(state({ pcName: "otro-pc" }));
    await start();
    await vi.waitFor(() => expect(document.querySelector(".pc-name")!.textContent).toBe("otro-pc"));
    expect(tauri.onDragDropEvent).toHaveBeenCalledOnce();
  });

  it("si falla la vigilancia del arrastre, aun así carga el estado", async () => {
    tauri.onDragDropEvent.mockRejectedValue(new Error("sin arrastre"));
    tauri.invoke.mockResolvedValue(state({ pcName: "otro-pc" }));
    await start();
    await vi.waitFor(() => expect(document.querySelector(".pc-name")!.textContent).toBe("otro-pc"));
    expect(toastText()).toBe("");
  });
});
