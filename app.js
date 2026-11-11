/* jlflashcon web: visor de YouTube sin anuncios + listas + buscadores + descargas (con servidor opcional) */
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PL_RE = /^(PL|UU|OL|FL|LL|RD)[A-Za-z0-9_-]{10,}$/;
const MAX_RESULTS = 50;
const DEFAULT_SERVER = "http://localhost:8765";
const PIPED = ["https://api.piped.private.coffee", "https://pipedapi.kavin.rocks", "https://pipedapi.adminforge.de"];

const st = {
  server: null,          // URL del servidor de descargas si responde
  entries: [],           // [{id,title,author,authorUrl,kind}]
  source: null,          // playlist | search_video | search_list
  playing: null,
  busy: false,
  searchTok: 0, plTok: 0,
  authorUrls: {},
};

/* ---------- utilidades ---------- */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } },
};
const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase();
const setStatus = (t) => { $("status").textContent = t || ""; };

function videoId(text) {
  text = (text || "").trim();
  if (ID_RE.test(text)) return text;
  try {
    const u = new URL(text.includes("://") ? text : "https://" + text);
    if (u.hostname.includes("youtu.be")) { const v = u.pathname.slice(1, 12); return ID_RE.test(v) ? v : null; }
    const v = u.searchParams.get("v") || (u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/) || [])[1];
    return v && ID_RE.test(v) ? v : null;
  } catch { return null; }
}
function playlistId(text) {
  text = (text || "").trim();
  const m = text.match(/[?&]list=([\w-]+)/);
  if (m) return m[1];
  return PL_RE.test(text) ? text : null;
}
function friendlyError(msg) {
  const low = String(msg || "").toLowerCase();
  const map = [["country", "vídeo no disponible en tu país"], ["private video", "vídeo privado"],
    ["confirm your age", "vídeo con restricción de edad (YouTube pide iniciar sesión)"],
    ["not a bot", "YouTube pide verificar que no eres un robot (inténtalo más tarde)"],
    ["429", "demasiadas peticiones a YouTube: espera unos minutos"],
    ["unavailable", "vídeo no disponible (borrado, privado o bloqueado)"]];
  for (const [k, t] of map) if (low.includes(k)) return t;
  return String(msg || "error desconocido").slice(0, 200);
}
async function fetchJson(url, ms = 15000, opts = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  } finally { clearTimeout(t); }
}

/* ---------- reproductor sin anuncios (youtube-nocookie) ---------- */
/* El truco de yout-ube.com: esa pagina solo hace window.location = youtube-nocookie.com/embed/ID, es decir, abre el
   reproductor como pagina PRINCIPAL (no dentro de otra web). Asi YouTube no ve una web de terceros ni sus cookies
   y no pone anuncios. Dentro de un iframe (como antes) si salen. Por eso por defecto se abre en pestana nueva. */
const embedUrl = (id) => `https://www.youtube-nocookie.com/embed/${id}?playlist=${id}&autoplay=1&iv_load_policy=3&loop=1&rel=0`;
const tabMode = () => { try { return localStorage.getItem("jl_tab") !== "0"; } catch (e) { return true; } };
function play(id, userClick = true) {
  st.playing = id;
  $("url").value = `https://www.youtube.com/watch?v=${id}`;
  let opened = null;
  if (tabMode() && userClick) {
    opened = window.open(embedUrl(id), "_blank");
    if (opened) opened.opener = null;
  }
  if (opened) {
    $("player").innerHTML = `<div class="ph"><a href="${embedUrl(id)}" target="_blank" rel="noopener" style="color:inherit">▶ Abierto sin anuncios en otra pestaña<br><small>pulsa aquí para abrirlo de nuevo</small></a></div>`;
  } else {
    $("player").innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1"
      title="Reproductor" credentialless allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen
      referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
  }
  highlight();
}
function resetPlayer() {
  st.playing = null; $("url").value = "";
  $("player").innerHTML = `<div class="ph">jlflashcon</div>`;
  highlight();
}
function highlight() {
  document.querySelectorAll("#list li").forEach((li) => li.classList.toggle("playing", li.dataset.id === st.playing));
}

/* ---------- servidor de descargas (opcional) ---------- */
async function checkServer(url) {
  try {
    const j = await fetchJson(url.replace(/\/+$/, "") + "/api/ping", 3000);
    if (j.ok) return true;
  } catch { /* sin servidor */ }
  return false;
}
async function initServer() {
  const url = store.get("jl_server", DEFAULT_SERVER);
  const ok = await checkServer(url);
  st.server = ok ? url.replace(/\/+$/, "") : null;
  const chip = $("srv");
  chip.className = "chip " + (ok ? "ok" : "off");
  chip.textContent = ok ? "🟢 Servidor conectado" : "⚪ Sin servidor (modo básico)";
  updateAllButtons();
}

/* ---------- datos: servidor, o Piped como plan B para buscar/listas ---------- */
async function pipedGet(path) {
  let last;
  for (const inst of PIPED) {
    try { return await fetchJson(inst + path, 9000); } catch (e) { last = e; }
  }
  throw new Error("No hay ningún servicio de búsqueda disponible. Arranca el servidor de jlflashcon (⚙).");
}
const pid = (u, key) => ((u || "").match(new RegExp(key + "=([\\w-]+)")) || [])[1] || "";

async function apiSearch(kind, title, author, channel) {
  if (st.server) {
    const q = new URLSearchParams({ kind, title, author, channel: channel || "" });
    return (await fetchJson(`${st.server}/api/search?${q}`, 90000)).results;
  }
  // plan B (Piped): mas limitado que con el servidor
  const want = norm(author).replace(/^@/, "");
  const keep = (name) => !want || norm(name).includes(want);
  if (kind === "video") {
    if (!title && author) {
      const ch = (await pipedGet(`/search?q=${encodeURIComponent(author)}&filter=channels`)).items?.[0];
      if (!ch) return [];
      const c = await pipedGet(ch.url);
      return (c.relatedStreams || []).map((s) => ({
        id: pid(s.url, "v"), title: s.title, author: c.name || author, authorUrl: ch.url }));
    }
    const r = await pipedGet(`/search?q=${encodeURIComponent((title + " " + author).trim())}&filter=videos`);
    return (r.items || []).filter((s) => keep(s.uploaderName)).slice(0, MAX_RESULTS).map((s) => ({
      id: pid(s.url, "v"), title: s.title, author: s.uploaderName || "", authorUrl: s.uploaderUrl || "" }));
  }
  const r = await pipedGet(`/search?q=${encodeURIComponent((title + " " + author).trim())}&filter=playlists`);
  return (r.items || []).filter((s) => keep(s.uploaderName)).slice(0, MAX_RESULTS).map((s) => ({
    id: pid(s.url, "list"), title: s.name, author: s.uploaderName || "", authorUrl: "" }));
}
async function apiPlaylist(id) {
  if (st.server) return await fetchJson(`${st.server}/api/playlist?id=${encodeURIComponent(id)}`, 90000);
  const r = await pipedGet(`/playlists/${id}`);
  return { title: r.name || "lista", entries: (r.relatedStreams || []).map((s) => ({
    id: pid(s.url, "v"), title: s.title, author: s.uploaderName || r.uploader || "", authorUrl: "" })) };
}

/* ---------- lista en pantalla ---------- */
function clearList() {
  st.entries = []; st.source = null;
  $("list").innerHTML = ""; updateAllButtons();
}
function renderList() {
  const ul = $("list"); ul.innerHTML = "";
  st.entries.forEach((e, i) => {
    const li = document.createElement("li");
    li.dataset.id = e.id; li.dataset.i = i;
    const t = document.createElement("span"); t.className = "t";
    t.textContent = `${i + 1}. ${e.kind === "playlist" ? "📃 " : ""}${e.title}`;
    li.append(t);
    if (e.author) {
      const w = document.createElement("button"); w.className = "who"; w.type = "button";
      w.textContent = "👤 " + e.author;
      const videos = st.source === "search_video";
      w.title = videos ? `Ver todos los vídeos de ${e.author}` : `Ver todas las listas de ${e.author}`;
      w.onclick = () => (videos ? authorVideos(e.author) : authorLists(e.author));
      li.append(w);
    }
    const b = document.createElement("div"); b.className = "btns";
    const mk = (txt, fn) => { const x = document.createElement("button"); x.type = "button"; x.textContent = txt; x.onclick = fn; b.append(x); };
    if (e.kind === "playlist") mk("📃 Abrir lista", () => openPlaylist(e.id));
    else { mk("▶ Ver", () => play(e.id)); mk("⬇ MP3", () => download([e.id], "mp3")); mk("⬇ MP4", () => download([e.id], "mp4")); }
    li.append(b);
    li.addEventListener("contextmenu", (ev) => { ev.preventDefault(); rowMenu(ev.clientX, ev.clientY, e); });
    longPress(li, (x, y) => rowMenu(x, y, e));
    ul.append(li);
  });
  highlight(); updateAllButtons();
}
function canAll() { return st.entries.length > 0 && st.entries[0].kind !== "playlist"; }
function updateAllButtons() {
  if (st.entries.length && st.entries[0].kind !== "playlist" && $("r-bis").dataset.n !== String(st.entries.length)) {
    $("r-bis").dataset.n = st.entries.length; $("r-ab").value = 1; $("r-bis").value = st.entries.length;
  }
  const on = canAll() && !st.busy;
  $("b-all-mp3").disabled = !on; $("b-all-mp4").disabled = !on; $("b-range").disabled = !on;
}

/* ---------- menu copiar (boton derecho / pulsacion larga) ---------- */
function hideMenus() { $("menu").hidden = true; $("hist").hidden = true; }
function placeMenu(el, x, y) {
  el.hidden = false;
  const r = el.getBoundingClientRect();
  el.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
  el.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + "px";
}
function rowMenu(x, y, e) {
  const m = $("menu"); m.innerHTML = "";
  const add = (label, text) => {
    const b = document.createElement("button"); b.textContent = label; b.disabled = !text;
    b.onclick = async () => { hideMenus(); try { await navigator.clipboard.writeText(text); setStatus("Copiado: " + text); } catch { setStatus("No pude copiar al portapapeles"); } };
    m.append(b);
  };
  add(e.kind === "playlist" ? "📋 Copiar nombre de la lista" : "📋 Copiar nombre del vídeo", e.title);
  add("📋 Copiar autor", e.author);
  placeMenu(m, x, y);
}
function longPress(el, fn) {
  let t = null, sx = 0, sy = 0;
  el.addEventListener("touchstart", (ev) => { const p = ev.touches[0]; sx = p.clientX; sy = p.clientY; t = setTimeout(() => fn(sx, sy), 600); }, { passive: true });
  const cancel = () => { clearTimeout(t); t = null; };
  el.addEventListener("touchend", cancel); el.addEventListener("touchmove", cancel); el.addEventListener("touchcancel", cancel);
}
document.addEventListener("click", (ev) => { if (!ev.target.closest(".ctx")) hideMenus(); });
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hideMenus(); });

/* ---------- historial de busquedas (al pulsar ESPACIO) ---------- */
const HIST_MAX = 30;
const hist = {
  all() { return store.get("jl_hist", {}); },
  list(k) { return hist.all()[k] || []; },
  add(k, text) {
    text = (text || "").trim(); if (!text) return;
    const a = hist.all();
    a[k] = [text, ...(a[k] || []).filter((x) => x.toLowerCase() !== text.toLowerCase())].slice(0, HIST_MAX);
    store.set("jl_hist", a);
  },
};
function attachHistory(input) {
  const key = input.dataset.hist;
  const show = () => {
    const q = input.value.trim().toLowerCase();
    const items = hist.list(key).filter((x) => !q || x.toLowerCase().includes(q));
    const h = $("hist"); h.innerHTML = "";
    if (!items.length) { h.hidden = true; return; }
    items.forEach((x) => {
      const d = document.createElement("div"); d.textContent = x;
      d.onmousedown = (ev) => { ev.preventDefault(); input.value = x; h.hidden = true; input.focus(); };
      h.append(d);
    });
    const r = input.getBoundingClientRect();
    placeMenu(h, r.left, r.bottom + 2);
  };
  input.addEventListener("input", () => { if (/\s$/.test(input.value) || input.value === "") { if (input.value !== "") show(); } });
  input.addEventListener("keydown", (ev) => { if (ev.key === "ArrowDown") show(); });
  input.addEventListener("blur", () => setTimeout(() => { $("hist").hidden = true; }, 150));
}
document.querySelectorAll("input[data-hist]").forEach(attachHistory);

/* ---------- buscadores ---------- */
async function search(kind) {
  const [te, ae] = kind === "video" ? [$("q-video"), $("a-video")] : [$("q-list"), $("a-list")];
  const title = te.value.trim(), author = ae.value.trim();
  if (!title && !author) { setStatus("Escribe el título, el autor, o los dos"); return; }
  const pre = kind === "video" ? "video" : "list";
  hist.add(pre + "_title", title); hist.add(pre + "_author", author);
  const tok = ++st.searchTok;
  $("b-sv").disabled = $("b-sl").disabled = true;
  setStatus("Buscando…");
  const label = title && author ? `${title} · autor ${author}` : title || `autor ${author}`;
  try {
    const res = await apiSearch(kind, title, author, st.authorUrls[author] || "");
    if (tok !== st.searchTok) return;
    res.forEach((r) => { if (r.author && r.authorUrl) st.authorUrls[r.author] = r.authorUrl; });
    st.source = kind === "video" ? "search_video" : "search_list";
    st.entries = res.filter((r) => r.id).map((r) => ({ ...r, kind }));
    renderList();
    setStatus(st.entries.length ? `${st.entries.length} ${kind === "video" ? "vídeos" : "listas"} para «${label}»`
      : `Sin resultados para «${label}»: puedes volver a buscar`);
    if (kind === "video" && st.entries.length && !st.playing) play(st.entries[0].id, false);
  } catch (e) {
    if (tok !== st.searchTok) return;
    setStatus(`No pude buscar: ${friendlyError(e.message)} (puedes volver a buscar)`);
  } finally {
    if (tok === st.searchTok) $("b-sv").disabled = $("b-sl").disabled = false;
  }
}
function cancelSearch(source) {
  st.searchTok++; $("b-sv").disabled = $("b-sl").disabled = false;
  if (st.source === source) clearList();
  setStatus("");
}
function authorVideos(a) { $("q-video").value = ""; $("a-video").value = a; search("video"); }
function authorLists(a) { $("q-list").value = ""; $("a-list").value = a; search("playlist"); }

/* ---------- listas ---------- */
async function loadPlaylist() {
  const id = playlistId($("plurl").value);
  if (!id) { setStatus("No he reconocido ninguna lista de reproducción (falta list=…)."); return; }
  const tok = ++st.plTok;
  $("b-load").disabled = true; setStatus("Cargando la lista…");
  try {
    const r = await apiPlaylist(id);
    if (tok !== st.plTok) return;
    st.source = "playlist";
    r.entries.forEach((e) => { if (e.author && e.authorUrl) st.authorUrls[e.author] = e.authorUrl; });
    st.entries = r.entries.filter((e) => e.id).map((e) => ({ ...e, kind: "video" }));
    renderList();
    setStatus(st.entries.length ? `«${r.title}»: ${st.entries.length} vídeos` : "La lista está vacía o es privada");
    if (st.entries.length && !st.playing) play(st.entries[0].id, false);
  } catch (e) {
    if (tok === st.plTok) setStatus(`No pude cargar la lista: ${friendlyError(e.message)} (pulsa Cargar para reintentar)`);
  } finally { if (tok === st.plTok) $("b-load").disabled = false; }
}
function openPlaylist(id) { $("plurl").value = `https://www.youtube.com/playlist?list=${id}`; loadPlaylist(); }

/* ---------- descargas ---------- */
function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function downloadOne(id, kind, onProgress) {
  const q = new URLSearchParams({ id, kind, q: $("quality").value });
  const r = await fetch(`${st.server}/api/download?${q}`);
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
  const total = +r.headers.get("Content-Length") || 0;
  const name = decodeURIComponent(r.headers.get("X-Filename") || `${id}.${kind}`);
  const reader = r.body.getReader(); const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    chunks.push(value); got += value.length;
    if (total) onProgress(Math.round((got * 100) / total));
  }
  saveBlob(new Blob(chunks, { type: kind === "mp3" ? "audio/mpeg" : "video/mp4" }), name);
  return name;
}
async function download(ids, kind) {
  if (!ids.length) return;
  if (!st.server) {
    setStatus("Para descargar necesitas el servidor de jlflashcon (botón ⚙): " +
      "ejecuta servidor/jlflashcon_server.py en tu ordenador.");
    return;
  }
  if (st.busy) { setStatus("Ya hay una descarga en curso"); return; }
  st.busy = true; updateAllButtons();
  $("bar-wrap").hidden = false; $("bar").value = 0;
  let ok = 0, firstErr = "";
  for (let i = 0; i < ids.length; i++) {
    const pre = ids.length > 1 ? `[${i + 1}/${ids.length}] ` : "";
    setStatus(`${pre}Preparando en el servidor… (puede tardar)`);
    try {
      const name = await downloadOne(ids[i], kind, (p) => {
        $("bar").value = Math.round((i * 100 + p) / ids.length); setStatus(`${pre}Recibiendo… ${p}%`);
      });
      ok++; setStatus(`${pre}Guardado: ${name}`);
    } catch (e) { if (!firstErr) firstErr = friendlyError(e.message); }
  }
  st.busy = false; $("bar-wrap").hidden = true; updateAllButtons();
  setStatus(firstErr ? `Guardados ${ok} de ${ids.length}. Error: ${firstErr}`
    : ids.length === 1 ? "Guardado en tu carpeta de descargas" : `Listo: ${ok} de ${ids.length} guardados en tu carpeta de descargas`);
}
window.addEventListener("beforeunload", (ev) => { if (st.busy) { ev.preventDefault(); ev.returnValue = ""; } });

/* ---------- eventos ---------- */
$("f-video").onsubmit = (ev) => { ev.preventDefault(); const id = videoId($("url").value); id ? play(id) : setStatus("No he reconocido ninguna URL/ID de vídeo de YouTube."); };
$("f-list").onsubmit = (ev) => { ev.preventDefault(); loadPlaylist(); };
$("f-sv").onsubmit = (ev) => { ev.preventDefault(); search("video"); };
$("f-sl").onsubmit = (ev) => { ev.preventDefault(); search("playlist"); };
$("x-url").onclick = () => { resetPlayer(); $("url").focus(); };
$("x-pl").onclick = () => { $("plurl").value = ""; st.plTok++; $("b-load").disabled = false; if (st.source === "playlist") clearList(); setStatus(""); $("plurl").focus(); };
$("x-sv").onclick = () => { $("q-video").value = $("a-video").value = ""; cancelSearch("search_video"); $("q-video").focus(); };
$("x-sl").onclick = () => { $("q-list").value = $("a-list").value = ""; cancelSearch("search_list"); $("q-list").focus(); };
$("b-all-mp3").onclick = () => download(st.entries.filter((e) => e.kind !== "playlist").map((e) => e.id), "mp3");
$("c-tab").checked = tabMode();
$("c-tab").onchange = () => { try { localStorage.setItem("jl_tab", $("c-tab").checked ? "1" : "0"); } catch (e) {} };
$("b-range").onclick = () => {
  const ids = st.entries.filter((e) => e.kind !== "playlist").map((e) => e.id);
  let a = parseInt($("r-ab").value, 10) || 1, b = parseInt($("r-bis").value, 10) || ids.length;
  if (a > b) [a, b] = [b, a];
  const sel = ids.slice(a - 1, b);
  if (!sel.length) { $("status").textContent = `No hay vídeos entre el ${a} y el ${b} (la lista tiene ${ids.length}).`; return; }
  download(sel, "mp4");
};
$("b-all-mp4").onclick = () => download(st.entries.filter((e) => e.kind !== "playlist").map((e) => e.id), "mp4");
$("b-new").onclick = () => window.open(location.href, "_blank", "noopener");
$("b-settings").onclick = () => { $("srv-url").value = store.get("jl_server", DEFAULT_SERVER); $("dlg-settings").showModal(); };
$("dlg-settings").addEventListener("close", async () => {
  if ($("dlg-settings").returnValue !== "ok") return;
  store.set("jl_server", $("srv-url").value.trim() || DEFAULT_SERVER);
  await initServer();
  setStatus(st.server ? "Servidor conectado" : "No se pudo conectar con ese servidor");
});
$("quality").value = store.get("jl_quality", "1080p");
$("quality").onchange = () => store.set("jl_quality", $("quality").value);

/* ---------- arranque ---------- */
initServer();
const params = new URLSearchParams(location.search);       // ?v=ID o ?list=ID para abrir directo
if (params.get("v") && ID_RE.test(params.get("v"))) play(params.get("v"), false);
if (params.get("list") && PL_RE.test(params.get("list"))) { $("plurl").value = params.get("list"); loadPlaylist(); }
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});

// para las pruebas automaticas
window.__jl = { st, search, loadPlaylist, download, play, videoId, playlistId, renderList, apiSearch };
})();
