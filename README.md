# Vela

Cliente de escritorio independiente para Windows, construido con Tauri 2, Rust, React y TypeScript. Compatible con el protocolo HTTP/JSON de addons de Stremio. No es una aplicación oficial de Stremio.

La [investigación de Stremio y el estado de integración](docs/stremio.md) recoge los repositorios, licencias observadas, contratos de addons, API de cuenta, servidor de streaming, arquitectura de Vela, verificaciones realizadas y trabajo pendiente. Leerla antes de continuar las integraciones.

## Desarrollo

Requiere Node 22.12 o posterior, pnpm 11, Rust estable, las herramientas de compilación C++ de Microsoft y WebView2.

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

`pnpm desktop` abre la ventana Tauri con recarga automática. `pnpm dev` sirve solo la interfaz en `http://127.0.0.1:1430` para desarrollo; no es necesario para utilizar la aplicación empaquetada.

```powershell
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:e2e
cargo test --manifest-path src-tauri/Cargo.toml
pnpm package
```

El instalador se genera en `src-tauri/target/release/bundle/nsis/`.

### Versiones en GitHub

- **CI** ([ci.yml](.github/workflows/ci.yml)): en cada push a `main` y en cada pull request comprueba tipos, compila la interfaz y ejecuta las pruebas unitarias y Playwright (Ubuntu), y `cargo fmt`, `clippy` y las pruebas Rust (Windows).
- **Release** ([release.yml](.github/workflows/release.yml)): genera el instalador NSIS en Windows tras pasar las pruebas y lo publica en [Releases](https://github.com/roberthgnz/Vela/releases) con su suma SHA-256 y notas generadas a partir de los commits. Se lanza de dos formas:
  - subiendo una etiqueta igual a la versión: actualiza la versión en `package.json`, `src-tauri/Cargo.toml` y `src-tauri/tauri.conf.json`, haz commit y ejecuta `git tag v0.3.0` y `git push origin v0.3.0`;
  - o desde Actions › Release › Run workflow, que etiqueta el commit elegido como `v<versión>` (opcionalmente como borrador).

El flujo falla si las tres versiones no coinciden o si la etiqueta no corresponde a la versión. Si la versión ya está publicada, sustituye los archivos adjuntos. El instalador no está firmado. La aplicación empaquetada incluye su interfaz y no requiere Node ni el servidor Vite en el equipo del usuario. WebView2 es un requisito de ejecución.

`node dev/validation-addon.mjs` sirve en `http://127.0.0.1:7010/manifest.json` un addon local con fuentes de validación: torrents CC de Blender (con y sin `fileIdx`, con trackers, índice erróneo, hash sin pares), un MP4 que exige cabeceras, un MKV/HEVC, un MKV con dos pistas de audio y subtítulos SRT y ASS incrustados, subtítulos externos (Windows‑1252, ASS, duplicados y un archivo dañado) y una serie de tres episodios con `bingeGroup`. `node dev/make-validation-media.mjs` genera esos archivos sintéticos con FFmpeg en `.tmp/media/`. Su uso se describe en [docs/stremio.md](docs/stremio.md#validación-con-el-servicio-real).

## Interfaz

Ventana sin marco con barra de título propia (arrastre, doble clic para maximizar, controles de Windows), barra lateral plegable, historial atrás/adelante y paleta de búsqueda y comandos. El tamaño y la posición de la ventana se recuerdan.

- **Inicio**: «Seguir viendo» y estanterías de catálogos activos, sin cabecera promocional.
- **Películas y Series**: rejilla con catálogo, género y tamaño de carteles; carga continua.
- **Detalle**: página con información a la izquierda y panel lateral de episodios y fuentes. Los episodios muestran su progreso y si están vistos, y se marcan desde su menú contextual (uno, hasta aquí o la temporada). Las fuentes muestran calidad, tipo, banderas de idioma, tamaño, pares, proveedor, etiquetas (HEVC, HDR, MKV) y advertencias; se pueden filtrar por addon (distinguiendo copias configuradas del mismo addon) y por idioma.
- **Biblioteca**: filtros por tipo y «Seguir viendo», orden, filtro de texto y vista de cuadrícula o lista. Lo reproducido sin guardar aparece solo en «Seguir viendo», como en Stremio.
- **Reproductor**: ventana completa con controles que se ocultan, estados de carga y búfer, previsualización del tiempo, volumen, velocidad, panel de audio y subtítulos, desfase, siguiente episodio, reproductor externo y pantalla completa nativa.
- **Addons y Ajustes**: listas compactas, filtros y secciones con índice. Los ajustes se agrupan por tareas (Subtítulos, Audio, Reproducción, Reproductor externo, Streaming…) y solo muestran lo disponible.

Al volver atrás se recuperan el catálogo y sus filtros, la pestaña y el texto de la biblioteca, la temporada y el episodio elegidos, el scroll y el elemento que tenía el foco. Las animaciones y desplazamientos respetan «Reducir movimiento».

Teclado: `Ctrl K` o `/` buscar, `Ctrl 1–4` secciones, `Ctrl ,` ajustes, `Ctrl B` barra lateral, `Alt ←/→` historial, `Esc` volver, `Mayús F10` menú contextual y `F1` lista completa de atajos. En el reproductor: `Espacio/K`, `←/→` y `J/L` (saltos configurables), `↑/↓`, `M`, `F`, `C` subtítulos, `A` audio, `G/H` desfase, `N` siguiente episodio y `0–9`.

## Funciones

- Catálogos y búsqueda de Cinemeta y de los addons instalados; detalles, temporadas y episodios.
- Instalación, activación, desactivación y eliminación de addons por URL de manifiesto.
- Fuentes y subtítulos de los addons instalados; los manifiestos instalados se actualizan al abrir Vela.
- Subtítulos externos, de torrents e incrustados en el archivo (a través de Stremio Service): SRT, WebVTT y ASS/SSA, con detección de codificación (UTF‑8, UTF‑16, Windows‑1252) y de formato, duplicados eliminados y errores claros con archivos dañados. ASS/SSA con estilos mediante JASSUB (libass en WebAssembly). Idioma principal y secundario, selección automática, desfase, tamaño, opacidad y fondo.
- Pistas de audio múltiples en MP4, MKV y HLS, con idioma preferido y alternativo.
- Biblioteca e historial locales por episodio, marcas de vistos, reanudación por episodio, siguiente episodio con la fuente del mismo `bingeGroup` y cuenta atrás configurable. Exportación a JSON y vaciado con confirmación. El almacenamiento se migra de la versión 1 a la 2 conservando la copia original.
- Reproductor integrado para MP4/WebM/MKV y HLS. Si Stremio Service está disponible, los archivos incompatibles (por ejemplo HEVC) se sondean y se convierten a HLS; cualquier error de decodificación o una carga demasiado lenta ofrece la conversión o un reproductor externo.
- Torrents mediante el servidor de streaming de Stremio: creación del torrent, selección del archivo por el servicio (con temporada y episodio en series), trackers de `sources`, validación de que el archivo elegido es un vídeo y mensajes para servicio caído o torrent sin pares.
- Fuentes con cabeceras HTTP obligatorias: a través del proxy de Stremio Service cuando el destino es HTTPS, o con MPV, al que Vela pasa las cabeceras.
- MPV seguido por IPC: reanuda en la posición guardada, informa del progreso, detecta el cierre y el final, marca vistos y avanza al siguiente episodio.
- Cuenta de Stremio: vinculación desde el navegador (sin introducir la contraseña en Vela) o correo y contraseña. La clave de sesión se guarda en el Administrador de credenciales de Windows. Sincronización en ambos sentidos de biblioteca, elementos temporales de «Seguir viendo», progreso, siguiente episodio y vistos por episodio (el campo `watched` de Stremio), conservando los campos remotos que Vela no edita; lectura e instalación de los addons de la cuenta. Vela no envía actividad de reproducción a los addons.
- Dos tráileres de demostración para probar la reproducción sin un proveedor de películas.

## Límites actuales

Cinemeta proporciona metadatos, no películas reproducibles. Las fuentes dependen de los addons que instale el usuario. Stremio Service y MPV no se incluyen: Vela usa el servidor que instala Stremio o Stremio Service. No hay motor torrent propio ni libmpv integrado; la conversión de formatos depende de ese servidor.

La sincronización de la cuenta sigue los contratos de stremio-core y se ha comprobado contra la API real en los casos que no necesitan credenciales (vinculación, errores y sesión caducada), pero no con una cuenta real: el primer uso debería hacerse exportando antes la biblioteca. Vela no modifica la colección de addons de la cuenta. El ejecutable de MPV no estaba instalado en el equipo de desarrollo; el seguimiento por IPC se comprobó con la libmpv que incluye Stremio y con pruebas sobre una tubería con nombre.

El servidor de Stremio solo envía cabeceras CORS a orígenes de Stremio, así que Vela reproduce sus listas HLS con el reproductor nativo de WebView2 y lee sus subtítulos a través de Rust. Las pistas de audio dependen de la función `AudioVideoTracks` de WebView2, que Vela activa en la ventana. Los subtítulos ASS usan la fuente por defecto de JASSUB; no se cargan las fuentes adjuntas al MKV.

El proxy de cabeceras del servidor de Stremio solo acepta destinos HTTPS. Los enlaces directos y las listas HLS dependen de sus códecs, CORS y disponibilidad. Abrir un instalador generado localmente sin firma puede mostrar el aviso habitual de Windows.

## Créditos

Big Buck Bunny y Sintel son obras de Blender Foundation. Vela incluye ilustraciones propias y enlaces a sus tráileres, alojados por W3C; no incluye las películas completas. Los tráileres se distribuyen bajo [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Véanse [Big Buck Bunny](https://peach.blender.org/) y [Sintel](https://durian.blender.org/). El addon de validación usa los torrents de muestra de WebTorrent de esas mismas obras.

Los subtítulos ASS/SSA se dibujan con [JASSUB](https://github.com/ThaUnknown/jassub) 2.5.18 (código MIT; incluye libass y bibliotecas con licencias ISC, FTL/GPL-2.0, LGPL-2.1 y otras, declaradas en su paquete). Su worker y sus archivos WebAssembly se distribuyen como archivos separados.

Las banderas de idioma usan la fuente «Twemoji Country Flags» de [country-flag-emoji-polyfill](https://github.com/talkjs/country-flag-emoji-polyfill) (código MIT), incluida en `public/fonts/` porque Windows no dibuja emojis de banderas. Sus gráficos son de [Twemoji](https://github.com/twitter/twemoji), © Twitter, Inc. y otros colaboradores, bajo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

El cliente implementa el [protocolo de addons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). No incorpora código de las interfaces oficiales de Stremio. Las dependencias conservan sus propias licencias.
