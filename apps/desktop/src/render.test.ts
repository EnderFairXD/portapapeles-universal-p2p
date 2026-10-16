import { beforeEach, describe, expect, it } from "vitest";
import { formatProgress, render } from "./render";
import type { HistoryItem, Peer, Transfer, UiState } from "./types";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function state(over: Partial<UiState> = {}): UiState {
  return { pcName: "pop-os", peers: [], history: [], transfers: [], clipboardError: null, clipNotice: null, ...over };
}

function peer(over: Partial<Peer> = {}): Peer {
  return { sessionId: 1, deviceId: "d1", deviceName: "Pixel 8", transport: "wifi", ...over };
}

function transfer(over: Partial<Transfer> = {}): Transfer {
  return {
    transferId: "a".repeat(32),
    direction: "out",
    name: "foto.jpg",
    size: 5_242_880,
    bytes: 0,
    state: "active",
    error: null,
    location: null,
    ...over,
  };
}

function item(over: Partial<HistoryItem> = {}): HistoryItem {
  return { id: 1, kind: "text", direction: "in", text: "hola", fileName: null, location: null, atMs: 1_760_000_000_000, ...over };
}

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const qa = (sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));
const pickButton = () => q<HTMLButtonElement>('button[data-action="pick-files"]')!;

describe("estado de conexión", () => {
  it("sin peers muestra «Esperando al móvil…» con la pista y el botón de enviar desactivado", () => {
    render(root, state());
    expect(q(".status-title")!.textContent).toBe("Esperando al móvil…");
    expect(q(".status-hint")!.textContent).toBe(
      "Abre ClipSync en el móvil, conectado a la misma red WiFi o por cable USB",
    );
    expect(pickButton().disabled).toBe(true);
    expect(q(".drop-hint")!.textContent).toBe("Conecta el móvil para enviar");
  });

  it("con un peer USB muestra «Conectado con Pixel 8 por USB» y activa el envío", () => {
    render(root, state({ peers: [peer({ transport: "usb" })] }));
    expect(q(".status-title")!.textContent).toBe("Conectado con Pixel 8 por USB");
    expect(q(".status-hint")!.hidden).toBe(true);
    expect(pickButton().disabled).toBe(false);
    expect(pickButton().textContent).toBe("Elegir archivo");
  });

  it("con un peer WiFi dice «por WiFi»", () => {
    render(root, state({ peers: [peer({ transport: "wifi" })] }));
    expect(q(".status-title")!.textContent).toBe("Conectado con Pixel 8 por WiFi");
  });

  it("con dos peers (relevo de sesión) muestra el último y no vuelve a «Esperando»", () => {
    const viejo = peer({ sessionId: 1, deviceName: "Pixel 8" });
    const nuevo = peer({ sessionId: 2, deviceName: "Pixel 9", transport: "usb" });
    render(root, state({ peers: [viejo, nuevo] }));
    expect(q(".status-title")!.textContent).toBe("Conectado con Pixel 9 por USB");
    render(root, state({ peers: [nuevo] }));
    expect(q(".status-title")!.textContent).toBe("Conectado con Pixel 9 por USB");
  });

  it("el nombre del dispositivo se muestra como texto, nunca como HTML", () => {
    render(root, state({ peers: [peer({ deviceName: "<img src=x onerror=alert(1)>" })] }));
    expect(q("img")).toBeNull();
    expect(q(".status-title")!.textContent).toBe("Conectado con <img src=x onerror=alert(1)> por WiFi");
  });

  it("muestra el nombre del PC", () => {
    render(root, state({ pcName: "mi-portátil" }));
    expect(q(".pc-name")!.textContent).toBe("mi-portátil");
  });
});

describe("transferencias", () => {
  it("2 621 440 de 5 242 880 bytes: barra al 50 % y «2,5 MB de 5,0 MB»", () => {
    render(root, state({ transfers: [transfer({ bytes: 2_621_440 })] }));
    const bar = q('[role="progressbar"]')!;
    expect(bar.getAttribute("aria-valuenow")).toBe("50");
    expect(q<HTMLElement>(".bar-fill")!.style.width).toBe("50%");
    expect(q(".transfer-detail")!.textContent).toBe("2,5 MB de 5,0 MB");
  });

  it("muestra el nombre y un botón «Cancelar» ligado a la transferencia", () => {
    render(root, state({ transfers: [transfer({ bytes: 100 })] }));
    expect(q(".transfer-name")!.textContent).toBe("foto.jpg");
    const cancel = q<HTMLButtonElement>('button[data-action="cancel"]')!;
    expect(cancel.textContent).toBe("Cancelar");
    expect(cancel.dataset.transferId).toBe("a".repeat(32));
  });

  it("una transferencia en cola dice «En cola» y se puede cancelar", () => {
    render(root, state({ transfers: [transfer({ state: "queued" })] }));
    expect(q(".transfer-detail")!.textContent).toContain("En cola");
    expect(q('button[data-action="cancel"]')).not.toBeNull();
  });

  it("una cancelada dice «Cancelado» y no ofrece «Cancelar»", () => {
    render(root, state({ transfers: [transfer({ state: "cancelled" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Cancelado");
    expect(q('button[data-action="cancel"]')).toBeNull();
  });

  it("una fallida dice «Falló: …» con el motivo en español y no ofrece «Cancelar»", () => {
    render(root, state({ transfers: [transfer({ state: "failed", error: "link_closed" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló: se perdió la conexión");
    expect(q('button[data-action="cancel"]')).toBeNull();
  });

  it("un motivo de fallo desconocido se muestra tal cual y uno ausente se omite", () => {
    render(root, state({ transfers: [transfer({ state: "failed", error: "disco_lleno" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló: disco_lleno");
    render(root, state({ transfers: [transfer({ state: "failed", error: undefined })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló");
  });

  it("el nombre que manda el móvil nunca se interpreta como HTML", () => {
    const name = '<img src=x onerror="alert(1)"><b>x</b>';
    render(root, state({ transfers: [transfer({ name })] }));
    expect(q(".transfers img")).toBeNull();
    expect(q(".transfers b")).toBeNull();
    expect(q(".transfer-name")!.textContent).toBe(name);
  });

  it("la sección se oculta sin transferencias", () => {
    render(root, state());
    expect(q(".transfers")!.hidden).toBe(true);
    render(root, state({ transfers: [transfer()] }));
    expect(q(".transfers")!.hidden).toBe(false);
  });

  it("al repintar con más progreso se reutiliza la fila y se actualiza la barra", () => {
    render(root, state({ transfers: [transfer({ bytes: 1_048_576 })] }));
    const fila = q(".transfer")!;
    const cancel = q('button[data-action="cancel"]')!;
    render(root, state({ transfers: [transfer({ bytes: 4_194_304 })] }));
    expect(q(".transfer")).toBe(fila);
    expect(q('button[data-action="cancel"]')).toBe(cancel);
    expect(q<HTMLElement>(".bar-fill")!.style.width).toBe("80%");
    expect(q(".transfer-detail")!.textContent).toBe("4,0 MB de 5,0 MB");
  });

  it("una transferencia que desaparece del estado desaparece de la lista", () => {
    render(root, state({ transfers: [transfer({ transferId: "1".repeat(32) }), transfer({ transferId: "2".repeat(32) })] }));
    expect(qa(".transfer")).toHaveLength(2);
    render(root, state({ transfers: [transfer({ transferId: "2".repeat(32) })] }));
    expect(qa(".transfer")).toHaveLength(1);
    expect(q<HTMLElement>(".transfer")!.dataset.transferId).toBe("2".repeat(32));
  });

  it("un archivo vacío no divide por cero", () => {
    render(root, state({ transfers: [transfer({ size: 0, bytes: 0 })] }));
    expect(q('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("0");
    expect(q(".transfer-detail")!.textContent).toBe("0 B de 0 B");
  });
});

describe("formatProgress", () => {
  it("usa coma decimal y múltiplos de 1024", () => {
    expect(formatProgress(2_621_440, 5_242_880)).toBe("2,5 MB de 5,0 MB");
  });

  it("elige la unidad según el tamaño total", () => {
    expect(formatProgress(50, 100)).toBe("50 B de 100 B");
    expect(formatProgress(1536, 2048)).toBe("1,5 KB de 2,0 KB");
    expect(formatProgress(1_073_741_824, 3_221_225_472)).toBe("1,0 GB de 3,0 GB");
  });
});

describe("envío de archivos", () => {
  it("con peer, la zona de soltar está activa y no muestra el aviso de conectar", () => {
    render(root, state({ peers: [peer()] }));
    expect(q(".drop")!.getAttribute("aria-disabled")).toBe("false");
    expect(q(".drop-hint")!.textContent).toBe("Suelta archivos aquí para enviarlos");
  });

  it("sin peer, la zona de soltar queda desactivada", () => {
    render(root, state());
    expect(q(".drop")!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("historial", () => {
  it("un texto de 10 líneas lleva la clase de recorte", () => {
    const text = Array.from({ length: 10 }, (_, i) => `línea ${i + 1}`).join("\n");
    render(root, state({ history: [item({ text })] }));
    const el = q(".clamp-3")!;
    expect(el.textContent).toBe(text);
    // el botón es el que recibe el clic (con teclado también)
    const boton = el.closest("button")!;
    expect(boton.dataset.action).toBe("copy");
    expect(boton.dataset.historyId).toBe("1");
  });

  it("un texto enorme se recorta en el DOM para no cargar la ventana", () => {
    render(root, state({ history: [item({ text: "x".repeat(100_000) })] }));
    const shown = q(".clamp-3")!.textContent!;
    expect(shown.length).toBeLessThan(1000);
    expect(shown.endsWith("…")).toBe(true);
  });

  it("el texto del historial nunca se interpreta como HTML", () => {
    render(root, state({ history: [item({ text: "<script>alert(1)</script><b>hola</b>" })] }));
    expect(q(".history script")).toBeNull();
    expect(q(".history b")).toBeNull();
    expect(q(".clamp-3")!.textContent).toBe("<script>alert(1)</script><b>hola</b>");
  });

  it("marca ↑ lo enviado y ↓ lo recibido", () => {
    render(root, state({ history: [item({ id: 2, direction: "out" }), item({ id: 1, direction: "in" })] }));
    const dirs = qa(".hist-item .dir");
    expect(dirs.map((d) => d.textContent)).toEqual(["↑", "↓"]);
    expect(dirs.map((d) => d.getAttribute("aria-label"))).toEqual(["Enviado", "Recibido"]);
  });

  it("los textos «local» llevan la etiqueta «En este PC» en vez de flecha", () => {
    render(root, state({ history: [item({ direction: "local", text: "mío" })] }));
    const dir = q(".hist-item .dir")!;
    expect(dir.textContent).toBe("En este PC");
    expect(dir.classList.contains("dir-local")).toBe(true);
  });

  it("un archivo muestra su nombre como texto y el botón «Abrir carpeta»", () => {
    const fileName = "<b>informe</b>.pdf";
    render(
      root,
      state({ history: [item({ kind: "file", text: null, fileName, location: "/home/javier/Descargas/informe.pdf" })] }),
    );
    expect(q(".hist-file-name")!.textContent).toBe(fileName);
    expect(q(".history b")).toBeNull();
    const reveal = q<HTMLButtonElement>('button[data-action="reveal"]')!;
    expect(reveal.textContent).toBe("Abrir carpeta");
    expect(reveal.dataset.historyId).toBe("1");
    expect(q('button[data-action="copy"]')).toBeNull();
  });

  it("un archivo sin ruta no ofrece «Abrir carpeta» (ausente o null)", () => {
    render(root, state({ history: [item({ kind: "file", text: null, fileName: "a.txt", location: null })] }));
    expect(q('button[data-action="reveal"]')).toBeNull();
    render(root, state({ history: [item({ kind: "file", text: null, fileName: "a.txt", location: undefined })] }));
    expect(q('button[data-action="reveal"]')).toBeNull();
  });

  it("respeta el orden del estado y reutiliza los elementos ya pintados", () => {
    const a = item({ id: 1, text: "uno" });
    const b = item({ id: 2, text: "dos" });
    render(root, state({ history: [a] }));
    const elA = q('[data-history-id="1"]')!.closest(".hist-item")!;
    render(root, state({ history: [b, a] }));
    const items = qa(".hist-item");
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining("dos"), expect.stringContaining("uno")]);
    expect(items[1]).toBe(elA);
  });

  it("sin historial explica qué aparecerá", () => {
    render(root, state());
    expect(q(".hist-empty")!.hidden).toBe(false);
    render(root, state({ history: [item()] }));
    expect(q(".hist-empty")!.hidden).toBe(true);
  });
});

describe("avisos", () => {
  it("sin avisos no hay nada visible", () => {
    render(root, state());
    expect(q(".notices")!.hidden).toBe(true);
    expect(qa(".notice")).toHaveLength(0);
  });

  it("clipboardError muestra un aviso visible de error", () => {
    render(root, state({ clipboardError: "Portapapeles no disponible" }));
    expect(q(".notices")!.hidden).toBe(false);
    const notice = q(".notice")!;
    expect(notice.textContent).toContain("Portapapeles no disponible");
    expect(notice.classList.contains("notice-error")).toBe(true);
  });

  it("clipNotice muestra un aviso informativo y desaparece al limpiarse", () => {
    render(root, state({ clipNotice: "Texto demasiado grande para sincronizar (máx. 1 MB)" }));
    expect(q(".notice")!.textContent).toContain("Texto demasiado grande para sincronizar (máx. 1 MB)");
    render(root, state({ clipNotice: undefined }));
    expect(q(".notices")!.hidden).toBe(true);
  });

  it("los avisos se muestran como texto, nunca como HTML", () => {
    render(root, state({ clipboardError: "<img src=x onerror=alert(1)>" }));
    expect(q(".notice img")).toBeNull();
  });
});
