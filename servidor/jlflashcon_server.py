#!/usr/bin/env python3
"""jlflashcon - servidor de descargas y busqueda para la version web.

La web (GitHub Pages) no puede descargar de YouTube por si sola: este servidor usa yt-dlp + ffmpeg en TU
ordenador (o en un servidor tuyo) y la web le pide las busquedas, las listas y las descargas.

    pip install yt-dlp          (y ffmpeg en el PATH, o en una carpeta ffmpeg/bin junto a este archivo)
    python jlflashcon_server.py                  # solo este ordenador: http://localhost:8765
    python jlflashcon_server.py --host 0.0.0.0   # tambien desde el movil/otros equipos de tu red

Por seguridad solo acepta peticiones de la web de jlflashcon y de localhost (ver --allow-origin).
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    sys.exit("Falta yt-dlp:  pip install yt-dlp")

HERE = Path(__file__).resolve().parent
for cand in (HERE / "ffmpeg" / "bin", HERE.parent.parent / "ejecucion" / "ffmpeg" / "bin"):
    if cand.is_dir():
        os.environ["PATH"] = str(cand) + os.pathsep + os.environ.get("PATH", "")

ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PL_RE = re.compile(r"^(PL|UU|OL|FL|LL|RD)[A-Za-z0-9_-]{10,}$")
PL_PREFIXES = ("PL", "UU", "OL", "FL", "LL", "RD")
MAX_RESULTS = 50
DEFAULT_ORIGINS = {"https://nandorro.github.io"}
ALLOWED = set(DEFAULT_ORIGINS)

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
FRIENDLY = [
    ("country", "vídeo no disponible en tu país"),
    ("private video", "vídeo privado"),
    ("confirm your age", "vídeo con restricción de edad (YouTube pide iniciar sesión)"),
    ("not a bot", "YouTube pide verificar que no eres un robot (inténtalo más tarde)"),
    ("429", "demasiadas peticiones a YouTube: espera unos minutos"),
    ("unavailable", "vídeo no disponible (borrado, privado o bloqueado)"),
    ("copyright", "vídeo bloqueado por derechos de autor"),
]


def clean_error(msg) -> str:
    text = ANSI_RE.sub("", str(msg))
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    errs = [ln for ln in lines if "ERROR:" in ln] or lines
    m = errs[-1] if errs else ""
    m = re.sub(r"^.*?ERROR:\s*", "", m)
    m = re.sub(r"^\[[\w:]+\]\s*[\w-]{11}:\s*", "", m)
    low = m.lower()
    for key, text in FRIENDLY:
        if key in low:
            return text
    return m[:200]


def norm(text: str) -> str:
    t = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in t if not unicodedata.combining(c)).casefold()


# ---------------------------------------------------------------- busqueda (misma logica que la app de escritorio)

def flat_opts():
    return {"extract_flat": "in_playlist", "quiet": True, "no_warnings": True, "skip_download": True,
            "playlistend": 100}


def find_channels(ydl, author):
    a = author.strip()
    if a.startswith("@") and " " not in a:
        return [(f"https://www.youtube.com/{a}", a)]
    info = ydl.extract_info(f"https://www.youtube.com/results?search_query={quote(a)}&sp=EgIQAg%3D%3D",
                            download=False)
    want = norm(a).lstrip("@").replace(" ", "")
    cands = []
    for e in info.get("entries") or []:
        if not e:
            continue
        cid = e.get("id") or ""
        name = e.get("title") or e.get("channel") or e.get("uploader") or ""
        curl = e.get("url") or e.get("channel_url") or (f"https://www.youtube.com/channel/{cid}" if cid else "")
        if curl:
            cands.append((norm(name).replace(" ", ""), norm(e.get("uploader_id") or "").lstrip("@"), curl, name))
    ranked = [(c[2], c[3]) for c in cands if want in (c[0], c[1])]
    ranked += [(c[2], c[3]) for c in cands if want and want in c[0]]
    ranked += [(c[2], c[3]) for c in cands]
    seen, out = set(), []
    for curl, name in ranked:
        if curl not in seen:
            seen.add(curl)
            out.append((curl, name))
    return out[:3]


def collect(kind, entries, chan_name, chan_url, words, who="", urls=None):
    out = []
    for e in entries or []:
        if not e:
            continue
        vid, title = e.get("id") or "", e.get("title") or e.get("id") or ""
        if title.startswith(("[Private", "[Deleted", "[Unavailable")):
            continue
        if kind == "video" and not ID_RE.match(vid):
            continue
        if kind == "playlist" and not vid.startswith(PL_PREFIXES):
            continue
        author = chan_name or e.get("channel") or e.get("uploader") or ""
        curl = chan_url or e.get("channel_url") or e.get("uploader_url") or ""
        if who and who not in norm(author) and who not in norm(e.get("uploader_id") or ""):
            continue
        if words and not all(w in norm(title) for w in words):
            continue
        if author and curl and urls is not None:
            urls.setdefault(author, curl)
        out.append({"id": vid, "title": title, "author": author, "authorUrl": curl})
    return out


def search(kind, title, author, channel_url=""):
    title, author = title.strip(), author.strip()
    words = norm(title).split()
    out, urls = [], {}
    with yt_dlp.YoutubeDL(flat_opts()) as ydl:
        if author:
            try:
                channels = [(channel_url, author)] if channel_url else find_channels(ydl, author)
            except Exception:  # noqa: BLE001
                channels = []
            seen = set()
            for curl, cname in channels:
                if len(out) >= MAX_RESULTS:
                    break
                try:
                    if kind == "video":
                        url = f"{curl}/search?query={quote(title)}" if title else f"{curl}/videos"
                    else:
                        url = f"{curl}/playlists"
                    info = ydl.extract_info(url, download=False)
                    for r in collect(kind, info.get("entries"), cname, curl, words if kind == "playlist" else [],
                                     urls=urls):
                        if r["id"] not in seen:
                            seen.add(r["id"])
                            out.append(r)
                except Exception:  # noqa: BLE001
                    continue
            if not out:  # plan B: busqueda general filtrada por autor
                q = f"{title} {author}".strip()
                url = (f"ytsearch50:{q}" if kind == "video"
                       else f"https://www.youtube.com/results?search_query={quote(q)}&sp=EgIQAw%3D%3D")
                info = ydl.extract_info(url, download=False)
                out = collect(kind, info.get("entries"), "", "", words, who=norm(author).lstrip("@"), urls=urls)
        else:
            url = (f"ytsearch{MAX_RESULTS}:{title}" if kind == "video"
                   else f"https://www.youtube.com/results?search_query={quote(title)}&sp=EgIQAw%3D%3D")
            info = ydl.extract_info(url, download=False)
            out = collect(kind, info.get("entries"), "", "", [], urls=urls)
    return out[:MAX_RESULTS]


def playlist(pid):
    with yt_dlp.YoutubeDL(flat_opts() | {"playlistend": 500}) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/playlist?list={pid}", download=False)
    default = info.get("channel") or info.get("uploader") or ""
    default_url = info.get("channel_url") or info.get("uploader_url") or ""
    entries = []
    for e in info.get("entries") or []:
        vid = (e or {}).get("id", "")
        title = e.get("title") or vid if e else ""
        if ID_RE.match(vid) and not title.startswith(("[Private", "[Deleted", "[Unavailable")):
            entries.append({"id": vid, "title": title,
                            "author": e.get("channel") or e.get("uploader") or default,
                            "authorUrl": e.get("channel_url") or e.get("uploader_url") or default_url})
    return {"title": info.get("title") or "lista", "entries": entries}


# ---------------------------------------------------------------- descarga

def download(vid, kind, quality, folder):
    opts = {"outtmpl": str(Path(folder) / "%(title).100s.%(ext)s"), "noplaylist": True, "quiet": True,
            "no_warnings": True, "windowsfilenames": True}
    if kind == "mp3":
        opts["format"] = "bestaudio/best"
        opts["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": "mp3", "preferredquality": "192"}]
    else:
        h = re.sub(r"\D", "", quality) or "1080"
        opts["format"] = (f"bestvideo[height<={h}][ext=mp4]+bestaudio[ext=m4a]/"
                          f"bestvideo[height<={h}]+bestaudio/best[height<={h}]/best")
        opts["merge_output_format"] = "mp4"
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([f"https://www.youtube.com/watch?v={vid}"])
    files = [f for f in Path(folder).iterdir() if f.suffix.lower() == f".{kind}"]
    if not files:
        raise RuntimeError(f"No se generó el archivo .{kind}")
    return files[0]


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "jlflashcon"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def origin_ok(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True  # navegacion directa / curl
        host = urlparse(origin).hostname or ""
        return origin in ALLOWED or host in ("localhost", "127.0.0.1", "[::1]", "::1")

    def cors(self):
        origin = self.headers.get("Origin")
        if origin and self.origin_ok():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-Filename")

    def json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self.origin_ok():
            return self.json(403, {"error": "origen no permitido"})
        self.send_response(204)
        self.cors()
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self):
        if not self.origin_ok():
            return self.json(403, {"error": "origen no permitido (usa --allow-origin)"})
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/ping":
                return self.json(200, {"ok": True, "app": "jlflashcon", "yt_dlp": yt_dlp.version.__version__})
            if u.path == "/api/search":
                kind = "playlist" if q.get("kind") == "playlist" else "video"
                if not (q.get("title", "").strip() or q.get("author", "").strip()):
                    return self.json(400, {"error": "Escribe el título, el autor, o los dos"})
                return self.json(200, {"results": search(kind, q.get("title", ""), q.get("author", ""),
                                                         q.get("channel", ""))})
            if u.path == "/api/playlist":
                pid = q.get("id", "")
                if not PL_RE.match(pid):
                    return self.json(400, {"error": "Identificador de lista no válido"})
                return self.json(200, playlist(pid))
            if u.path == "/api/download":
                return self.do_download(q)
            return self.json(404, {"error": "no existe"})
        except Exception as e:  # noqa: BLE001
            return self.json(500, {"error": clean_error(e)})

    def do_download(self, q):
        vid, kind = q.get("id", ""), q.get("kind", "mp4")
        if not ID_RE.match(vid) or kind not in ("mp3", "mp4"):
            return self.json(400, {"error": "petición no válida"})
        tmp = tempfile.mkdtemp(prefix="jlflash_")
        try:
            f = download(vid, kind, q.get("q", "1080p"), tmp)
            size = f.stat().st_size
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "audio/mpeg" if kind == "mp3" else "video/mp4")
            self.send_header("Content-Length", str(size))
            self.send_header("X-Filename", quote(f.name))
            self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(f.name)}")
            self.end_headers()
            with open(f, "rb") as fh:
                shutil.copyfileobj(fh, self.wfile, 1024 * 256)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:  # noqa: BLE001
            self.json(500, {"error": clean_error(e)})
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Servidor de descargas de jlflashcon web")
    ap.add_argument("--host", default="127.0.0.1", help="127.0.0.1 (solo este equipo) o 0.0.0.0 (toda la red)")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--allow-origin", action="append", default=[],
                    help="origen web adicional permitido, p. ej. https://miusuario.github.io")
    a = ap.parse_args()
    ALLOWED.update(a.allow_origin)
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"jlflashcon servidor en http://{a.host}:{a.port}  (yt-dlp {yt_dlp.version.__version__})")
    print("Orígenes permitidos:", ", ".join(sorted(ALLOWED)), "+ localhost")
    print("Ctrl+C para parar.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nParado.")


if __name__ == "__main__":
    main()
