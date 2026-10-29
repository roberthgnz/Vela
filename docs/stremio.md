# Investigación de Stremio e integración con Vela

Estado revisado el 29 de octubre de 2026. Vela es un cliente independiente para Windows con Tauri 2, Rust, React y TypeScript. Usa el protocolo de addons y consulta servicios externos compatibles. La implementación actual del protocolo es propia: no incorpora Stremio Core, Stremio Web, Stremio Video ni las shells oficiales.

La prioridad acordada para la siguiente sesión es rediseñar la UI/UX para que se sienta como una aplicación de escritorio. La interfaz actual es provisional. Después quedan la integración completa con Stremio Service y la cuenta/sincronización.

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

Los subtítulos tienen identificador, idioma y URL. El servicio oficial puede convertir codificaciones mediante `subtitles.vtt?from=...`; Vela descarga UTF-8 y convierte SRT básico a VTT por su cuenta. No hay renderizado ASS/SSA ni detección de codificación. La vista actual fija `srcLang="es"`, pendiente de corregir y verificar con idiomas reales. [Contrato de subtítulos](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api/responses/subtitles.md).

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

Implementación pendiente: transporte autenticado con POST, almacenamiento seguro de credenciales en el sistema operativo, cierre de sesión, traducción entre modelos y resolución de conflictos entre biblioteca local/remota. El transporte Rust actual solo expone GET de JSON/texto. No existe todavía conexión de cuenta ni sincronización de addons, biblioteca o progreso.

## Servidor de streaming y Stremio Service

Stremio Service es el supervisor. Su código busca `server.js`, un runtime, FFmpeg y FFprobe, e inicia el script como proceso separado. Esto aclara la distinción entre la aplicación Rust y el motor de streaming. [Implementación del supervisor](https://github.com/Stremio/stremio-service/blob/master/src/server.rs).

El repositorio Docker descarga un `server.js` preparado y lo ejecuta con Node; expone 11470 HTTP y 12470 HTTPS. Su licencia no demuestra por sí sola la licencia del script descargado. No se ha establecido aquí una licencia de redistribución para ese artefacto ni localizado su proyecto fuente completo. No debe presentarse como certeza que todo el servidor puede reconstruirse desde esos repositorios. [README de server-docker](https://github.com/Stremio/server-docker/blob/master/README.md), [Dockerfile](https://github.com/Stremio/server-docker/blob/master/Dockerfile).

Las rutas siguientes se reconocen en el cliente oficial; todavía necesitan pruebas de integración con la versión del servicio que se vaya a soportar:

- Con índice conocido y sin opciones adicionales, el cliente puede formar `/{infoHash}/{fileIdx}`.
- Para crear/preparar un torrent y adivinar el archivo, existe `POST /{infoHash}/create`, con `torrent.infoHash` y `guessFileIdx`; las series pueden aportar temporada/episodio. Los trackers requieren conservar las opciones de descubrimiento correspondientes. [createTorrent.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/createTorrent.js).
- El adaptador convierte fuentes y aplica proxy cuando se necesitan cabeceras. [convertStream.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/convertStream.js), [buildProxyUrl.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/buildProxyUrl.js).
- La inspección multimedia usa `/hlsv2/probe?mediaURL=...`; la transcodificación puede producir `/hlsv2/{id}/master.m3u8` con parámetros de formatos y canales. Vela todavía no usa este flujo. [withStreamingServer.js](https://github.com/Stremio/stremio-video/blob/master/src/withStreamingServer/withStreamingServer.js).

Vela únicamente comprueba `GET /settings` y forma la URL de reproducción. Envía `-1` para películas sin índice y exige un índice explícito en series. La elección del archivo se delega al servicio: Vela no enumera archivos ni calcula cuál es el mayor. Tampoco conserva todavía `sources`/trackers en su contrato local. No se ha probado una descarga torrent real en esta primera versión.

Stremio Service, su runtime, FFmpeg y MPV no se incluyen en el instalador de Vela. Los tráileres MP4 de demostración funcionan sin ese servicio. Lanzar MPV externo no aporta control ni progreso de vuelta a Vela, porque todavía no hay IPC con el reproductor.

## Arquitectura y estado de Vela

| Área                  | Código local                                                                                                                | Estado                                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contratos y protocolo | [contracts.ts](../src/lib/contracts.ts), [protocol.ts](../src/lib/protocol.ts)                                              | Implementados los recursos descritos arriba y agregación de proveedores.                                                                          |
| Transporte            | [transport.ts](../src/lib/transport.ts), [Rust HTTP](../src-tauri/src/transport.rs), [proxy de desarrollo](../dev/proxy.ts) | JSON/texto mediante Rust en escritorio. Vídeo y HLS se cargan directamente en WebView2.                                                           |
| Persistencia          | [store.ts](../src/lib/store.ts)                                                                                             | `localStorage`, clave `vela.preferences.v1`; addons, ajustes, biblioteca y último progreso por título/videoId. Exportación JSON; sin importación. |
| Navegación y fuentes  | [App.tsx](../src/App.tsx), [MediaDetails.tsx](../src/components/MediaDetails.tsx)                                           | Catálogos, búsqueda, biblioteca, episodios y selección de fuentes.                                                                                |
| Addons y ajustes      | [AddonsView.tsx](../src/components/AddonsView.tsx), [SettingsView.tsx](../src/components/SettingsView.tsx)                  | Gestión local, prueba del servicio y ruta de reproductor externo.                                                                                 |
| Reproductor           | [Player.tsx](../src/components/Player.tsx)                                                                                  | HTML5, rama HLS nativa/hls.js, VTT/SRT básico, controles y progreso. Las cabeceras de solicitud obligatorias producen un error explícito.         |
| Escritorio            | [main.rs](../src-tauri/src/main.rs), [tauri.conf.json](../src-tauri/tauri.conf.json)                                        | Ventana Tauri, controles nativos, apertura externa e instalador NSIS.                                                                             |

Los enlaces de configuración de addons pueden contener tokens en su ruta y actualmente se persisten con la configuración. Evitar volcarlos en logs o capturas de diagnóstico al trabajar en cuenta/sincronización.

## Verificación de la primera versión

La sesión de construcción terminó con 50 pruebas unitarias del protocolo/almacenamiento, 7 flujos Playwright, 4 pruebas Rust del transporte y 14 comprobaciones del proxy. Las pruebas Playwright usan proveedores controlados y un MP4 generado: no validan la disponibilidad de todos los addons externos.

También se comprobó el ejecutable final con su interfaz incluida, desde `http://tauri.localhost`: IPC Rust con una petición HTTPS real a Cinemeta, búsqueda/Escape, maximizar/restaurar, reproducción de un tráiler MP4 real y persistencia de progreso. Esto no sustituye pruebas multimedia de HLS, subtítulos, MPV o torrents, que siguen pendientes.

Los comandos y requisitos están en el [README](../README.md). Las pruebas reproducibles están en [protocol.test.ts](../src/lib/protocol.test.ts), [store.test.ts](../src/lib/store.test.ts), [app.spec.ts](../tests/app.spec.ts) y el módulo de transporte Rust. Las comprobaciones auxiliares de la sesión y sus capturas quedaron en directorios ignorados; no constituyen una suite nativa completa mantenida en el repositorio.

## Orden de trabajo pendiente

1. Rediseñar UI/UX dentro de la ventana Tauri: navegación, densidad, tipografía, herramientas, catálogos, detalles, fuentes, reproductor y ajustes. El usuario rechazó el aspecto de web/landing page; evitar grandes bloques promocionales y espacio desperdiciado. Mantener teclado, foco y accesibilidad.
2. Probar HLS y subtítulos con contenido real; revisar idioma de pistas, conversión y códecs. Cubrir errores, formatos que necesitan reproductor externo y las cabeceras de proxy.
3. Validar Stremio Service con un torrent de prueba autorizado: conexión, selección correcta de archivo/episodio, búsqueda temporal, errores y cierre. Implementar creación/selección y trackers según el contrato verificado antes de prometer compatibilidad completa.
4. Implementar cuenta y sincronización siguiendo los contratos oficiales: autenticación, addons, biblioteca, progreso y conflictos. Mantener utilizable el modo local.
5. Volver a generar y comprobar el ejecutable/instalador tras los cambios. Mantener una ventana Tauri disponible durante desarrollo para revisar el resultado real.

## Referencias complementarias y límites de la investigación inicial

La investigación inicial también señaló [enginefs](https://github.com/Stremio/enginefs), [rar-stream](https://github.com/Stremio/rar-stream), [rar-http](https://github.com/Stremio/rar-http), [mkv-ebml](https://github.com/Stremio/mkv-ebml) y [get-tracks-data](https://github.com/Stremio/get-tracks-data) como piezas relacionadas. No se han adoptado ni se ha demostrado que permitan reconstruir por completo el servidor actual.

La alternativa de terceros [stremio-server-go](https://pkg.go.dev/github.com/M0Rf30/stremio-server-go) es una pista para evaluar, no una dependencia elegida ni una sustitución validada. Los bindings [core-kotlin](https://github.com/Stremio/stremio-core-kotlin) y [core-swift](https://github.com/Stremio/stremio-core-swift), así como clientes móviles/TV, quedan fuera de la implementación Windows; no se infiere el estado de los clientes completos a partir de esos puentes.

Los porcentajes de lenguaje, recuentos de issues/commits, fechas de actividad y estados de archivo del resumen inicial no se utilizan como evidencia de arquitectura o mantenimiento. Las hipótesis sobre consumo de recursos necesitan mediciones de Vela y Stremio bajo las mismas condiciones; elegir Tauri o un servidor nativo no demuestra por sí solo una mejora cuantificada. Los enlaces upstream apuntan a ramas que pueden cambiar y deben revisarse al implementar cada integración.
