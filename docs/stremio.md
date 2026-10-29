# Investigación de Stremio e integración con Vela

Estado revisado el 29 de octubre de 2026. Vela es un cliente independiente para Windows con Tauri 2, Rust, React y TypeScript. Usa el protocolo de addons y consulta servicios externos compatibles. La implementación actual del protocolo es propia: no incorpora Stremio Core, Stremio Web, Stremio Video ni las shells oficiales.

La versión 0.2.0 rediseña la interfaz como aplicación de escritorio, integra el servidor de streaming de Stremio (torrents, proxy de cabeceras y conversión HLS) y añade la cuenta de Stremio con sincronización de biblioteca. Las secciones siguientes distinguen lo verificado contra servicios reales de lo que solo cubren pruebas unitarias.

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

La documentación actual también contempla `addon_catalog`, eventos `player`/`library` y capacidades adicionales. Vela todavía no implementa esos recursos, transportes IPFS/legacy, configuración de addons mediante formularios ni registro de enlaces `stremio://` en Windows. Aceptar un enlace pegado en el instalador de addons es una capacidad distinta de registrar el protocolo del sistema.

Una fuente puede ser un enlace directo, un identificador YouTube, una URL externa o un torrent con `infoHash`/`fileIdx`. También existen campos de trackers, cabeceras y otras clases de fuentes que Vela aún no soporta. El contrato local no debe confundirse con cobertura completa del protocolo. [Contrato de streams](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/stream.md).

Los subtítulos tienen identificador, idioma y URL. Vela descarga UTF-8 y convierte SRT básico a VTT; si la descarga o la decodificación falla, usa la conversión del servicio (`/subtitles.vtt?from=...`). El menú muestra el nombre del idioma (ISO 639-2, incluidos códigos bibliográficos como `fre` o `ger`) y la pista declara su código. No hay renderizado ASS/SSA. [Contrato de subtítulos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md).

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
- **Biblioteca**: [`planSync`](../src/lib/stremioApi.ts) compara para cada título el `_mtime` remoto con el último cambio local (añadido o progreso) y el registro de la última sincronización. Gana el más reciente. Las eliminaciones hechas en Vela se envían como `removed: true`; los elementos temporales de «Seguir viendo» se importan si tienen progreso. Al subir progreso se parte del objeto remoto y se conservan sus campos desconocidos (`watched`, `timesWatched`, `behaviorHints`…). Los identificadores propios de Vela (`vela:`) no se sincronizan.
- **Momento**: al iniciar sesión, al abrir Vela, al cerrar el reproductor y bajo demanda.
- **Addons**: se leen y pueden instalarse en Vela; `addonCollectionSet` no se usa, para no reescribir la colección de la cuenta.

No probado con una cuenta real: el flujo completo de inicio de sesión, `datastoreGet/Put` con datos reales y `addonCollectionGet`. Antes del primer uso conviene exportar la biblioteca local.

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

Para repetir la validación: abre Stremio (o `stremio-runtime.exe server.js` en su carpeta), genera el MKV con `ffmpeg -i tests/fixtures/playback.mp4 -c:v libx265 -tag:v hvc1 -c:a copy .tmp/media/hevc.mkv`, ejecuta `node dev/validation-addon.mjs` e instala `http://127.0.0.1:7010/manifest.json`.

Stremio Service, su runtime, FFmpeg y MPV no se incluyen en el instalador de Vela. Los tráileres MP4 de demostración funcionan sin ese servicio.

### Límites del reproductor

- **Integrado (WebView2)**: MP4/WebM con H.264, VP8/VP9 o AV1 y audio AAC, MP3, Opus, Vorbis o FLAC (AC-3/E-AC-3 solo si `canPlayType` lo indica). HLS mediante hls.js. HEVC se trata como no compatible porque depende del hardware y de extensiones, igual que en stremio-video. Una sola pista de audio; no hay selector de pistas ni ASS/SSA.
- **Conversión**: con el servicio disponible, Vela sondea torrents, fuentes `notWebReady` y las etiquetadas HEVC/MKV; si hay códecs o contenedor incompatibles, reproduce la conversión HLS (`maxAudioChannels=2`). Ante cualquier error de decodificación ofrece convertir o abrir un reproductor externo.
- **Cabeceras**: proxy del servicio para destinos HTTPS; MPV recibe `--http-header-fields-append` por cabecera y `--force-media-title`. Otros reproductores no reciben cabeceras y Vela lo rechaza.
- **Externo**: MPV no devuelve progreso a Vela (no hay IPC). MPV no estaba instalado en el equipo de validación.

## Arquitectura y estado de Vela

| Área                  | Código local                                                                                                                | Estado                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratos y protocolo | [contracts.ts](../src/lib/contracts.ts), [protocol.ts](../src/lib/protocol.ts)                                              | Implementados los recursos descritos arriba y agregación de proveedores.                                                                          |
| Transporte            | [transport.ts](../src/lib/transport.ts), [Rust HTTP](../src-tauri/src/transport.rs), [proxy de desarrollo](../dev/proxy.ts) | GET JSON/texto y POST JSON (sin seguir redirecciones) mediante Rust en escritorio. Vídeo y HLS se cargan directamente en WebView2.                |
| Servidor de streaming | [streamingServer.ts](../src/lib/streamingServer.ts), [playback.ts](../src/lib/playback.ts)                                  | Torrents, proxy de cabeceras, sondeo y conversión HLS, subtítulos.                                                                                |
| Cuenta                | [stremioApi.ts](../src/lib/stremioApi.ts), [account.ts](../src/lib/account.ts), [secrets.rs](../src-tauri/src/secrets.rs)    | Sesión, sincronización de biblioteca y progreso, addons de la cuenta.                                                                             |
| Persistencia          | [store.ts](../src/lib/store.ts)                                                                                             | `localStorage`, clave `vela.preferences.v1`; addons, ajustes, biblioteca y último progreso por título/videoId. `vela.account.v1` guarda el usuario y el registro de sincronización (no la clave). Preferencias de interfaz en `vela.ui.*`. |
| Navegación y fuentes  | [App.tsx](../src/App.tsx), [navigation.ts](../src/lib/navigation.ts), [DetailView.tsx](../src/components/DetailView.tsx)    | Historial, catálogos, paleta de búsqueda, biblioteca, episodios y panel de fuentes.                                                                |
| Addons y ajustes      | [AddonsView.tsx](../src/components/AddonsView.tsx), [SettingsView.tsx](../src/components/SettingsView.tsx)                  | Gestión local, prueba del servicio y ruta de reproductor externo.                                                                                 |
| Reproductor           | [Player.tsx](../src/components/Player.tsx)                                                                                  | HTML5 a ventana completa, HLS nativo/hls.js, VTT/SRT, atajos, conversión bajo demanda, progreso y reanudación.                                    |
| Escritorio            | [main.rs](../src-tauri/src/main.rs), [tauri.conf.json](../src-tauri/tauri.conf.json)                                        | Ventana sin marco, controles nativos, pantalla completa, estado de ventana, apertura externa, MPV con cabeceras e instalador NSIS.                 |

Los enlaces de configuración de addons pueden contener tokens en su ruta y actualmente se persisten con la configuración. Evitar volcarlos en logs o capturas de diagnóstico al trabajar en cuenta/sincronización.

## Verificación

Primera versión (0.1.0): 50 pruebas unitarias, 7 flujos Playwright, 4 pruebas Rust del transporte y 14 comprobaciones del proxy, más una comprobación manual del ejecutable con Cinemeta y un tráiler MP4.

Versión 0.2.0, 29 de octubre de 2026:

- 68 pruebas unitarias (protocolo, almacenamiento, servidor de streaming, API de cuenta y planificador de sincronización), 8 flujos Playwright (incluido el historial, el menú contextual por teclado y los atajos del reproductor) y 7 pruebas Rust (transporte GET/POST, argumentos de MPV y nombres de secretos). `cargo clippy -- -D warnings` y `cargo fmt --check` sin avisos.
- Ventana de desarrollo y ejecutable de release controlados por CDP de WebView2 (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…`). El ejecutable de release carga su interfaz desde `http://tauri.localhost` sin Vite; se comprobó Cinemeta por IPC Rust, búsqueda, tráiler MP4, torrent mediante el servidor de Stremio, conversión HLS de HEVC y el almacén de credenciales de Windows.
- Los casos del servidor de streaming y de la cuenta están en las secciones anteriores. Las pruebas Playwright usan proveedores controlados; las capturas y scripts de CDP quedan en `.tmp/`, ignorado por git.

## Orden de trabajo pendiente

1. Probar la cuenta con credenciales reales: vinculación, `datastoreGet/Put` y `addonCollectionGet`. Revisar conflictos con varios dispositivos y el marcado de vistos (`watched`), que Vela conserva pero no edita.
2. Validar la selección por temporada y episodio con un torrent de temporada completa con licencia libre.
3. Probar MPV instalado: cabeceras, título y cierre. Valorar IPC (`--input-ipc-server`) para recuperar el progreso o integrar libmpv.
4. Pistas de audio múltiples y subtítulos ASS (el servidor expone pistas incrustadas mediante `hlsv2`).
5. Siguiente episodio automático y marcado de vistos por episodio.
6. Firmar el instalador.

## Referencias complementarias y límites de la investigación inicial

La investigación inicial también señaló [enginefs](https://github.com/Stremio/enginefs), [rar-stream](https://github.com/Stremio/rar-stream), [rar-http](https://github.com/Stremio/rar-http), [mkv-ebml](https://github.com/Stremio/mkv-ebml) y [get-tracks-data](https://github.com/Stremio/get-tracks-data) como piezas relacionadas. No se han adoptado ni se ha demostrado que permitan reconstruir por completo el servidor actual.

La alternativa de terceros [stremio-server-go](https://pkg.go.dev/github.com/M0Rf30/stremio-server-go) es una pista para evaluar, no una dependencia elegida ni una sustitución validada. Los bindings [core-kotlin](https://github.com/Stremio/stremio-core-kotlin) y [core-swift](https://github.com/Stremio/stremio-core-swift), así como clientes móviles/TV, quedan fuera de la implementación Windows; no se infiere el estado de los clientes completos a partir de esos puentes.

Los porcentajes de lenguaje, recuentos de issues/commits, fechas de actividad y estados de archivo del resumen inicial no se utilizan como evidencia de arquitectura o mantenimiento. Las hipótesis sobre consumo de recursos necesitan mediciones de Vela y Stremio bajo las mismas condiciones; elegir Tauri o un servidor nativo no demuestra por sí solo una mejora cuantificada. Los enlaces upstream apuntan a ramas que pueden cambiar y deben revisarse al implementar cada integración.
