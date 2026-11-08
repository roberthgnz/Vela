# Plataformas: Windows, macOS y Linux

Vela se publica para tres sistemas desde el mismo código. Windows es la plataforma de referencia: allí se valida a mano cada versión (ver [validation.md](validation.md)). Las versiones de macOS y Linux se compilan, se prueban (`cargo test`, `pnpm test`) y se empaquetan en CI, pero todavía no tienen la misma validación manual; lo que sigue describe sus diferencias conocidas.

## Paquetes

| Sistema | Archivo de la release | Actualización automática | Requisitos |
| --- | --- | --- | --- |
| Windows 10/11 x64 | `Vela_<versión>_x64-setup.exe` (NSIS, por usuario) | el instalador en modo pasivo | WebView2 |
| macOS 11 o posterior (Apple Silicon e Intel) | `Vela_<versión>_universal.dmg` | `Vela_<versión>_universal.app.tar.gz` sustituye la app | — |
| Linux x86_64 | `Vela_<versión>_amd64.AppImage` | la propia AppImage se sustituye | glibc de Ubuntu 22.04 o posterior |
| Debian/Ubuntu x86_64 | `Vela_<versión>_amd64.deb` | se instala con permisos de administrador (si el `.deb` va firmado) | WebKitGTK 4.1 y GStreamer (dependencias del paquete) |

Cada archivo lleva su `.sha256`; los paquetes de actualización llevan además su firma `.sig` y `latest.json` los enumera todos (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`), generado por [dev/updater-manifest.mjs](../dev/updater-manifest.mjs) en el workflow de release.

No hay paquetes para Linux ARM ni Windows ARM.

**macOS**: la app tiene firma ad hoc, sin certificado de Apple ni notarización. Al abrirla por primera vez desde el `.dmg`, Gatekeeper la bloquea: clic derecho › Abrir, o Ajustes del Sistema › Privacidad y seguridad › «Abrir igualmente». Si macOS dice que está dañada, `xattr -dr com.apple.quarantine /Applications/Vela.app` quita la marca de descarga. Las actualizaciones internas no pasan por ese aviso.

**Linux**: la AppImage incluye GStreamer y sus plugins (`bundleMediaFramework`), por eso pesa más; el `.deb` depende de los plugins `base`, `good`, `bad` y `libav` del sistema. El icono de bandeja usa AppIndicator: en GNOME hace falta la extensión AppIndicator para verlo.

## Motor web y códecs

El reproductor integrado es el `<video>` del motor web de cada sistema, y cada uno decodifica cosas distintas. Las comprobaciones de la interfaz (`canPlayType`, el sondeo de contenedores, la lista de contenedores no soportados) se ajustaron con WebView2; en los otros motores pueden aceptar algo que luego falla con el aviso de «no se puede decodificar», o al revés.

| | Windows (WebView2, Chromium) | macOS (WKWebView, Safari) | Linux (WebKitGTK, GStreamer) |
| --- | --- | --- | --- |
| MP4/MOV con H.264 y AAC | sí | sí | sí, con `gst-libav` |
| HEVC | según hardware y la extensión HEVC de Windows | sí (decodificación por hardware) | con `gst-libav`; por hardware solo con VA-API |
| MKV/WebM | WebM y MKV sencillos | WebM parcial; **MKV no** | sí (`matroskademux` de plugins-good) |
| AC-3 / E-AC-3 | no | sí | con `gst-libav` |
| DTS / TrueHD | no | no | con `gst-libav` |
| HLS | nativo | nativo | hls.js (MSE) |
| Pistas de audio del archivo (`audioTracks`) | con la opción `AudioVideoTracks` | sí | depende de la versión de WebKitGTK |

Lo que el motor no reproduce se resuelve igual que en Windows sin mpv integrado: conversión de Stremio Service si está abierto, o un reproductor externo (Ajustes › Reproductor externo).

El ajuste «Decodificación por hardware» solo tiene efecto en Windows: es una opción de Chromium (`--disable-accelerated-video-decode`). Las opciones de `additionalBrowserArgs` de `tauri.conf.json` también son solo de WebView2.

## Funciones que solo están en Windows

- **mpv integrado** y **libmpv descargable**: mpv dibuja en una ventana nativa hija de la ventana de Vela (Win32) y la build fijada en [libmpv.json](../src-tauri/libmpv.json) es una DLL de Windows. En macOS y Linux `mpv_embedded_library` no devuelve ninguna y Ajustes no ofrece la descarga; queda el reproductor externo. Llevarlo a macOS (`NSView` sobre WKWebView) o a Linux (X11 `wid`; Wayland no permite incrustar) exige otro código de ventana.
- **Enlaces `vela://` y `stremio://`**: se registran en `HKCU\Software\Classes`. En macOS harían falta `CFBundleURLTypes` en el `Info.plist` y recibir los eventos de Apple (plugin deep-link); en Linux, un `MimeType` en el `.desktop`. Hasta entonces los addons se instalan pegando la URL del `manifest.json`.
- **Arrancar el servidor de Stremio**: Vela busca `stremio-runtime.exe` en `%LOCALAPPDATA%`. En macOS y Linux hay que abrir Stremio o Stremio Service antes, o usar el motor de torrents de Vela, que no depende de él.

## Funciones con otro comportamiento

- **Reproductor externo**: además del `PATH`, Vela busca mpv y VLC en `/opt/homebrew/bin`, `/usr/local/bin` y `/Applications/*.app` (macOS) o `/usr/bin`, `/usr/local/bin` y `/snap/bin` (Linux): las apps abiertas desde Finder o un lanzador reciben un `PATH` corto. En Ajustes se puede elegir `mpv.app` o `VLC.app` directamente. El seguimiento de mpv por IPC usa un socket Unix en `$XDG_RUNTIME_DIR` (o `/tmp`) en lugar de una tubería con nombre.
- **Sesión de Stremio y clave de TMDB**: llavero de macOS, o Secret Service en Linux (GNOME Keyring, KWallet). Sin un servicio de secretos activo, Vela no puede guardar la sesión y hay que volver a vincular la cuenta al reiniciar. Los textos de la interfaz todavía nombran el Administrador de credenciales de Windows.
- **Mostrar en la carpeta**: Explorador y Finder seleccionan el archivo; en Linux `xdg-open` abre la carpeta que lo contiene.
- **Ventana**: la barra de título es la de Vela en los tres sistemas (`decorations: false`), así que en macOS no aparecen los botones de semáforo. Con «cerrar a la bandeja», en macOS el clic en el Dock vuelve a mostrar la ventana.

## Carpetas de datos

Las rutas salen de Tauri con el identificador `com.vela.desktop`:

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Base de datos, copias y registros (`app_data_dir`) | `%APPDATA%\com.vela.desktop` | `~/Library/Application Support/com.vela.desktop` | `~/.local/share/com.vela.desktop` |
| Ajustes del motor web (`app_config_dir`) | `%APPDATA%\com.vela.desktop` | `~/Library/Application Support/com.vela.desktop` | `~/.config/com.vela.desktop` |
| Caché de torrents (`app_cache_dir`) | `%LOCALAPPDATA%\com.vela.desktop` | `~/Library/Caches/com.vela.desktop` | `~/.cache/com.vela.desktop` |
| Descargas | `Descargas\Vela` | `~/Downloads/Vela` | `$XDG_DOWNLOAD_DIR/Vela` |

## Compilar en macOS y Linux

Además de Node, pnpm y Rust, Linux necesita las bibliotecas de desarrollo de Tauri y del almacén de secretos:

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev libdbus-1-dev patchelf
```

y, para la AppImage, los plugins de GStreamer que se copian dentro (`gstreamer1.0-plugins-{base,good,bad}` y `gstreamer1.0-libav`). macOS necesita las Command Line Tools de Xcode y, para la app universal, `rustup target add aarch64-apple-darwin x86_64-apple-darwin`.

```bash
pnpm package:macos   # .app y .dmg universales en src-tauri/target/universal-apple-darwin/release/bundle/
pnpm package:linux   # .AppImage y .deb en src-tauri/target/release/bundle/
```

Igual que `pnpm package`, firman el paquete de actualización y necesitan `TAURI_SIGNING_PRIVATE_KEY`. Sin la clave: `pnpm tauri build --bundles appimage,deb --config '{"bundle":{"createUpdaterArtifacts":false}}'` (en macOS, `--target universal-apple-darwin --bundles app,dmg`).
