// Pintado puro sobre el DOM: recibe el estado completo y lo refleja en `root`.
// Todo texto que viene del móvil o del portapapeles se asigna con `textContent`,
// nunca como HTML. Los elementos con botones se reutilizan entre pintados para
// no perder foco ni hover cuando el progreso se actualiza varias veces por segundo.

import type { HistoryItem, PairedDevice, Transfer, UiState } from "./types";

/** Caracteres de un texto que se llevan al DOM; el resto se corta (el clic copia el texto completo). */
const MAX_PREVIEW_CHARS = 600;

// Mapas con `Map` y no objetos: `error` puede venir del móvil y "constructor" o
// "toString" no deben resolver a miembros de Object.prototype.
const TRANSPORT_LABEL = new Map([
  ["wifi", "WiFi"],
  ["usb", "USB"],
]);

/**
 * Códigos de fallo que emiten el PC (session.rs, hub.rs, files.rs) y el móvil (session.ts).
 * Un código que no esté aquí se muestra solo como «Falló»: el texto es del móvil y no se enseña.
 */
const ERROR_TEXT = new Map([
  ["link_closed", "se perdió la conexión"],
  ["heartbeat_timeout", "el móvil dejó de responder"],
  ["replaced", "la conexión se reemplazó por una nueva"],
  ["closed", "se cerró la conexión"],
  ["no_peer", "no hay móvil conectado"],
  ["cancelled", "se canceló"],
  ["read_error", "no se pudo leer el archivo"],
  ["write_error", "no se pudo guardar el archivo"],
  ["io_error", "no se pudo guardar el archivo"],
  ["size_mismatch", "el tamaño no coincide"],
  ["checksum_mismatch", "el archivo llegó dañado"],
  ["hash_mismatch", "el archivo llegó dañado"],
  ["protocol_error", "error de protocolo"],
  ["internal_error", "error interno"],
  ["remote_error", "el móvil informó de un error"],
]);

/** Única miniatura que se pinta (la genera el backend); cualquier otra cadena se descarta. */
const THUMB_PREFIX = "data:image/jpeg;base64,";

const UNITS = ["B", "KB", "MB", "GB"];

/** «2,5 MB de 5,0 MB»: coma decimal, múltiplos de 1024 y la unidad del tamaño total. */
export function formatProgress(bytes: number, size: number): string {
  let unit = 0;
  while (unit < UNITS.length - 1 && size >= 1024 ** (unit + 1)) unit++;
  const fmt = (n: number) => {
    const v = Math.max(0, n);
    return unit === 0 ? String(Math.round(v)) : (v / 1024 ** unit).toFixed(1).replace(".", ",");
  };
  return `${fmt(bytes)} ${UNITS[unit]} de ${fmt(size)} ${UNITS[unit]}`;
}

function percent(bytes: number, size: number): number {
  if (!(size > 0)) return 0;
  return Math.min(100, Math.max(0, Math.round((bytes * 100) / size)));
}

function preview(text: string): string {
  if (text.length <= MAX_PREVIEW_CHARS) return text;
  let end = MAX_PREVIEW_CHARS;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // no partir un par sustituto
  return `${text.slice(0, end)}…`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, action: string, className = "btn"): HTMLButtonElement {
  const b = el("button", className, label);
  b.type = "button";
  b.dataset.action = action;
  return b;
}

function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

// --- Esqueleto -------------------------------------------------------------

interface Row {
  el: HTMLElement;
}

interface TransferRow extends Row {
  dir: HTMLElement;
  name: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  detail: HTMLElement;
  head: HTMLElement;
  cancel: HTMLButtonElement;
}

interface PairedRow extends Row {
  name: HTMLElement;
  badge: HTMLElement;
  forget: HTMLButtonElement;
}

interface View {
  top: HTMLElement;
  pcName: HTMLElement;
  status: HTMLElement;
  statusTitle: HTMLElement;
  statusHint: HTMLElement;
  notices: HTMLElement;
  noticeServer: HTMLElement;
  noticeError: HTMLElement;
  noticeInfo: HTMLElement;
  noticePair: HTMLElement;
  pairing: HTMLElement;
  pairingImg: HTMLImageElement;
  pairingCountdown: HTMLElement;
  pairedList: HTMLElement;
  pairedEmpty: HTMLElement;
  pairedRows: Map<string, PairedRow>;
  drop: HTMLElement;
  dropHint: HTMLElement;
  pick: HTMLButtonElement;
  transfers: HTMLElement;
  transferList: HTMLElement;
  transferRows: Map<string, TransferRow>;
  historyList: HTMLElement;
  historyEmpty: HTMLElement;
  historyRows: Map<string, Row>;
}

const views = new WeakMap<HTMLElement, View>();

function notice(kind: "error" | "info"): HTMLElement {
  const n = el("div", `notice notice-${kind}`);
  // El error se anuncia al aparecer; el aviso informativo es más discreto.
  n.setAttribute("role", kind === "error" ? "alert" : "status");
  n.append(el("span", "notice-mark", kind === "error" ? "!" : "i"), el("span", "notice-text"));
  n.firstElementChild?.setAttribute("aria-hidden", "true");
  return n;
}

function build(root: HTMLElement): View {
  const top = el("div", "app");

  const pcName = el("span", "pc-name");
  const brand = el("div", "brand");
  brand.append(el("h1", "brand-name", "ClipSync"), pcName);

  // El enlace PC ↔ móvil es solo decoración: el estado va en el texto.
  const link = el("div", "link");
  link.setAttribute("aria-hidden", "true");
  link.append(el("span", "node node-pc"), el("span", "wire"), el("span", "node node-phone"));
  const statusTitle = el("p", "status-title");
  const statusHint = el("p", "status-hint");
  const status = el("section", "status");
  status.setAttribute("aria-live", "polite");
  status.append(link, el("div", "status-text"));
  status.lastElementChild!.append(statusTitle, statusHint);

  const header = el("header", "top");
  header.append(brand, status);

  const notices = el("div", "notices");
  const noticeServer = notice("error");
  const noticeError = notice("error");
  const noticeInfo = notice("info");
  const noticePair = notice("info");

  // Panel del QR: la imagen se pinta como <img>, nunca como HTML.
  const pairingImg = el("img", "pairing-qr");
  pairingImg.alt = "Código QR de emparejamiento";
  const pairingCountdown = el("p", "pairing-countdown");
  const pairingText = el("div", "pairing-text");
  pairingText.append(el("p", "pairing-title", "Escanéalo con ClipSync en el móvil"), pairingCountdown, button("Cancelar", "cancel-pairing", "btn btn-ghost"));
  const pairing = el("div", "pairing");
  pairing.append(pairingText); // la imagen solo está en el DOM mientras hay un QR vigente

  const pairedList = el("ul", "paired-list");
  const pairedEmpty = el("p", "paired-empty", "Ningún móvil emparejado");
  const pairHead = el("div", "section-head");
  pairHead.append(el("h2", "section-title", "Móviles emparejados"), button("Emparejar móvil", "start-pairing", "btn btn-primary"));
  const paired = el("section", "paired");
  paired.append(pairHead, pairing, pairedList, pairedEmpty);

  const dropHint = el("p", "drop-hint");
  const pick = button("Elegir archivo", "pick-files", "btn btn-primary");
  const drop = el("div", "drop");
  drop.append(dropHint, pick);
  const send = el("section", "send");
  send.append(el("h2", "section-title", "Enviar archivo"), drop);

  const transferList = el("ul", "transfer-list");
  const transfers = el("section", "transfers");
  transfers.append(el("h2", "section-title", "Transferencias"), transferList);

  const historyList = el("ul", "hist-list");
  const historyEmpty = el("p", "hist-empty", "Los textos que copies con el móvil conectado aparecerán aquí.");
  const history = el("section", "history");
  history.append(el("h2", "section-title", "Historial"), historyList, historyEmpty);

  top.append(header, notices, paired, send, transfers, history);
  root.replaceChildren(top);

  return {
    top,
    pcName,
    status,
    statusTitle,
    statusHint,
    notices,
    noticeServer,
    noticeError,
    noticeInfo,
    noticePair,
    pairing,
    pairingImg,
    pairingCountdown,
    pairedList,
    pairedEmpty,
    pairedRows: new Map(),
    drop,
    dropHint,
    pick,
    transfers,
    transferList,
    transferRows: new Map(),
    historyList,
    historyEmpty,
    historyRows: new Map(),
  };
}

// --- Secciones -------------------------------------------------------------

function renderStatus(view: View, state: UiState): boolean {
  // El último peer es el más reciente: durante un relevo de sesión puede haber
  // dos y se enseña el nuevo, sin pasar por «Esperando».
  const peer = state.peers[state.peers.length - 1];
  setText(view.pcName, state.pcName);
  view.status.dataset.connected = peer ? "true" : "false";
  if (peer) {
    const name = peer.deviceName || "el móvil";
    const via = TRANSPORT_LABEL.get(peer.transport);
    setText(view.statusTitle, `Conectado con ${name}${via ? ` por ${via}` : ""}`);
    view.statusHint.hidden = true;
  } else {
    setText(view.statusTitle, "Esperando al móvil…");
    setText(
      view.statusHint,
      state.paired.length === 0
        ? "Pulsa «Emparejar móvil» y escanea el QR con ClipSync en el móvil"
        : "Abre ClipSync en el móvil, conectado a la misma red WiFi o por cable USB",
    );
    view.statusHint.hidden = false;
  }
  return Boolean(peer);
}

function setNotice(host: HTMLElement, node: HTMLElement, text: string | null | undefined, atStart: boolean): void {
  if (!text) {
    node.remove();
    return;
  }
  setText(node.lastElementChild!, text);
  if (node.parentElement !== host) atStart ? host.prepend(node) : host.append(node);
}

function renderNotices(view: View, state: UiState): void {
  setNotice(view.notices, view.noticeError, state.clipboardError, true);
  // el del servidor va el primero: sin él no hay conexión posible
  setNotice(view.notices, view.noticeServer, state.serverError, true);
  setNotice(view.notices, view.noticeInfo, state.clipNotice, false);
  setNotice(view.notices, view.noticePair, state.pairNotice, false);
  view.notices.hidden = view.notices.childElementCount === 0;
}

/** «Caduca en m:ss»: segundos redondeados hacia arriba y nunca negativos. */
function formatCountdown(expiresAtMs: number, nowMs: number): string {
  const total = Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
  const seconds = total % 60;
  return `Caduca en ${Math.floor(total / 60)}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function renderPairing(view: View, state: UiState, nowMs: number): void {
  const p = state.pairing;
  // El backend ya descarta el QR caducado; aquí se oculta sin esperar a su aviso.
  const live = p !== null && p.expiresAtMs - nowMs > 0;
  view.pairing.hidden = !live;
  if (!live) {
    view.pairingImg.remove();
    return;
  }
  if (!view.pairingImg.parentElement) view.pairing.prepend(view.pairingImg);
  // Solo se toca `src` si cambia: así el QR no parpadea al repintar cada segundo.
  const src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(p.qrSvg);
  if (view.pairingImg.getAttribute("src") !== src) view.pairingImg.setAttribute("src", src);
  setText(view.pairingCountdown, formatCountdown(p.expiresAtMs, nowMs));
}

function createPaired(d: PairedDevice): PairedRow {
  const li = el("li", "paired-item");
  const name = el("span", "paired-name");
  const badge = el("span", "paired-badge", "Conectado");
  const forget = button("Olvidar", "forget", "btn btn-ghost");
  forget.dataset.deviceKey = d.deviceKey;
  li.append(name, forget);
  return { el: li, name, badge, forget };
}

function updatePaired(row: PairedRow, d: PairedDevice): void {
  setText(row.name, d.deviceName);
  row.name.title = d.deviceName;
  row.forget.setAttribute("aria-label", `Olvidar ${d.deviceName}`);
  if (d.connected && !row.badge.parentElement) row.el.insertBefore(row.badge, row.forget);
  else if (!d.connected && row.badge.parentElement) row.badge.remove();
}

function renderPaired(view: View, state: UiState): void {
  syncList(view.pairedList, view.pairedRows, state.paired, (d) => d.deviceKey, createPaired, updatePaired);
  view.pairedList.hidden = state.paired.length === 0;
  view.pairedEmpty.hidden = state.paired.length > 0;
}

function renderSend(view: View, connected: boolean): void {
  view.pick.disabled = !connected;
  view.drop.setAttribute("aria-disabled", String(!connected));
  setText(view.dropHint, connected ? "Suelta archivos aquí para enviarlos" : "Conecta el móvil para enviar");
}

/** Reconcilia una lista por clave: reutiliza, ordena y elimina filas sin tocar las que no cambian. */
function syncList<T, R extends Row>(
  list: HTMLElement,
  rows: Map<string, R>,
  items: T[],
  keyOf: (item: T) => string,
  create: (item: T) => R,
  update: (row: R, item: T) => void,
): void {
  const seen = new Set<string>();
  let prev: Element | null = null;
  for (const item of items) {
    const key = keyOf(item);
    let row = rows.get(key);
    if (!row) {
      row = create(item);
      rows.set(key, row);
    }
    update(row, item);
    const expected: Element | null = prev ? prev.nextElementSibling : list.firstElementChild;
    if (expected !== row.el) list.insertBefore(row.el, expected);
    prev = row.el;
    seen.add(key);
  }
  for (const [key, row] of rows) {
    if (!seen.has(key)) {
      row.el.remove();
      rows.delete(key);
    }
  }
}

function createTransfer(t: Transfer): TransferRow {
  const li = el("li", "transfer");
  li.dataset.transferId = t.transferId;
  const dir = el("span", "dir");
  dir.setAttribute("role", "img");
  const name = el("span", "transfer-name");
  const cancel = button("Cancelar", "cancel", "btn btn-ghost");
  cancel.dataset.transferId = t.transferId;
  const head = el("div", "transfer-head");
  head.append(dir, name, cancel);
  const fill = el("span", "bar-fill");
  const bar = el("div", "bar");
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.append(fill);
  const detail = el("p", "transfer-detail");
  li.append(head, bar, detail);
  return { el: li, dir, name, bar, fill, detail, head, cancel };
}

function updateTransfer(row: TransferRow, t: Transfer): void {
  const outgoing = t.direction === "out";
  row.dir.className = `dir ${outgoing ? "dir-out" : "dir-in"}`;
  row.dir.setAttribute("aria-label", outgoing ? "Enviando" : "Recibiendo");
  setText(row.dir, outgoing ? "↑" : "↓");
  setText(row.name, t.name);
  row.name.title = t.name;

  row.el.dataset.state = t.state;
  const pct = percent(t.bytes, t.size);
  row.fill.style.width = `${pct}%`;
  row.bar.setAttribute("aria-valuenow", String(pct));
  row.bar.setAttribute("aria-label", `Progreso de ${t.name}`);

  let detail: string;
  switch (t.state) {
    case "queued":
      detail = "En cola";
      break;
    case "cancelled":
      detail = "Cancelado";
      break;
    case "failed": {
      const reason = t.error ? ERROR_TEXT.get(t.error) : undefined;
      detail = reason ? `Falló: ${reason}` : "Falló";
      break;
    }
    default:
      detail = formatProgress(t.bytes, t.size);
  }
  setText(row.detail, detail);

  // Cancelar solo tiene sentido mientras la transferencia sigue viva.
  const alive = t.state === "queued" || t.state === "active";
  row.cancel.setAttribute("aria-label", `Cancelar ${t.name}`);
  if (alive && !row.cancel.parentElement) row.head.append(row.cancel);
  else if (!alive && row.cancel.parentElement) row.cancel.remove();
}

function renderTransfers(view: View, state: UiState): void {
  syncList(view.transferList, view.transferRows, state.transfers, (t) => t.transferId, createTransfer, updateTransfer);
  view.transfers.hidden = state.transfers.length === 0;
}

function formatTime(atMs: number): { label: string; iso: string } | null {
  if (!Number.isFinite(atMs) || atMs <= 0) return null;
  const d = new Date(atMs);
  if (Number.isNaN(d.getTime())) return null;
  return { label: d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }), iso: d.toISOString() };
}

// Un elemento del historial no cambia una vez creado, así que no hay `update`.
function createHistory(h: HistoryItem): Row {
  const li = el("li", "hist-item");
  li.dataset.kind = h.kind;
  li.dataset.direction = h.direction;

  const dir = el("span", "dir");
  if (h.direction === "local") {
    // Texto del PC sustituido por el del móvil al conectar.
    dir.className = "dir dir-local";
    dir.textContent = "En este PC";
  } else {
    const outgoing = h.direction === "out";
    dir.className = `dir ${outgoing ? "dir-out" : "dir-in"}`;
    dir.setAttribute("role", "img");
    dir.setAttribute("aria-label", outgoing ? "Enviado" : "Recibido");
    dir.textContent = outgoing ? "↑" : "↓";
  }

  const body = el("div", "hist-body");
  if (h.kind === "image") {
    const copy = button("", "copy-image", "hist-image-btn");
    copy.dataset.historyId = String(h.id);
    copy.title = "Copiar imagen al portapapeles";
    // `src` solo por propiedad y tras comprobar el prefijo; si no, marcador neutro.
    if (typeof h.thumbnail === "string" && h.thumbnail.startsWith(THUMB_PREFIX)) {
      const img = el("img", "hist-thumb");
      img.alt = "Imagen copiada";
      img.src = h.thumbnail;
      copy.append(img);
    } else {
      copy.append(el("span", "hist-thumb-placeholder", "Imagen"));
    }
    body.append(copy);
    if (h.location) {
      const reveal = button("Abrir carpeta", "reveal", "btn btn-ghost");
      reveal.dataset.historyId = String(h.id);
      reveal.setAttribute("aria-label", `Abrir carpeta de ${h.fileName || "la imagen"}`);
      body.append(reveal);
    }
  } else if (h.kind === "file") {
    const fileName = h.fileName || "archivo";
    const name = el("span", "hist-file-name", fileName);
    name.title = fileName;
    body.append(name);
    if (h.location) {
      const reveal = button("Abrir carpeta", "reveal", "btn btn-ghost");
      reveal.dataset.historyId = String(h.id);
      reveal.setAttribute("aria-label", `Abrir carpeta de ${fileName}`);
      body.append(reveal);
    }
  } else {
    const copy = button("", "copy", "hist-text-btn");
    copy.dataset.historyId = String(h.id);
    copy.title = "Copiar al portapapeles";
    copy.append(el("span", "hist-text clamp-3", preview(h.text ?? "")));
    body.append(copy);
  }

  li.append(dir, body);
  const time = formatTime(h.atMs);
  if (time) {
    const t = el("time", "hist-time", time.label);
    t.dateTime = time.iso;
    li.append(t);
  }
  return { el: li };
}

function renderHistory(view: View, state: UiState): void {
  syncList(
    view.historyList,
    view.historyRows,
    state.history,
    (h) => String(h.id),
    createHistory,
    () => {},
  );
  view.historyEmpty.hidden = state.history.length > 0;
}

export function render(root: HTMLElement, state: UiState, nowMs = Date.now()): void {
  let view = views.get(root);
  if (!view || !root.contains(view.top)) {
    view = build(root);
    views.set(root, view);
  }
  const connected = renderStatus(view, state);
  renderNotices(view, state);
  renderPairing(view, state, nowMs);
  renderPaired(view, state);
  renderSend(view, connected);
  renderTransfers(view, state);
  renderHistory(view, state);
}
