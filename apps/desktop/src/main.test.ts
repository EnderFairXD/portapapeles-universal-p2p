import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiState } from "./types";

// Los módulos de Tauri se sustituyen: aquí solo se comprueba el cableado de main.ts.
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  ask: vi.fn(),
  listen: vi.fn(),
  onDragDropEvent: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: tauri.listen }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: tauri.onDragDropEvent }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), ask: tauri.ask }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));

const STATE_ERROR = "No se pudo cargar el estado de la app";

function state(over: Partial<UiState> = {}): UiState {
  return { pcName: "pop-os", peers: [], history: [], transfers: [], clipboardError: null, clipNotice: null, serverError: null, paired: [], pairing: null, pairNotice: null, ...over };
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
  tauri.ask.mockReset();
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

describe("errores de los comandos", () => {
  const textItem = { id: 7, kind: "text" as const, direction: "in" as const, text: "hola", fileName: null, location: null, atMs: 1 };

  it("un error en inglés al copiar se muestra como «No se pudo acceder al portapapeles»", async () => {
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_state") return state({ history: [textItem] });
      if (cmd === "copy_text") throw "Unknown error while interacting with the clipboard: X11 server connection timed out";
    });
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="copy"]')).not.toBeNull());
    document.querySelector<HTMLElement>('[data-action="copy"]')!.click();
    await vi.waitFor(() => expect(toastText()).toBe("No se pudo acceder al portapapeles"));
    expect(console.error).toHaveBeenCalled();
  });

  it("los códigos conocidos siguen traduciéndose", async () => {
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_state") return state({ peers: [{ sessionId: 1, deviceId: "d", deviceName: "Pixel 8", transport: "usb" }] });
      if (cmd === "send_files") throw "read_error";
    });
    await start();
    await vi.waitFor(() => expect(title()).toBe("Conectado con Pixel 8 por USB"));
    expect(uiStateHandler).toBeDefined();
    const drop = tauri.onDragDropEvent.mock.calls[0][0] as (e: { payload: { type: string; paths: string[] } }) => void;
    drop({ payload: { type: "drop", paths: ["/tmp/a"] } });
    await vi.waitFor(() => expect(toastText()).toBe("No se pudo leer el archivo"));
  });
});

describe("emparejamiento", () => {
  const device = { deviceKey: "ab".repeat(32), deviceName: "Pixel 8", pairedAtMs: 1, connected: false };
  const click = (sel: string) => document.querySelector<HTMLElement>(sel)!.click();

  /** get_state devuelve `st`; el resto de comandos los decide `commands`. */
  function backend(st: UiState, commands: Record<string, () => unknown> = {}) {
    tauri.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_state") return st;
      return commands[cmd]?.();
    });
  }

  it("«Emparejar móvil» invoca start_pairing", async () => {
    backend(state());
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="start-pairing"]')).not.toBeNull());
    click('[data-action="start-pairing"]');
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("start_pairing"));
  });

  it("un error de start_pairing va al aviso", async () => {
    backend(state(), {
      start_pairing: () => {
        throw "No hay ninguna red disponible";
      },
    });
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="start-pairing"]')).not.toBeNull());
    click('[data-action="start-pairing"]');
    await vi.waitFor(() => expect(toastText()).toBe("No hay ninguna red disponible"));
  });

  it("«Cancelar» del QR invoca cancel_pairing", async () => {
    backend(state({ pairing: { qrSvg: "<svg/>", expiresAtMs: Date.now() + 60_000 } }));
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="cancel-pairing"]')).not.toBeNull());
    click('[data-action="cancel-pairing"]');
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("cancel_pairing"));
  });

  it("«Olvidar» pregunta y, si se acepta, invoca forget_device con la clave", async () => {
    backend(state({ paired: [device] }));
    tauri.ask.mockResolvedValue(true);
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="forget"]')).not.toBeNull());
    click('[data-action="forget"]');
    await vi.waitFor(() => expect(tauri.invoke).toHaveBeenCalledWith("forget_device", { deviceKey: device.deviceKey }));
    expect(tauri.ask).toHaveBeenCalledWith("¿Olvidar «Pixel 8»? Tendrá que volver a escanear el QR.", {
      title: "ClipSync",
      kind: "warning",
    });
  });

  it("«Olvidar» no hace nada si se rechaza la pregunta", async () => {
    backend(state({ paired: [device] }));
    tauri.ask.mockResolvedValue(false);
    await start();
    await vi.waitFor(() => expect(document.querySelector('[data-action="forget"]')).not.toBeNull());
    click('[data-action="forget"]');
    await vi.waitFor(() => expect(tauri.ask).toHaveBeenCalledOnce());
    await new Promise((r) => setTimeout(r, 20));
    expect(tauri.invoke).not.toHaveBeenCalledWith("forget_device", expect.anything());
  });

  it("mientras hay QR la cuenta atrás se repinta cada segundo y para al caducar", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      const expiresAtMs = Date.now() + 3_000;
      backend(state({ pairing: { qrSvg: "<svg/>", expiresAtMs } }));
      await start();
      await vi.waitFor(() => expect(document.querySelector(".pairing-countdown")?.textContent).toBe("Caduca en 0:03"));
      vi.advanceTimersByTime(1000);
      expect(document.querySelector(".pairing-countdown")!.textContent).toBe("Caduca en 0:02");
      vi.advanceTimersByTime(2000);
      expect((document.querySelector(".pairing") as HTMLElement).hidden).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
