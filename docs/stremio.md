# Investigación de Stremio e integración con Vela

Estado revisado el 29 de octubre de 2026. Vela es un cliente independiente para Windows con Tauri 2, Rust, React y TypeScript. Usa el protocolo de addons y consulta servicios externos compatibles. La implementación actual del protocolo es propia: no incorpora Stremio Core, Stremio Web, Stremio Video ni las shells oficiales.

La versión 0.2.0 rediseñó la interfaz como aplicación de escritorio, integró el servidor de streaming de Stremio (torrents, proxy de cabeceras y conversión HLS) y añadió la cuenta de Stremio con sincronización de biblioteca. La 0.3.0 completa el reproductor (pistas de audio, subtítulos incrustados y ASS, estados, siguiente episodio), sigue a MPV por IPC, añade historial y vistos por episodio compatibles con Stremio, migra el almacenamiento y conserva el estado de cada vista al navegar. Las secciones siguientes distinguen lo verificado contra servicios reales de lo que solo cubren pruebas unitarias o simuladas.

## Componentes oficiales

| Repositorio                                                                                | Función y tecnología                                                                                                         | Licencia observada                                                                                          |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [stremio-core](https://github.com/Stremio/stremio-core/blob/development/README.md)         | Motor compartido en Rust: modelos, addons, biblioteca, perfil y reproducción. Incluye integración WASM para la interfaz web. | [MIT](https://github.com/Stremio/stremio-core/blob/development/LICENSE.md).                                 |
| [stremio-web](https://github.com/Stremio/stremio-web/blob/development/package.json)        | Interfaz React con Webpack. Usa el core mediante WASM y delega reproducción en Stremio Video.                                | [GPL-2.0](https://github.com/Stremio/stremio-web/blob/development/LICENSE.md).                              |
| [stremio-video](https://github.com/Stremio/stremio-video/tree/master/src)                  | Abstracción JavaScript de reproductores y adaptadores para el servidor de streaming.                                         | [MIT declarada en package.json](https://github.com/Stremio/stremio-video/blob/master/package.json).         |
| [stremio-shell](https://github.com/Stremio/stremio-shell/blob/master/CMakeLists.txt)       | Shell de escritorio C++/QML con Qt, WebEngine/WebChannel y libmpv.                                                           | [Texto GPL-3.0](https://github.com/Stremio/stremio-shell/blob/master/LICENSE.md).                           |
| [stremio-shell-ng](https://github.com/Stremio/stremio-shell-ng/blob/main/Cargo.toml)       | Shell Windows en Rust con WebView2 y MPV.                                                                                    | No verificada: no se encontró declaración en el manifiesto ni archivo de licencia en la raíz inspeccionada. |
| [stremio-linux-shell](https://github.com/Stremio/stremio-linux-shell/blob/main/Cargo.toml) | Cliente Linux en Rust con GTK4, libadwaita, WebKitGTK y libmpv.                                                              | GPL-3.0-only en Cargo; [LICENSE](https://github.com/Stremio/stremio-linux-shell/blob/main/LICENSE).         |
| [stremio-service](https://github.com/Stremio/stremio-service/blob/master/src/server.rs)    | Aplicación/supervisor Rust que inicia el servidor con un runtime separado y configura FFmpeg/FFprobe.                        | [GPL-2.0 del repositorio](https://github.com/Stremio/stremio-service/blob/master/LICENSE.md).               |
| [stremio-addon-sdk](https://github.com/Stremio/stremio-addon-sdk/blob/master/README.md)    | SDK Node.js/JavaScript para crear y servir addons. Un cliente puede implementar el protocolo sin depender de este SDK.       | [MIT](https://github.com/Stremio/stremio-addon-sdk/blob/master/LICENSE.md).                                 |

Las licencias anteriores describen esos repositorios. No establecen automáticamente la licencia de binarios descargados, logotipos o recursos adicionales. Antes de incorporar código upstream hay que comprobar su licencia concreta; no se debe asumir compatibilidad automática entre GPL-2.0 y GPL-3.0. Vela mantiene por ahora su implementación independiente.

## Protocolo de addons

Un addon describe sus capacidades en un manifiesto y devuelve JSON para recursos concretos. El cliente agrega resultados de los addons compatibles. El transporte HTTP necesita CORS cuando lo consume directamente un navegador. Vela usa Rust para JSON/texto en escritorio y un proxy local durante desarrollo. [Protocolo oficial](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md).

| Ruta relativa al addon                      | Uso en Vela                                               |
| ------------------------------------------- | --------------------------------------------------------- |
| `/manifest.json`                            | Instalar y conocer capacidades.                           |
| `/catalog/{type}/{catalogId}.json`          | Explorar un catálogo.                                     |
| `/catalog/{type}/{catalogId}/{extras}.json` | Buscar, filtrar o paginar.                                |
| `/meta/{type}/{id}.json`                    | Obtener detalles y episodios.                             |
| `/stream/{type}/{videoId}.json`             | Obtener fuentes de una película o episodio.               |
| `/subtitles/{type}/{videoId}/{extras}.json` | Consulta que implementa actualmente Vela para subtítulos. |

El manifiesto declara `resources`, `types`, `idPrefixes`, `catalogs` y extras como `search`, `genre` y `skip`. Los recursos con notación de objeto pueden definir sus propios tipos/prefijos; omitir `idPrefixes` en un objeto no equivale a heredar el filtro global. Deben respetarse los extras obligatorios y codificarse sus valores sin romper búsquedas que contengan `&` o `+`. [Contrato de manifiesto](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/manifest.md).

Los catálogos muestran como filtros todos los extras con opciones (no solo `genre`); los extras obligatorios con opciones toman la primera hasta que se elige otra. La paginación con `skip` se detiene cuando una página no trae ningún título nuevo. Al abrir Vela se actualizan en segundo plano los manifiestos de los addons instalados por el usuario si la dirección sigue sirviendo el mismo `id` (conservando si están activados); los incluidos con Vela no se tocan.

La documentación actual también contempla `addon_catalog`, eventos `player`/`library` y capacidades adicionales. Stremio envía actividad de reproducción a los addons que la piden (`send_watched` en `models/player.rs`); Vela no lo hace. Vela todavía no implementa esos recursos, transportes IPFS/legacy, configuración de addons mediante formularios ni registro de enlaces `stremio://` en Windows. Aceptar un enlace pegado en el instalador de addons es una capacidad distinta de registrar el protocolo del sistema.

Una fuente puede ser un enlace directo, un identificador YouTube, una URL externa o un torrent con `infoHash`/`fileIdx`. Vela usa además `sources` (trackers), `behaviorHints.proxyHeaders`, `notWebReady`, `filename`/`videoHash`/`videoSize` (para pedir subtítulos) y `bingeGroup` (para elegir la fuente del siguiente episodio). Otras clases de fuentes siguen sin soporte; el contrato local no debe confundirse con cobertura completa del protocolo. [Contrato de streams](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md).

Los subtítulos tienen identificador, idioma y URL. Vela descarga los bytes, detecta codificación y formato, y analiza SRT, WebVTT y ASS/SSA por su cuenta (ver «Reproductor integrado»); la conversión del servicio (`/subtitles.vtt?from=...`) queda como respaldo. Los idiomas se normalizan a ISO 639-2/T (`es`, `spa`, `es-ES`, `Spanish` y el `spl` de OpenSubtitles son el mismo idioma; `pob` es portugués de Brasil). [Contrato de subtítulos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md).

## Servicios y datos de cuenta

Cinemeta proporciona metadatos y catálogos, no garantiza fuentes de reproducción. El core oficial identifica `https://v3-cinemeta.strem.io/manifest.json`, la API de cuenta `https://api.strem.io`, el servicio de vinculación `https://link.stremio.com` y el servidor local `http://127.0.0.1:11470`. [Constantes del core, rama development](https://github.com/Stremio/stremio-core/blob/development/src/constants.rs).

La API de cuenta es independiente del protocolo de addons. Hay contratos públicos del cliente aunque eso no signifique que se disponga del código del servidor. En `development`, las peticiones del core identifican estas operaciones:

| Grupo            | Rutas relevantes                                                     |
| ---------------- | -------------------------------------------------------------------- |
| Sesión           | `POST /api/login`, `/api/loginWithToken`, `/api/logout`.             |
| Usuario          | `POST /api/getUser`, `/api/saveUser`.                                |
| Addons de cuenta | `POST /api/addonCollectionGet`, `/api/addonCollectionSet`.           |
| Biblioteca       | `POST /api/datastoreMeta`, `/api/datastoreGet`, `/api/datastorePut`. |
| Vinculación      | `GET /api/v2/create` y `/api/v2/read` en el host de vinculación.     |

Estas rutas se han identificado leyendo código, no mediante una sesión autenticada de Vela. Para implementarlas hay que seguir la serialización real, no deducir los cuerpos únicamente de los nombres de las operaciones. [Peticiones](https://github.com/Stremio/stremio-core/blob/development/src/types/api/request.rs), [construcción de URLs y envío](https://github.com/Stremio/stremio-core/blob/development/src/types/api/fetch_api.rs).

Las respuestas distinguen `result` y `error`; la autenticación devuelve `authKey` y usuario. La biblioteca usa su propio modelo con `_id`, `_mtime`, eliminaciones y estado de reproducción. No se puede subir directamente el JSON de `LibraryEntry` de Vela. [Respuestas](https://github.com/Stremio/stremio-core/blob/development/src/types/api/response.rs), [LibraryItem](https://github.com/Stremio/stremio-core/blob/development/src/types/library/library_item.rs).

### Implementación en Vela

Comprobado en los tests de stremio-core (`unit_tests/ctx/authenticate.rs`, `sync_library_with_api.rs`), que fijan URL y cuerpos exactos:

| Operación | Petición | Respuesta |
| --- | --- | --- |
| Inicio de sesión | `POST /api/login` `{"type":"Auth","type":"Login","email","password","facebook":false}` | `{result:{authKey,user}}` |
| Usuario | `POST /api/getUser` `{"type":"GetUser","authKey"}` | `{result:User}` |
| Cierre | `POST /api/logout` `{"type":"Logout","authKey"}` | |
| Biblioteca | `POST /api/datastoreGet` `{"authKey","collection":"libraryItem","ids":[],"all":true}` | `{result:LibraryItem[]}` |
| Cambios | `POST /api/datastorePut` `{"authKey","collection":"libraryItem","changes":[…]}` | `{result:{success:true}}` |
| Addons | `POST /api/addonCollectionGet` `{"type":"AddonCollectionGet","authKey","update":true}` | `{result:{addons,lastModified}}` |
| Vinculación | `GET link.stremio.com/api/v2/create?type=Create`, `…/read?type=Read&code=` | `{result:{code,link,qrcode}}`, `{result:{authKey}}` |

El serializador de stremio-core emite `type` dos veces en el inicio de sesión; un objeto JSON solo puede contener uno, y Vela envía el último (`Login`), que es el que conserva un analizador JSON estándar. `LibraryItem.state` usa milisegundos (`timeOffset`, `duration`), `video_id` con guion bajo y `_mtime`/`_ctime` como fechas ISO.

Verificado contra los servicios reales sin credenciales: `create` devuelve código, enlace y URL de imagen QR; `read` pendiente responde `{error:{code:101,"Invalid or expired token"}}`; una clave inválida produce `{error:{code:1,"Session does not exist"}}`. En la aplicación de escritorio, una sesión inválida guardada se detecta al iniciar, se borra del almacén de credenciales y se informa.

- **Sesión**: vinculación por navegador (recomendada; la contraseña no pasa por Vela) o correo y contraseña. La clave se guarda con `keyring` en el Administrador de credenciales de Windows (servicio `com.vela.desktop`, nombre `stremio-auth-key`; los comandos solo aceptan ese nombre). Fuera del escritorio vive en memoria.
- **Biblioteca**: [`planSync`](../src/lib/stremioApi.ts) compara para cada título el `_mtime` remoto con el último cambio local (guardado, visto, progreso o puntero) y el registro de la última sincronización. Gana el más reciente. Al subir se parte del objeto remoto y se conservan sus campos desconocidos (`behaviorHints`, `timesWatched`, `noNotif`…). Los identificadores propios de Vela (`vela:`, `velatest:`) no se sincronizan.
- **Biblioteca y «Seguir viendo»**: como en Stremio, un título reproducido sin guardarlo es un elemento temporal (`removed: true, temp: true`); guardado es `removed: false, temp: false`. Antes de 0.3.0 todo lo reproducido se subía como guardado.
- **Puntero al siguiente episodio**: al terminar un episodio Vela guarda `time_offset: 1` y `video_id` del siguiente, como `advance_to_video` de stremio-core; al recibirlo, «Seguir viendo» muestra «Siguiente · T1 · E2».
- **Vistos**: `state.watched` es el bitfield de [stremio-watched-bitfield](https://github.com/Stremio/stremio-core/tree/development/stremio-watched-bitfield): `<id ancla>:<longitud>:<base64(zlib(bits))>`, con los vídeos ordenados por temporada, episodio y fecha (`LibraryItemState::watched_bitfield`). [watched.ts](../src/lib/watched.ts) lo decodifica y codifica con `CompressionStream("deflate")` y reproduce exactamente los vectores de prueba del crate. Al subir, si hubo marcas locales posteriores y se conoce la lista de episodios, Vela combina el campo remoto con ellas; si no puede decodificarlo o no conoce los episodios, lo deja intacto. Las películas usan `timesWatched`/`flaggedWatched`.
- **Eliminaciones**: quitar un título de la biblioteca conserva su historial local y se envía como `removed: true`. Si Stremio lo elimina, Vela lo saca de la biblioteca sin borrar sus marcas de vistos; solo borra la entrada si no tiene historial.
- **Momento**: al iniciar sesión, al abrir Vela, al cerrar el reproductor y bajo demanda.
- **Addons**: se leen y pueden instalarse en Vela; `addonCollectionSet` no se usa, para no reescribir la colección de la cuenta.

No probado con una cuenta real: el flujo completo de inicio de sesión, `datastoreGet/Put` con datos reales (incluido el bitfield `watched` generado por Vela) y `addonCollectionGet`. Las pruebas usan los cuerpos y vectores de stremio-core. Antes del primer uso conviene exportar la biblioteca local.

## Servidor de streaming y Stremio Service

Stremio Service es el supervisor. Su código busca `server.js`, un runtime, FFmpeg y FFprobe, e inicia el script como proceso separado. Esto aclara la distinción entre la aplicación Rust y el motor de streaming. [Implementación del supervisor](https://github.com/Stremio/stremio-service/blob/master/src/server.rs).

El repositorio Docker descarga un `server.js` preparado y lo ejecuta con Node; expone 11470 HTTP y 12470 HTTPS. Su licencia no demuestra por sí sola la licencia del script descargado. No se ha establecido aquí una licencia de redistribución para ese artefacto ni localizado su proyecto fuente completo. No debe presentarse como certeza que todo el servidor puede reconstruirse desde esos repositorios. [README de server-docker](https://github.com/Stremio/server-docker/blob/master/README.md), [Dockerfile](https://github.com/Stremio/server-docker/blob/master/Dockerfile).

Las rutas siguientes se reconocen en el cliente oficial; todavía necesitan pruebas de integración con la versión del servicio que se vaya a soportar:

- Con índice conocido y sin opciones adicionales, el cliente puede formar `/{infoHash}/{fileIdx}`.
- Para crear/preparar un torrent y adivinar el archivo, existe `POST /{infoHash}/create`, con `torrent.infoHash` y `guessFileIdx`; las series pueden aportar temporada/episodio. Los trackers requieren conservar las opciones de descubrimiento correspondientes. [createTorrent.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/createTorrent.js).
- El adaptador convierte fuentes y aplica proxy cuando se necesitan cabeceras. [convertStream.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/convertStream.js), [buildProxyUrl.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/buildProxyUrl.js).
- La inspección multimedia usa `/hlsv2/probe?mediaURL=...`; la transcodificación puede producir `/hlsv2/{id}/master.m3u8` con parámetros de formatos y canales. Vela todavía no usa este flujo. [withStreamingServer.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/withStreamingServer.js).

### Validación con el servicio real

Probado el 29 de octubre de 2026 con el servidor que instala Stremio (`stremio-runtime.exe server.js`, versión 4.22.3) en `http://127.0.0.1:11470`, desde la ventana Tauri y con [`dev/validation-addon.mjs`](../dev/validation-addon.mjs):

| Caso | Resultado |
| --- | --- |
| Sintel, `fileIdx: 5` | Reproduce. `create` con `guessFileIdx: false` devuelve los 11 archivos y Vela comprueba que el 5 es un vídeo. |
| Sintel sin `fileIdx` | `guessFileIdx: {}` devuelve `guessedFileIdx: 5` (`Sintel.mp4`, no los `.srt` ni `poster.jpg`). Reproduce. |
| Big Buck Bunny con `sources` | `peerSearch` con DHT y trackers; URL con `?tr=`. Reproduce tras ~24 s de búsqueda de pares. |
| `fileIdx: 0` (`Sintel.de.srt`) | Rechazado antes de reproducir: «El archivo seleccionado (Sintel.de.srt) no es un vídeo». |
| Hash sin pares | `create` no responde; a los 20 s Vela informa de que no hubo pares ni metadatos. |
| Servicio caído | «Las fuentes torrent necesitan Stremio Service y no responde…». |
| Índice inexistente | El servidor responde HTTP 500; Vela lo evita validando la lista de archivos. |
| MKV/HEVC con `notWebReady` | `/hlsv2/probe` detecta HEVC; Vela reproduce `/hlsv2/{id}/master.m3u8` mediante hls.js. |
| Cabeceras obligatorias | El proxy reenvía `h=` correctamente a destinos HTTPS (comprobado con un eco HTTPS), pero responde 500 con `Protocol "http:" not supported` para destinos HTTP. Vela lo explica y propone MPV. |

En series, Vela envía `season` y `episode` en `guessFileIdx`. Esto sigue el adaptador oficial, pero no se ha probado con un torrent de temporada completa con licencia libre. El servidor conserva en su caché (`%LOCALAPPDATA%\Stremio\stremio-cache`) los torrents reproducidos según su propia configuración de caché.

Para repetir la validación: abre Stremio (o `stremio-runtime.exe server.js` en su carpeta), genera los medios sintéticos con `node dev/make-validation-media.mjs` (necesita FFmpeg), ejecuta `node dev/validation-addon.mjs` e instala `http://127.0.0.1:7010/manifest.json`. Para controlar la ventana por CDP: `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333"` (en el ejecutable de release, con solo ese argumento, `audioTracks` seguía disponible: la función de Blink de `tauri.conf.json` se aplica igualmente) y, para no tocar los datos del usuario con el ejecutable de release, `WEBVIEW2_USER_DATA_FOLDER` apuntando a una carpeta de `.tmp/`.

Stremio Service, su runtime, FFmpeg y MPV no se incluyen en el instalador de Vela. Los tráileres MP4 de demostración funcionan sin ese servicio.

### Reproductor integrado (0.3.0)

Comprobado el 29 de octubre de 2026 en la ventana Tauri (WebView2 156) con el servidor que instala Stremio (4.22.3) y medios sintéticos generados por [`dev/make-validation-media.mjs`](../dev/make-validation-media.mjs) (patrones `testsrc2` y tonos de FFmpeg, sin contenido de terceros).

**Capacidades reales encontradas**

| Hecho | Consecuencia en Vela |
| --- | --- |
| WebView2 expone `video.audioTracks` solo con la función de Blink `AudioVideoTracks`. Con ella, activar una pista cambia de verdad el audio: medido con un `AnalyserNode`, la pista 0 del MKV/MP4 de prueba da 439 Hz (inglés) y la 1, 879 Hz (español). | `tauri.conf.json` añade `--enable-blink-features=AudioVideoTracks` a los argumentos de WebView2 (conservando los que Tauri pone por defecto). El panel «Audio y subtítulos» lista y cambia pistas de MP4, MKV y HLS. |
| WebView2 156 reproduce HLS de forma nativa (`canPlayType` devuelve `maybe`) y expone las renditions de audio, pero no las de subtítulos. | Para HLS se usa el reproductor nativo; hls.js queda para entornos sin HLS nativo. |
| El servidor solo envía cabeceras CORS a orígenes de Stremio (`*.strem.io`, `*.stremio.com`, `127.0.0.1:11470`…; ver el middleware de `server.js`). Desde `http://tauri.localhost` o `127.0.0.1:1430`, `fetch`/XHR a `/hlsv2` falla. | hls.js no puede leer las listas del servidor (por eso la ruta nativa). Todo lo que Vela lee del servidor (sondeo, subtítulos) pasa por el transporte Rust. |
| `/hlsv2/{id}/master.m3u8` declara una rendition de audio por pista (`LANGUAGE`, `NAME`) y una de subtítulos WebVTT por pista de texto. `/hlsv2/{id}/source/subtitle/{n}.ass` devuelve el script ASS original, pero solo para pistas ASS/SSA (para SRT responde vacío: FFmpeg copia a formato ASS). | Las pistas incrustadas se leen sin cambiar el vídeo: Vela pide `master.m3u8` (crea el conversor; solo inspecciona el archivo) y descarga el ASS original o los segmentos WebVTT. |
| Pedir varios segmentos de subtítulos a la vez provoca `Failed to read media segment: Segment is canceled`. | Los segmentos se piden de uno en uno, desde la posición actual hacia el final y luego hacia atrás, con un reintento. |
| WebView2 reproduce directamente MKV con H.264/AAC. | No se convierte un MKV compatible. |

**Funciones**

- **Estados**: cargando, almacenando en búfer (`waiting`), reproduciendo (solo tras `playing`, no al recibir `canplay`), en pausa, terminado y error. Una autorreproducción bloqueada queda en pausa. Si la carga o el búfer duran más de 15 s se ofrecen la conversión de Stremio Service y el reproductor externo.
- **Audio**: pistas del navegador (archivo directo o HLS); si no las hay y el servicio informa de varias pistas, elegir una cambia a la conversión. Idioma preferido y alternativo en Ajustes › Audio; la selección automática nunca fuerza una conversión.
- **Subtítulos**: externos del addon y del stream, archivos del torrent e incrustados del archivo. Bytes con detección de BOM, UTF‑16, UTF‑8 estricto y Windows‑1252; si fallan, conversión del servicio (`/subtitles.vtt?from=`). Formato detectado por contenido (SRT, WebVTT, ASS/SSA). SRT tolerante (sin índices, milisegundos con dos puntos, bloques rotos que se descartan). Las líneas iguales que se solapan se muestran una vez; las alineadas arriba (`\an8`, estilo con alineación 7–9, `line:0`) se dibujan arriba. Duplicados por URL eliminados.
- **ASS/SSA**: [JASSUB](https://github.com/ThaUnknown/jassub) 2.5.18 (libass en WebAssembly, worker y `.wasm` locales; la CSP incluye `'wasm-unsafe-eval'`). Renderiza estilos, posiciones y colores; si no puede iniciarse, se muestran como texto. Fuente por defecto de JASSUB; no se consultan fuentes del sistema (`queryFonts: false`) ni se cargan las fuentes adjuntas al MKV.
- **Menú**: el panel agrupa por idioma; elegir un idioma activa su primer subtítulo y aparece «Versión» si hay varios. Desfase de ±0,1 s (G/H, ±1 s con Mayús), también aplicado a JASSUB.
- **Estilo**: tamaño, opacidad del texto y fondo, persistentes y con vista previa en Ajustes.
- **Saltos** configurables (corto para flechas; largo para J/L y botones), usados en atajos, botones y textos de ayuda.
- **Siguiente episodio**: tarjeta en los últimos 30 s y al terminar, con cuenta atrás configurable (o sin ella). La fuente del siguiente episodio es la del mismo `behaviorHints.bingeGroup`; si no hay, la del mismo addon, nombre y tipo; si tampoco, se abre la lista de fuentes del episodio. Sigue la regla de `next_video` de stremio-core: no salta a especiales ni a episodios sin estrenar.
- **Vistos**: un vídeo se marca visto cuando el tiempo realmente reproducido supera el 70 % (`WATCHED_THRESHOLD_COEF`); al pasar del 90 % (`CREDITS_THRESHOLD_COEF`) o terminar, el título apunta al siguiente episodio o sale de «Seguir viendo».

### MPV mediante IPC

Con MPV y la aplicación de escritorio, Vela añade `--input-ipc-server=\\.\pipe\vela-mpv-<sesión>` y `--start=<posición>` (si hay progreso de 15 s o más). Un hilo de Rust ([mpv.rs](../src-tauri/src/mpv.rs)) se conecta a la tubería, observa `time-pos`, `duration`, `pause` y `eof-reached`, emite `player-progress` cada 2 s y `player-closed` al salir el proceso (con el último estado y si terminó por fin de archivo). La interfaz guarda el progreso, marca vistos (aquí con la posición, porque MPV no informa del tiempo visto) y avanza al siguiente episodio. Con otros reproductores solo se detecta el cierre. [Protocolo JSON IPC de MPV](https://mpv.io/manual/stable/#json-ipc).

`mpv.exe` no está instalado en el equipo de desarrollo. La prueba real se hizo con la **libmpv** que incluye Stremio (`libmpv-2.dll`, mpv v0.41.0-524) envuelta en un ejecutable `mpv.exe` mínimo que pasa las opciones de la línea de órdenes a libmpv (`.tmp/fake-mpv/`, fuera del repositorio), configurado como reproductor en Ajustes: Vela lanzó la sesión con IPC y `--start=20.2`, recibió el progreso, guardó 0:20 al cerrar con `quit` y, al llegar al final, retiró el título de «Seguir viendo» (no hay siguiente episodio estrenado). Queda sin verificar con el ejecutable oficial de MPV y con fuentes que exigen cabeceras.

### Límites del reproductor

- **Integrado (WebView2)**: MP4/WebM/MKV con H.264, VP8/VP9 o AV1 y audio AAC, MP3, Opus, Vorbis o FLAC (AC-3/E-AC-3 solo si `canPlayType` lo indica). HEVC se trata como no compatible porque depende del hardware y de extensiones, igual que en stremio-video.
- **Conversión**: con el servicio disponible, Vela sondea torrents, fuentes `notWebReady` y las etiquetadas HEVC/MKV; si hay códecs o contenedor incompatibles, reproduce la conversión HLS (`maxAudioChannels=2`). Para el resto de fuentes directas el sondeo se hace en segundo plano para descubrir pistas incrustadas. Ante cualquier error de decodificación ofrece convertir o abrir un reproductor externo.
- **Pistas en la conversión**: el cambio de audio entre renditions HLS nativas se ha comprobado solo a nivel de API (`audioTracks` enumera y cambia `enabled`); no se pudo medir el audio porque el servidor no envía CORS a Vela y el analizador recibe silencio.
- **Cabeceras**: proxy del servicio para destinos HTTPS; MPV recibe `--http-header-fields-append` por cabecera y `--force-media-title`. Otros reproductores no reciben cabeceras y Vela lo rechaza.
- **Sin IPC**: otros reproductores externos solo informan del cierre; no del progreso.

## Arquitectura y estado de Vela

| Área                  | Código local                                                                                                                | Estado                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratos y protocolo | [contracts.ts](../src/lib/contracts.ts), [protocol.ts](../src/lib/protocol.ts)                                              | Implementados los recursos descritos arriba y agregación de proveedores.                                                                          |
| Transporte            | [transport.ts](../src/lib/transport.ts), [Rust HTTP](../src-tauri/src/transport.rs), [proxy de desarrollo](../dev/proxy.ts) | GET JSON/texto y POST JSON (sin seguir redirecciones) mediante Rust en escritorio. Vídeo y HLS se cargan directamente en WebView2.                |
| Servidor de streaming | [streamingServer.ts](../src/lib/streamingServer.ts), [playback.ts](../src/lib/playback.ts)                                  | Torrents, proxy de cabeceras, sondeo y conversión HLS, subtítulos.                                                                                |
| Cuenta                | [stremioApi.ts](../src/lib/stremioApi.ts), [account.ts](../src/lib/account.ts), [secrets.rs](../src-tauri/src/secrets.rs)    | Sesión, sincronización de biblioteca y progreso, addons de la cuenta.                                                                             |
| Persistencia          | [store.ts](../src/lib/store.ts)                                                                                             | `localStorage`, clave `vela.preferences.v2` (ver «Almacenamiento»). `vela.account.v1` guarda el usuario y el registro de sincronización (no la clave). Preferencias de interfaz en `vela.ui.*`. |
| Navegación y fuentes  | [App.tsx](../src/App.tsx), [navigation.ts](../src/lib/navigation.ts), [DetailView.tsx](../src/components/DetailView.tsx)    | Historial con estado por entrada (catálogo y filtros, pestaña y texto de la biblioteca, temporada, episodio y panel), scroll y foco restaurados, episodios con vistos y progreso, panel de fuentes. |
| Episodios y vistos    | [episodes.ts](../src/lib/episodes.ts), [watched.ts](../src/lib/watched.ts), [externalPlayback.ts](../src/lib/externalPlayback.ts) | Orden, siguiente episodio, elección de fuente por `bingeGroup`, bitfield de Stremio y seguimiento de reproductores externos. |
| Subtítulos            | [subtitles.ts](../src/lib/subtitles.ts), [languages.ts](../src/lib/languages.ts)                                             | Codificaciones, formatos, cues, duplicados e idiomas.                                                                                              |
| Addons y ajustes      | [AddonsView.tsx](../src/components/AddonsView.tsx), [SettingsView.tsx](../src/components/SettingsView.tsx)                  | Gestión local, prueba del servicio y ruta de reproductor externo.                                                                                 |
| Reproductor           | [Player.tsx](../src/components/Player.tsx)                                                                                  | HTML5 a ventana completa, HLS nativo (hls.js de respaldo), pistas de audio, subtítulos externos e incrustados, ASS con JASSUB, desfase y estilo, estados, siguiente episodio, atajos, conversión bajo demanda, progreso y reanudación. |
| Escritorio            | [main.rs](../src-tauri/src/main.rs), [mpv.rs](../src-tauri/src/mpv.rs), [tauri.conf.json](../src-tauri/tauri.conf.json)     | Ventana sin marco, controles nativos, pantalla completa, estado de ventana, apertura externa, MPV con cabeceras e IPC, bytes sin decodificar para subtítulos e instalador NSIS. |

Los enlaces de configuración de addons pueden contener tokens en su ruta y actualmente se persisten con la configuración. Evitar volcarlos en logs o capturas de diagnóstico al trabajar en cuenta/sincronización.


## Almacenamiento y migración

La versión 2 se guarda en `vela.preferences.v2`. Al arrancar, si no existe, se lee `vela.preferences.v1` y se migra: todas sus entradas quedan como guardadas (`saved: true`), que es como se mostraban, y se añaden las preferencias de reproducción por defecto. La clave v1 no se modifica ni se borra, así que sirve de copia y una versión anterior de Vela sigue pudiendo leerla (sin los cambios posteriores). Cada entrada guarda ahora `saved`, el puntero de «Seguir viendo», el historial por vídeo (`videos`: posición, duración, fecha y marca de visto o no visto), `watchedAt` para películas y el bitfield remoto con su fecha. Los textos largos de los episodios no se guardan. Probado con los datos reales de la ventana de desarrollo (tres títulos, uno en «Seguir viendo»): se migraron sin pérdidas.

Preferencias de reproducción (`player`): idiomas principal y secundario de subtítulos, activación automática, tamaño, opacidad y fondo; idioma preferido y alternativo de audio; saltos corto y largo; siguiente episodio y su cuenta atrás. Los valores se validan y acotan al leerlos.

## Actualizaciones

Desde 0.3.2 se usa [tauri-plugin-updater](https://v2.tauri.app/plugin/updater/) 2.13.1 con comandos propios ([updater.rs](../src-tauri/src/updater.rs), [updates.ts](../src/lib/updates.ts)): `update_check` consulta `latest.json` de la última release de GitHub y `update_install` descarga, verifica la firma minisign con la clave pública de `tauri.conf.json`, ejecuta el instalador NSIS en modo pasivo y reinicia. La comprobación al arrancar solo ocurre en compilaciones de release y se puede desactivar. Ver «Actualización automática» en el README para la clave y el workflow.

## Auditoría de Stremio Tech Update #86

[Tech Update #86](https://blog.stremio.com/stremio-tech-update-86-stremio-update-for-macos-and-ios/) (22 de octubre de 2026) describe Stremio 2.1 para iOS, iPadOS, tvOS y macOS. No se ha copiado ningún parche: cada punto se comprobó en el código de Vela, se reprodujo cuando era posible y se cubrió con pruebas.

| Punto del artículo | Estado en Vela | Comprobación |
| --- | --- | --- |
| Subtítulos que se solapan | Existía: el overlay mostraba todas las cues activas, también repetidas. Corregido. | `activeCues` (unitaria). |
| Selección automática de pistas, incluidas las incrustadas | No existía. Implementada con idioma principal y secundario; incluye pistas incrustadas y no subtitula si el audio ya está en el idioma principal. | Ventana Tauri con MKV real; e2e. |
| Cambios de estilo que no se aplican | No existía configuración. Implementada con variables CSS aplicadas en vivo. | e2e de estilo y persistencia. |
| Detección de formato y archivos dañados | Existía: se decidía por extensión y un HTML se convertía en VTT vacío. Corregido: detección por contenido y error explícito. | Unitarias; e2e con `broken.srt`; ventana Tauri. |
| Subtítulos duplicados | Existía para el mismo archivo ofrecido por el stream y por un addon con otro código de idioma (`spa`/`es`). Corregido por URL. | Unitaria; e2e; ventana Tauri. |
| Elegir un idioma selecciona su primer subtítulo | No aplicaba (menú plano). Implementado en el panel. | e2e. |
| Emparejado de subtítulos con el archivo | Ya resuelto: se envían `videoHash`, `videoSize` y `filename`. | Unitaria existente. |
| El audio alternativo respeta el idioma secundario | No existía selección de audio. Implementada con preferido y alternativo. | Ventana Tauri (pista española activada). |
| Paginación con títulos repetidos | Ya resuelto en pantalla (se deduplicaba), pero se reprodujo un bucle: un addon que ignora `skip` hacía pedir páginas indefinidamente. Corregido. | `.tmp/repro-pagination.mjs` (50 peticiones sin títulos nuevos) y unitaria de `nextCatalogSkip`. |
| Filtros, estado de navegación y scroll al abrir otro catálogo | Existía: al volver se perdían catálogo y género, el scroll no volvía arriba al cambiar de catálogo y solo se mostraba el filtro de género. Corregido. | e2e de navegación. |
| Error cuando falla una página | Ya resuelto (error con reintento al final de la rejilla). | — |
| Reproductor que se declara listo antes de tiempo y transiciones de carga | Existía: `canplay` ponía «reproduciendo». Corregido con estados explícitos. | e2e y ventana Tauri. |
| Marcas de la línea de tiempo | La burbuja de tiempo podía salirse por los bordes. Corregido. | Visual. |
| Pantallas que quedan tras cerrar el reproductor | No reproducido: el diálogo y sus menús se desmontan al cerrar. | e2e existente. |
| Ventana de siguiente episodio en pantallas estrechas | Nueva función; diseño adaptado a ventanas estrechas. | Visual. |
| Reproductores externos con callbacks antiguos | Nueva función; cada sesión se elimina al recibir su cierre y los escuchas se registran una vez. | libmpv real. |
| Mensajes engañosos sin conexión y errores de sincronización | Existía: sin red se culpaba al addon, y los errores de protocolo y Rust estaban en inglés. Corregido (mensaje de conexión y textos en español). Los errores de sincronización ya se mostraban en la cuenta. | Unitarias actualizadas. |
| Inicio de sesión: cancelar la vinculación, foco, mostrar contraseña | Cancelar ya detenía el sondeo; el foco se perdía y no había botón para mostrar la contraseña. Corregido. | Revisión de código. |
| Abrir un episodio conserva la navegación de la serie; barras de progreso correctas | Existía: solo había progreso para el último episodio y al volver se perdían temporada y panel. Corregido con historial por episodio y estado en la ruta. | e2e. |
| Indicador de visto que tapa insignias | Nueva marca de visto, situada sin solapar el botón de guardar ni el progreso. | Visual. |
| Botones y elementos de menú desactivados que se activan | No reproducido: son botones `disabled`. | — |
| Tarjetas de addons que no se actualizan | Existía: el manifiesto quedaba congelado al instalar (el addon de validación no mostraba su nuevo recurso de subtítulos). Corregido con actualización por `id`. | Ventana Tauri; unitaria. |
| Varias copias configuradas del mismo addon en las fuentes | Existía: el filtro las mezclaba por nombre. Corregido (filtro por URL y numeración). | Revisión de código. |
| La biblioteca conserva su estado al cambiar de pestaña | Existía la pérdida de pestaña y filtro al volver. Corregido. | e2e de navegación. |
| Ajustes por tareas, opacidad en porcentaje, solo opciones disponibles | Ajustes reorganizados (Subtítulos, Audio, Reproducción, Reproductor externo solo en escritorio). | Ventana Tauri. |
| El salto configurado se usa en todas partes | Nueva preferencia usada en teclas, botones, títulos y tabla de atajos. | e2e. |
| Animaciones con «Reducir movimiento» | El CSS ya lo respetaba, pero los desplazamientos suaves por JavaScript no. Corregido. | Revisión de código. |
| Volver a pulsar la sección actual | Ahora vuelve al principio de la sección. | Revisión de código. |
| Aviso antes de instalar addons que reciben actividad | No aplica: Vela no envía actividad a addons. | — |
| Calendario y previsualizaciones en Descubrir | Fuera de esta fase. | — |
| Descargas, perfiles, plegables, VoiceOver, tvOS, spoilers | No aplica (Vela no tiene esas funciones o plataformas). | — |

## Verificación

Primera versión (0.1.0): 50 pruebas unitarias, 7 flujos Playwright, 4 pruebas Rust del transporte y 14 comprobaciones del proxy, más una comprobación manual del ejecutable con Cinemeta y un tráiler MP4.

Versión 0.2.0, 29 de octubre de 2026:

- 68 pruebas unitarias (protocolo, almacenamiento, servidor de streaming, API de cuenta y planificador de sincronización), 8 flujos Playwright (incluido el historial, el menú contextual por teclado y los atajos del reproductor) y 7 pruebas Rust (transporte GET/POST, argumentos de MPV y nombres de secretos). `cargo clippy -- -D warnings` y `cargo fmt --check` sin avisos.
- Ventana de desarrollo y ejecutable de release controlados por CDP de WebView2 (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`). El ejecutable de release carga su interfaz desde `http://tauri.localhost` sin Vite; se comprobó Cinemeta por IPC Rust, búsqueda, tráiler MP4, torrent mediante el servidor de Stremio, conversión HLS de HEVC y el almacén de credenciales de Windows.
- Los casos del servidor de streaming y de la cuenta están en las secciones anteriores. Las pruebas Playwright usan proveedores controlados; las capturas y scripts de CDP quedan en `.tmp/`, ignorado por git.

Versión 0.3.0, 29 de octubre de 2026:

- 99 pruebas unitarias (nuevas: subtítulos e idiomas, bitfield con los vectores de stremio-core, episodios, migración v1→v2, historial, sincronización de temporales, puntero y vistos, paginación, actualización de manifiestos), 13 flujos Playwright (nuevos: panel de subtítulos con Windows‑1252, duplicados, archivo dañado y desfase; estilo y selección automática; siguiente episodio por `bingeGroup` y «Seguir viendo»; restauración de catálogo, foco y temporada; marcar vistos desde el menú contextual) y 11 pruebas Rust (nuevas: estado de MPV, argumentos IPC y seguimiento de una tubería con nombre real). `cargo clippy -- -D warnings` y `cargo fmt` sin avisos.
- En la ventana Tauri, por CDP, con Stremio 4.22.3 y el addon de validación: MKV con dos audios y tres subtítulos (cambio de audio medido por frecuencia, SRT incrustado español, ASS incrustado con estilos por JASSUB, SRT externo Windows‑1252, ASS externo, archivo dañado), desfase, preferencias automáticas, HEVC convertido a HLS nativo, serie de tres episodios con cuenta atrás, cambio por `bingeGroup`, vistos y «Seguir viendo», y libmpv real por IPC.
- Prueba simulada no es validación real: los flujos Playwright usaban addons, subtítulos y vídeo controlados en Chromium; la cuenta de Stremio sigue sin probarse con datos reales.
- Después de la 0.3.0 se retiraron las pruebas de interfaz con Playwright por su duración. Quedan las pruebas unitarias (Vitest) y Rust; la interfaz se comprueba a mano en la ventana Tauri (por CDP, con los scripts de `.tmp/`). El vídeo de prueba pasó de `tests/fixtures/` a `dev/media/playback.mp4`, que usa el addon de validación.

## Orden de trabajo pendiente

1. Probar la cuenta con credenciales reales: vinculación, `datastoreGet/Put` con temporales, puntero y el bitfield `watched` que genera Vela, `addonCollectionGet`, y conflictos con varios dispositivos.
2. Probar el ejecutable oficial de MPV (no solo libmpv): IPC, `--start`, cabeceras y título.
3. Medir el cambio de audio en renditions HLS de la conversión (requiere un origen al que el servidor envíe CORS o leer el audio de otra forma).
4. Cargar en JASSUB las fuentes adjuntas al MKV (`/hlsv2/{id}/source/attachment/{n}`) y, si procede, fuentes del sistema sin pedir permisos.
5. Validar la selección por temporada y episodio con un torrent de temporada completa con licencia libre.
6. Calendario y previsualizaciones de catálogo (fase posterior).
7. Firmar el instalador.

## Referencias complementarias y límites de la investigación inicial

La investigación inicial también señaló [enginefs](https://github.com/Stremio/enginefs), [rar-stream](https://github.com/Stremio/rar-stream), [rar-http](https://github.com/Stremio/rar-http), [mkv-ebml](https://github.com/Stremio/mkv-ebml) y [get-tracks-data](https://github.com/Stremio/get-tracks-data) como piezas relacionadas. No se han adoptado ni se ha demostrado que permitan reconstruir por completo el servidor actual.

La alternativa de terceros [stremio-server-go](https://pkg.go.dev/github.com/M0Rf30/stremio-server-go) es una pista para evaluar, no una dependencia elegida ni una sustitución validada. Los bindings [core-kotlin](https://github.com/Stremio/stremio-core-kotlin) y [core-swift](https://github.com/Stremio/stremio-core-swift), así como clientes móviles/TV, quedan fuera de la implementación Windows; no se infiere el estado de los clientes completos a partir de esos puentes.

Los porcentajes de lenguaje, recuentos de issues/commits, fechas de actividad y estados de archivo del resumen inicial no se utilizan como evidencia de arquitectura o mantenimiento. Las hipótesis sobre consumo de recursos necesitan mediciones de Vela y Stremio bajo las mismas condiciones; elegir Tauri o un servidor nativo no demuestra por sí solo una mejora cuantificada. Los enlaces upstream apuntan a ramas que pueden cambiar y deben revisarse al implementar cada integración.
