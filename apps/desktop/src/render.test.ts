import { beforeEach, describe, expect, it } from "vitest";
import { formatProgress, render } from "./render";
import type { HistoryItem, PairedDevice, Peer, Transfer, UiState } from "./types";

let root: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.appendChild(root);
});

function state(over: Partial<UiState> = {}): UiState {
  return { pcName: "pop-os", peers: [], history: [], transfers: [], clipboardError: null, clipNotice: null, serverError: null, paired: [], pairing: null, pairNotice: null, ...over };
}

function device(over: Partial<PairedDevice> = {}): PairedDevice {
  return { deviceKey: "ab".repeat(32), deviceName: "Pixel 8", pairedAtMs: 1_760_000_000_000, connected: false, ...over };
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
  it("con emparejados y sin conexión mantiene la pista de la fase 1 y el botón de enviar desactivado", () => {
    render(root, state({ paired: [device()] }));
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

  it("un transporte que coincide con un miembro de Object.prototype no se rotula", () => {
    const transport = "constructor" as unknown as Peer["transport"];
    render(root, state({ peers: [peer({ transport })] }));
    expect(q(".status-title")!.textContent).toBe("Conectado con Pixel 8");
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

  it("un motivo desconocido o ausente solo dice «Falló»: el texto del móvil no se muestra", () => {
    render(root, state({ transfers: [transfer({ state: "failed", error: "disco_lleno" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló");
    render(root, state({ transfers: [transfer({ state: "failed", error: undefined })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló");
    render(root, state({ transfers: [transfer({ state: "failed", error: null })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló");
  });

  it("los cierres de sesión «replaced» y «closed» se traducen", () => {
    render(root, state({ transfers: [transfer({ state: "failed", error: "replaced" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló: la conexión se reemplazó por una nueva");
    render(root, state({ transfers: [transfer({ state: "failed", error: "closed" })] }));
    expect(q(".transfer-detail")!.textContent).toBe("Falló: se cerró la conexión");
  });

  // Códigos que el Rust de PC o el móvil pueden poner en `error` (session.rs, hub.rs, files.rs y session.ts).
  it.each([
    "link_closed",
    "heartbeat_timeout",
    "protocol_error",
    "internal_error",
    "checksum_mismatch",
    "hash_mismatch",
    "size_mismatch",
    "read_error",
    "write_error",
    "io_error",
    "replaced",
    "closed",
    "cancelled",
    "remote_error",
    "no_peer",
  ])("el código «%s» se muestra en español y no tal cual", (code) => {
    render(root, state({ transfers: [transfer({ state: "failed", error: code })] }));
    const text = q(".transfer-detail")!.textContent!;
    expect(text.startsWith("Falló: ")).toBe(true);
    expect(text).not.toContain(code);
  });

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"])(
    "el motivo «%s» no resuelve a miembros de Object.prototype",
    (error) => {
      render(root, state({ transfers: [transfer({ state: "failed", error })] }));
      expect(q(".transfer-detail")!.textContent).toBe("Falló");
    },
  );

  it("un motivo de 10 000 caracteres no llega al DOM", () => {
    render(root, state({ transfers: [transfer({ state: "failed", error: "x".repeat(10_000) })] }));
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

  it("serverError muestra un aviso de error, también junto al del portapapeles", () => {
    const serverError = "No se pudo abrir el puerto 52847: puede que otra copia de ClipSync esté abierta";
    render(root, state({ serverError }));
    expect(q(".notices")!.hidden).toBe(false);
    const n = qa(".notice");
    expect(n).toHaveLength(1);
    expect(n[0].textContent).toContain(serverError);
    expect(n[0].classList.contains("notice-error")).toBe(true);
    expect(n[0].getAttribute("role")).toBe("alert");

    render(root, state({ serverError, clipboardError: "No se pudo acceder al portapapeles" }));
    const texts = qa(".notice").map((e) => e.textContent);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t!.includes(serverError))).toBe(true);
    expect(texts.some((t) => t!.includes("No se pudo acceder al portapapeles"))).toBe(true);

    render(root, state());
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

describe("emparejamiento", () => {
  const expiresAtMs = 1_760_000_300_000;

  it("sin emparejados ni peers: texto que invita a emparejar", () => {
    render(root, state());
    expect(q(".status-title")!.textContent).toBe("Esperando al móvil…");
    expect(q(".status-hint")!.hidden).toBe(false);
    expect(q(".status-hint")!.textContent).toBe(
      "Pulsa «Emparejar móvil» y escanea el QR con ClipSync en el móvil",
    );
  });

  it("el botón «Emparejar móvil» lleva la acción start-pairing", () => {
    render(root, state());
    const b = q<HTMLButtonElement>('button[data-action="start-pairing"]')!;
    expect(b.textContent).toBe("Emparejar móvil");
  });

  it("sin pairing el panel de QR está oculto", () => {
    render(root, state());
    expect(q(".pairing")!.hidden).toBe(true);
  });

  it("pairing: img con src data:image/svg+xml y «Caduca en 4:59» con nowMs = expiresAtMs - 299_000", () => {
    const qrSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
    render(root, state({ pairing: { qrSvg, expiresAtMs } }), expiresAtMs - 299_000);
    const img = q<HTMLImageElement>(".pairing img")!;
    expect(img.getAttribute("alt")).toBe("Código QR de emparejamiento");
    expect(img.getAttribute("src")).toBe("data:image/svg+xml;charset=utf-8," + encodeURIComponent(qrSvg));
    expect(q(".pairing")!.textContent).toContain("Escanéalo con ClipSync en el móvil");
    expect(q(".pairing-countdown")!.textContent).toBe("Caduca en 4:59");
    expect(q(".pairing")!.hidden).toBe(false);
    expect(q<HTMLButtonElement>('button[data-action="cancel-pairing"]')!.textContent).toBe("Cancelar");
  });

  it("la cuenta atrás redondea hacia arriba, usa m:ss y se queda en 0:00", () => {
    const pairing = { qrSvg: "<svg/>", expiresAtMs };
    render(root, state({ pairing }), expiresAtMs - 61_000);
    expect(q(".pairing-countdown")!.textContent).toBe("Caduca en 1:01");
    render(root, state({ pairing }), expiresAtMs - 59_500);
    expect(q(".pairing-countdown")!.textContent).toBe("Caduca en 1:00");
    render(root, state({ pairing }), expiresAtMs - 1);
    expect(q(".pairing-countdown")!.textContent).toBe("Caduca en 0:01");
  });

  it("al llegar a 0 el panel se oculta y vuelve a verse con un QR nuevo", () => {
    const pairing = { qrSvg: "<svg/>", expiresAtMs };
    render(root, state({ pairing }), expiresAtMs);
    expect(q(".pairing")!.hidden).toBe(true);
    expect(q("img")).toBeNull();
    render(root, state({ pairing }), expiresAtMs + 5_000);
    expect(q(".pairing")!.hidden).toBe(true);
    render(root, state({ pairing }), expiresAtMs - 10_000);
    expect(q(".pairing")!.hidden).toBe(false);
  });

  it("repintar cada segundo no vuelve a crear la imagen del QR", () => {
    const pairing = { qrSvg: "<svg/>", expiresAtMs };
    render(root, state({ pairing }), expiresAtMs - 10_000);
    const img = q(".pairing img");
    render(root, state({ pairing }), expiresAtMs - 9_000);
    expect(q(".pairing img")).toBe(img);
    expect(q(".pairing-countdown")!.textContent).toBe("Caduca en 0:09");
  });

  it("pairing con «<script>» en el SVG: no se crea ningún <script> en el DOM", () => {
    const qrSvg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';
    render(root, state({ pairing: { qrSvg, expiresAtMs } }), expiresAtMs - 1000);
    expect(root.querySelector("script")).toBeNull();
    expect(q(".pairing img")!.getAttribute("src")).not.toContain("<script>");
  });

  it("emparejados: una fila por dispositivo con «Olvidar» y data-device-key; «Conectado» solo si connected", () => {
    const a = device({ deviceKey: "a".repeat(64), deviceName: "Pixel 8", connected: true });
    const b = device({ deviceKey: "b".repeat(64), deviceName: "Galaxy S24", connected: false });
    render(root, state({ paired: [a, b] }));
    const rows = qa(".paired-item");
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("Pixel 8");
    expect(rows[0].textContent).toContain("Conectado");
    expect(rows[1].textContent).toContain("Galaxy S24");
    expect(rows[1].textContent).not.toContain("Conectado");
    const forget = qa('button[data-action="forget"]');
    expect(forget.map((f) => f.dataset.deviceKey)).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(forget[0].textContent).toBe("Olvidar");
  });

  it("el nombre del móvil emparejado se muestra como texto, nunca como HTML", () => {
    render(root, state({ paired: [device({ deviceName: "<img src=x onerror=alert(1)>" })] }));
    expect(q(".paired-item img")).toBeNull();
    expect(q(".paired-item")!.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("al repintar se reutiliza la fila y «Conectado» aparece y desaparece", () => {
    render(root, state({ paired: [device()] }));
    const row = q(".paired-item");
    expect(row!.textContent).not.toContain("Conectado");
    render(root, state({ paired: [device({ connected: true })] }));
    expect(q(".paired-item")).toBe(row);
    expect(row!.textContent).toContain("Conectado");
    render(root, state({ paired: [device({ connected: false })] }));
    expect(row!.textContent).not.toContain("Conectado");
    render(root, state({ paired: [] }));
    expect(qa(".paired-item")).toHaveLength(0);
  });

  it("lista vacía → «Ningún móvil emparejado»", () => {
    render(root, state());
    expect(q(".paired-empty")!.hidden).toBe(false);
    expect(q(".paired-empty")!.textContent).toBe("Ningún móvil emparejado");
    render(root, state({ paired: [device()] }));
    expect(q(".paired-empty")!.hidden).toBe(true);
  });

  it("pairNotice visible como aviso informativo y desaparece al limpiarse", () => {
    render(root, state({ pairNotice: "Móvil emparejado" }));
    const n = qa(".notice").find((e) => e.textContent!.includes("Móvil emparejado"))!;
    expect(n.classList.contains("notice-info")).toBe(true);
    expect(q(".notices")!.hidden).toBe(false);
    render(root, state({ pairNotice: null }));
    expect(qa(".notice")).toHaveLength(0);
  });

  it("pairNotice y clipNotice pueden verse a la vez", () => {
    render(root, state({ pairNotice: "uno", clipNotice: "dos" }));
    expect(qa(".notice").map((e) => e.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("uno"), expect.stringContaining("dos")]),
    );
  });
});
