/* Comparador de carpeta con los vídeos de un canal (web). Necesita el servidor de descargas y un navegador con
   selector de carpetas (Chrome / Edge, de escritorio o Android). Sin subir nada: la carpeta se lee y se escribe en tu equipo. */
(() => {
"use strict";
const $ = (id) => document.getElementById(id);
const DEFAULT_SERVER = "http://localhost:8765";
const VIDEO_EXT = new Set(["mp4", "mkv", "webm", "avi", "mov", "m4v", "3gp", "flv"]);
const S = { dir: null, local: [], missing: [], total: 0, have: 0, paused: false, abort: null, server: null };

const norm = (s) => (s || "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase()
  .replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, " ").trim();
const msg = (t) => { $("cmp-msg").textContent = t || ""; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function serverUrl() {
  let u = DEFAULT_SERVER;
  try { const v = JSON.parse(localStorage.getItem("jl_server")); if (v) u = v; } catch { /* por defecto */ }
  return u.replace(/\/+$/, "");
}
async function pingServer() {
  try {
    const r = await fetch(serverUrl() + "/api/ping", { signal: AbortSignal.timeout(3000) });
    S.server = (await r.json()).ok ? serverUrl() : null;
  } catch { S.server = null; }
  return S.server;
}
function channelUrl(t) {
  t = t.trim(); if (!t) return "";
  if (!/^https?:\/\//i.test(t)) t = "https://www.youtube.com/" + (t.startsWith("@") ? t : t.includes("youtube.com") ? t : "@" + t);
  return t;
}
const have = (v) => { const t = norm(v.title); return S.local.some((l) => l.raw.includes(v.id) || (t.length > 6 && (l.n === t || l.n.includes(t)))); };
const counts = () => { $("cmp-total").textContent = S.total; $("cmp-have").textContent = S.have; $("cmp-miss").textContent = S.missing.length; };

async function scanDir(handle, c, names) {
  for await (const e of handle.values()) {
    if (e.kind === "directory") { c.folders++; await scanDir(e, c, names); }
    else { c.files++; if (VIDEO_EXT.has(e.name.split(".").pop().toLowerCase())) { c.videos++; names.push(e.name); } }
  }
}
async function scan() {
  msg("Contando carpeta y subcarpetas…");
  const c = { folders: 0, files: 0, videos: 0 }, names = [];
  await scanDir(S.dir, c, names);
  S.local = names.map((raw) => ({ raw, n: norm(raw) }));
  $("cmp-folders").textContent = c.folders; $("cmp-files").textContent = c.files; $("cmp-videos").textContent = c.videos;
  $("cmp-scan").hidden = false; $("cmp-compare").disabled = false;
  msg("Carpeta analizada.");
}

$("b-cmp").onclick = async () => {
  $("dlg-cmp").showModal();
  if (!window.showDirectoryPicker) { msg("Este navegador no permite elegir carpetas. Usa Chrome o Edge."); $("cmp-pick").disabled = true; return; }
  if (!(await pingServer())) msg("⚪ No encuentro el servidor de descargas (⚙ para configurarlo). Sin él no se puede leer el canal ni descargar.");
  else msg("🟢 Servidor conectado.");
};
$("cmp-close").onclick = () => { if (S.abort) S.abort.abort(); S.paused = true; $("dlg-cmp").close(); };

$("cmp-pick").onclick = async () => {
  try { S.dir = await window.showDirectoryPicker({ mode: "readwrite" }); } catch { return msg("Selección cancelada."); }
  $("cmp-dir").textContent = "Carpeta: " + S.dir.name;
  try { await scan(); } catch (e) { msg("Error: " + e.message); }
};

$("cmp-compare").onclick = async () => {
  const url = channelUrl($("cmp-chan").value);
  if (!url) return msg("Escribe el canal.");
  if (!S.server && !(await pingServer())) return msg("Sin servidor de descargas: no puedo leer el canal.");
  $("cmp-compare").disabled = true; msg("Leyendo vídeos del canal (puede tardar un minuto)…");
  try {
    const r = await fetch(`${S.server}/api/channel?url=${encodeURIComponent(url)}`);
    const j = await r.json(); if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
    S.missing = j.videos.filter((v) => !have(v));
    S.total = j.videos.length; S.have = S.total - S.missing.length;
    $("cmp-list").innerHTML = S.missing.map((v) => `<li id="cv-${v.id}">${esc(v.title)}<small>pendiente</small></li>`).join("");
    $("cmp-res").hidden = false; counts();
    $("cmp-down").disabled = !S.missing.length; $("cmp-down").textContent = "⬇ Descargar los que faltan";
    msg(`${j.channel}: ` + (S.missing.length ? `faltan ${S.missing.length} vídeos` : "¡lo tienes todo!"));
  } catch (e) { msg("Error: " + e.message); }
  $("cmp-compare").disabled = false;
};

async function downloadOne(v, small) {
  S.abort = new AbortController();
  const q = new URLSearchParams({ id: v.id, kind: "mp4", q: "720p", named: "1" });
  const r = await fetch(`${S.server}/api/download?${q}`, { signal: S.abort.signal });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || "HTTP " + r.status); }
  const total = +r.headers.get("Content-Length") || 0;
  const name = decodeURIComponent(r.headers.get("X-Filename") || `${v.id}.mp4`);
  const fh = await S.dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    const reader = r.body.getReader(); let got = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      await w.write(value); got += value.length;
      if (total) small.textContent = Math.round((got * 100) / total) + " %";
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* ya cerrado */ }
    try { await S.dir.removeEntry(name); } catch { /* sin fichero */ }
    throw e;
  }
}

$("cmp-pause").onclick = () => { S.paused = true; $("cmp-pause").disabled = true; msg("Pausando… (se detiene el vídeo en curso)"); if (S.abort) S.abort.abort(); };

$("cmp-down").onclick = async () => {
  S.paused = false; let ok = 0, fail = 0;
  $("cmp-down").disabled = true; $("cmp-pause").hidden = false; $("cmp-pause").disabled = false;
  for (const v of [...S.missing]) {
    if (S.paused) break;
    const li = $("cv-" + v.id), small = li.querySelector("small");
    small.textContent = "descargando…";
    try {
      await downloadOne(v, small); ok++;
      S.missing = S.missing.filter((m) => m.id !== v.id); S.have++; li.remove(); counts();
    } catch (e) {
      if (S.paused || e.name === "AbortError") { small.textContent = "⏸ pausado"; break; }
      small.textContent = "✖ " + e.message; small.className = "bad"; fail++;
    }
    msg(`Descargados ${ok} · fallidos ${fail} · faltan ${S.missing.length}`);
  }
  $("cmp-pause").hidden = true; $("cmp-down").disabled = !S.missing.length;
  $("cmp-down").textContent = S.paused ? "▶ Reanudar descargas" : "⬇ Descargar los que faltan";
  try { await scan(); } catch { /* sin permiso */ }
  msg((S.paused ? "Pausado. " : "Terminado. ") + `Faltan ${S.missing.length} vídeos.`);
};
})();
