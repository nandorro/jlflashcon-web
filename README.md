# jlflashcon web

Visor de YouTube **sin anuncios** con listas, buscadores y descarga **MP4 / MP3**, como web app (se puede instalar
como app desde el navegador: PWA). Es la versión web de jlflashcon v3.

🌐 **Web:** https://nandorro.github.io/jlflashcon-web/

## Qué hace
- Ver un vídeo por URL o ID en el reproductor `youtube-nocookie.com/embed/ID` (el mismo destino del truco `yout-ube.com`), sin anuncios de la web de YouTube. Pantalla completa incluida.
- Barra de **lista de reproducción**: todos los vídeos con autor y **▶ Ver · ⬇ MP3 · ⬇ MP4**; **Toda la lista en MP3 / MP4**.
- **Buscadores** de vídeos y de listas (título, autor o los dos), hasta 50 resultados. El autor es un enlace: en vídeos muestra todos sus vídeos; en listas, todas sus listas.
- ✕ en cada barra, historial al pulsar **espacio**, botón derecho / pulsación larga para copiar nombre o autor, **🗗 Nueva ventana** para descargar a la vez y aviso al cerrar con una descarga en curso.
- Enlaces directos: `?v=ID` abre un vídeo y `?list=ID` una lista.

## Descargas y búsquedas fiables: el servidor
Una web no puede ejecutar yt-dlp ni ffmpeg. Por eso la descarga (y las búsquedas completas) usan un pequeño servidor tuyo:

```
pip install yt-dlp          # y ffmpeg en el PATH (o carpeta servidor/ffmpeg/bin)
python servidor/jlflashcon_server.py                 # http://localhost:8765, solo este equipo
python servidor/jlflashcon_server.py --host 0.0.0.0  # también desde otros equipos de tu red
```

La web busca el servidor en `http://localhost:8765` y muestra **🟢 Servidor conectado** arriba. Si está en otra
dirección: ⚙ → escribe la URL. El servidor solo acepta peticiones de esta web (`https://nandorro.github.io`) y de
`localhost`; para otro dominio usa `--allow-origin https://tu-dominio`.

**Sin servidor** (⚪ modo básico): se pueden ver vídeos y abrir directamente `?v=`; las búsquedas y listas
intentan usar servicios públicos tipo Piped, que van y vienen, así que pueden fallar. Las descargas no funcionan.

Limitaciones: desde la web `https://` solo se puede hablar con un servidor en `localhost` o con `https`; un
`http://192.168…` lo bloquea el navegador por "contenido mixto". En iPhone/Safari no se puede usar el `localhost`
de otro equipo: habría que poner el servidor detrás de HTTPS. Los vídeos con la inserción bloqueada por su autor no
se ven en el reproductor (sí se pueden descargar).

> Descargar de YouTube va contra sus condiciones de uso: úsalo solo con contenido que puedas guardar legalmente.

## Archivos
| Archivo | Para qué |
|---|---|
| `index.html`, `style.css`, `app.js` | La web |
| `manifest.webmanifest`, `sw.js`, `icons/` | Instalación como app (PWA) |
| `servidor/jlflashcon_server.py` | Servidor de descargas y búsqueda (yt-dlp) |

## Publicación
GitHub Pages sirve la rama `main` desde la raíz. Cada `git push` actualiza la web.
