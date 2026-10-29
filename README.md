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

El instalador se genera en `src-tauri/target/release/bundle/nsis/`. La aplicación empaquetada incluye su interfaz y no requiere Node ni el servidor Vite en el equipo del usuario. WebView2 es un requisito de ejecución.

`node dev/validation-addon.mjs` sirve en `http://127.0.0.1:7010/manifest.json` un addon local con fuentes de validación: torrents CC de Blender (con y sin `fileIdx`, con trackers, índice erróneo, hash sin pares), un MP4 que exige cabeceras y un MKV/HEVC. Su uso se describe en [docs/stremio.md](docs/stremio.md#validación-con-el-servicio-real).

## Interfaz

Ventana sin marco con barra de título propia (arrastre, doble clic para maximizar, controles de Windows), barra lateral plegable, historial atrás/adelante y paleta de búsqueda y comandos. El tamaño y la posición de la ventana se recuerdan.

- **Inicio**: «Seguir viendo» y estanterías de catálogos activos, sin cabecera promocional.
- **Películas y Series**: rejilla con catálogo, género y tamaño de carteles; carga continua.
- **Detalle**: página con información a la izquierda y panel lateral de episodios y fuentes. Las fuentes muestran calidad, tipo, tamaño, etiquetas (HEVC, HDR, MKV) y advertencias; se pueden filtrar por addon.
- **Biblioteca**: filtros por tipo y «Seguir viendo», orden, filtro de texto y vista de cuadrícula o lista.
- **Reproductor**: ventana completa con controles que se ocultan, búfer, previsualización del tiempo, volumen, velocidad, subtítulos por idioma, reproductor externo y pantalla completa nativa.
- **Addons y Ajustes**: listas compactas, filtros y secciones con índice.

Teclado: `Ctrl K` o `/` buscar, `Ctrl 1–4` secciones, `Ctrl ,` ajustes, `Ctrl B` barra lateral, `Alt ←/→` historial, `Esc` volver, `Mayús F10` menú contextual y `F1` lista completa de atajos. En el reproductor: `Espacio/K`, `←/→`, `J/L`, `↑/↓`, `M`, `F`, `C` y `0–9`.

## Funciones

- Catálogos y búsqueda de Cinemeta y de los addons instalados; detalles, temporadas y episodios.
- Instalación, activación, desactivación y eliminación de addons por URL de manifiesto.
- Fuentes y subtítulos de los addons instalados. Subtítulos con nombre de idioma; los SRT en codificaciones distintas de UTF-8 se convierten a través de Stremio Service si está disponible.
- Biblioteca y progreso locales, exportación a JSON y vaciado con confirmación.
- Reproductor integrado para MP4/WebM y HLS. Si Stremio Service está disponible, los archivos incompatibles (por ejemplo HEVC o MKV) se sondean y se convierten a HLS; cualquier error de decodificación ofrece la conversión o un reproductor externo.
- Torrents mediante el servidor de streaming de Stremio: creación del torrent, selección del archivo por el servicio (con temporada y episodio en series), trackers de `sources`, validación de que el archivo elegido es un vídeo y mensajes para servicio caído o torrent sin pares.
- Fuentes con cabeceras HTTP obligatorias: a través del proxy de Stremio Service cuando el destino es HTTPS, o con MPV, al que Vela pasa las cabeceras.
- Cuenta de Stremio: vinculación desde el navegador (sin introducir la contraseña en Vela) o correo y contraseña. La clave de sesión se guarda en el Administrador de credenciales de Windows. Sincronización en ambos sentidos de biblioteca y progreso, y lectura e instalación de los addons de la cuenta.
- Dos tráileres de demostración para probar la reproducción sin un proveedor de películas.

## Límites actuales

Cinemeta proporciona metadatos, no películas reproducibles. Las fuentes dependen de los addons que instale el usuario. Stremio Service y MPV no se incluyen: Vela usa el servidor que instala Stremio o Stremio Service. No hay motor torrent propio ni libmpv integrado; la conversión de formatos depende de ese servidor.

La sincronización de la cuenta sigue los contratos de stremio-core y se ha comprobado contra la API real en los casos que no necesitan credenciales (vinculación, errores y sesión caducada), pero no con una cuenta real: el primer uso debería hacerse exportando antes la biblioteca. Vela no modifica la colección de addons de la cuenta. MPV no estaba instalado en el equipo de desarrollo, por lo que el lanzamiento externo solo está cubierto por pruebas unitarias.

El proxy de cabeceras del servidor de Stremio solo acepta destinos HTTPS. Los enlaces directos y las listas HLS dependen de sus códecs, CORS y disponibilidad. Abrir un instalador generado localmente sin firma puede mostrar el aviso habitual de Windows.

## Créditos

Big Buck Bunny y Sintel son obras de Blender Foundation. Vela incluye ilustraciones propias y enlaces a sus tráileres, alojados por W3C; no incluye las películas completas. Los tráileres se distribuyen bajo [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Véanse [Big Buck Bunny](https://peach.blender.org/) y [Sintel](https://durian.blender.org/). El addon de validación usa los torrents de muestra de WebTorrent de esas mismas obras.

El cliente implementa el [protocolo de addons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). No incorpora código de las interfaces oficiales de Stremio. Las dependencias conservan sus propias licencias.
