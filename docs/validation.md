# Matriz de validación del primer sprint

Estado: 5 de noviembre de 2026. Esta matriz convierte los límites de
[la integración de Stremio](stremio.md) en comprobaciones repetibles. Una prueba
de transporte o un componente con colaboradores simulados no acredita que el
vídeo se vea y se oiga en la aplicación empaquetada.

## Evidencia obtenida en este sprint

- Windows, sin iniciar Vela ni Stremio Service y sin usar cuentas reales:
  **101 pruebas correctas en 14 archivos** de reproducción, reproductores,
  progreso, episodios, subtítulos y sondeo. Incluían siete archivos multimedia
  locales comparados con FFprobe.
- Se ejecutó `node dev/make-validation-media.mjs` con FFmpeg y, después, se
  repitió `mediaProbe.files.test.ts`: **12 pruebas correctas, ninguna omitida**.
  La comparación cubre H.264, HEVC, MKV multipista, MP4 con dos audios, tres
  episodios, AVI, DTS, TrueHD, MP4 con índice al final y WebM/VP9. Comprueba
  contenedor, pistas, idiomas, canales, duración y límites de lectura; no
  comprueba la decodificación audiovisual.
- No se ejecutaron en esa comprobación focal enjambres públicos, una sesión real de
  cuenta, una ventana Tauri ni un instalador. Sus casos siguen pendientes.

Las pruebas Rust indicadas abajo ya existen; la disponibilidad de una prueba
no se anota como una ejecución nueva. El informe final de cada cambio debe
registrar los comandos Rust ejecutados y sus resultados.

### Validación del cambio de restauración y cuenta

- `pnpm test`: **375 pruebas correctas en 50 archivos**, sin omitidas.
  Incluye 14 pruebas del store de cuenta con planificador real y transporte y
  credenciales simulados, 17 de almacenamiento frontend y 8 del flujo de
  recuperación en Ajustes. Se cubren respuestas tardías, cambio de cuenta/perfil,
  caducidad, escrituras de credenciales y progreso/eliminaciones durante una subida.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml`: **69 correctas y
  3 ignoradas**. De ellas, 14 son de almacenamiento: recuperación de perfiles y
  progreso, respaldo previo, validación de archivos y rollback. Dos casos de
  enlaces simbólicos no ejercitaron esa rama porque Windows denegó su creación
  (error 1314); no se atribuye cobertura efectiva a esos casos.
- `pnpm build`, `cargo fmt --check --manifest-path src-tauri/Cargo.toml` y
  `cargo clippy --locked --manifest-path src-tauri/Cargo.toml -- -D warnings`:
  correctos. La compilación avisa de chunks superiores a 500 kB.
- El helper de automatización nativa y la herramienta integrada fallaron al
  inicializar con `failed to write kernel assets: The system cannot find the path
  specified. (os error 3)`. No se abrió la aplicación ni se probaron sus controles
  en una ventana real durante este cambio.
- `streams_a_complete_season_from_one_torrent` se repitió con los MP4 reales
  generados por FFmpeg: se recibieron íntegros los tres episodios (2.431.953,
  2.435.031 y 2.436.244 bytes) reutilizando la sesión. No acredita visionado en UI.
- `large_piece_loopback_benchmark` pasó las tres ejecuciones de 64 MiB con piezas
  de 4 MiB. El primer byte llegó en 55/93/96 ms; los bytes entregados y descargados
  coincidieron en cada pasada. Es tráfico TCP local, sin demostrar rendimiento
  con esas piezas en Internet.
- `streaming_benchmark` pasó con Sintel de Blender Foundation, hash
  `08ada5a7a6183aae1e09d831df6748d566095a10`, archivo 5, caché inicial nueva y
  fases de 60 segundos. Selección de metadatos en 536 ms; piezas de 128 KiB;
  primer byte en 2,0 s y unos 129 MB entregados en orden antes de terminar la
  primera fase, con el final del archivo disponible. El salto al 50 % obtuvo el
  primer byte en 1,4 ms **desde el archivo ya descargado**, sin tráfico nuevo:
  no acredita saltos con piezas aún ausentes. Es evidencia de transporte para
  esa muestra y esa red, no de visionado, piezas grandes o peers lentos.

### Segundo bloque: importación y diagnóstico de addons

- `pnpm test`: **418 pruebas correctas en 55 archivos**, sin omitidas.
  El nuevo bloque añade 18 casos de parser y combinación de bibliotecas,
  9 del flujo de importación en Ajustes, 14 de salud de addons y 2 de creación
  de copias con escrituras pendientes. No se han repetido benchmarks externos.
- `pnpm build` y `git diff --check`: correctos. La advertencia de tamaño de
  chunks sigue presente; no impide compilar.
- La importación admite el formato de exportación v1 de Vela, hasta 20 MiB:
  valida el archivo completo antes de aplicar cambios, mantiene el perfil
  seleccionado y vuelve a combinar con los datos actuales al confirmar.
  Los timestamps del archivo conservan su fecha original. En caso de empate
  gana el dato local; progreso y vistos se comparan por episodio. El archivo
  no instala addons ni restaura credenciales, perfiles o preferencias.
- En escritorio se crea una copia previa. Un error al guardar los datos
  pendientes o crear esa copia impide importar. Si falla la escritura posterior
  a la combinación, se informa de que los datos quedan en la sesión y se
  reintentará guardar. La importación desde un perfil infantil protegido pide
  el PIN del perfil principal. En el navegador de desarrollo no hay copia
  SQLite automática y el diálogo lo indica.
- El diagnóstico de addons conserva solo estado y fecha en memoria de sesión,
  limita la petición a 15 segundos y permite reintentar. Las respuestas tardías
  no reinstalan un addon eliminado ni sobrescriben una reinstalación; tampoco
  cambian su activación. Los errores no muestran ni guardan URL, tokens o
  mensajes del servidor. No se han hecho llamadas externas en estas pruebas.
- Se corrigió la habilitación de exportación/vaciado para perfiles que solo
  tienen historial, y el recuento del diálogo de vaciado incluye todo lo que se
  borra. Crear una copia ya no anuncia éxito si quedan cambios sin guardar.
- Se reintentó la automatización nativa tras reiniciarla: sigue fallando con el
  mismo error de inicialización. Continúan pendientes la ventana real y la
  cuenta real; no se modificaron datos de una instalación personal.

## Casos y criterios de aceptación

`P0` bloquea la salida del sprint si falla. `P1` debe quedar verificado o
documentado como límite antes de ampliar el soporte. Los resultados históricos
de ventana que figuran en `stremio.md` conservan su fecha: no sustituyen la
repetición sobre el ejecutable candidato.

| ID | Prioridad | Caso | Cobertura disponible | Validación pendiente y aceptación |
| --- | --- | --- | --- | --- |
| PLAY-01 | P0 | MP4 H.264/AAC directo, sin servicio | Resolución, estado inicial y primer inicio simulados; sondeo comparado con FFprobe | En Windows empaquetado: imagen y sonido; pausar, saltar, cerrar y reanudar en la posición guardada. |
| PLAY-02 | P0 | Fuente HTTP 404 | Regresión de `Player` que diferencia enlace caído y error de formato, y comunica el fallo una vez | Elegir «Directo 404»; la ventana responde, no entra en un bucle y permite elegir otra fuente. |
| PLAY-03 | P0 | MP4 con cabecera obligatoria | Resolución sin arrancar el servicio; prueba Rust del proxy con HTTP Range y ruta privada | Elegir «Directo Cabeceras»; reproduce y permite saltar sin Stremio Service. No registrar cabeceras ni URL configurada. |
| PLAY-04 | P0 | MKV/HEVC, AVI y audio DTS | Sondeo de archivos locales, decisiones de conversión/mpv y conservación de posición simuladas | Repetir con libmpv disponible y ausente; las acciones ofrecidas funcionan y el cambio conserva posición y progreso. |
| PLAY-05 | P0 | Audio y subtítulos | SRT/ASS/Windows-1252, formato dañado y deduplicación; detección de pistas locales | «Pistas · Validación»: cambiar eng/spa y oír tonos distintos; ver subtítulos externos y, mediante mpv, incrustados sin servidor; el archivo dañado muestra un error recuperable. |
| PLAY-06 | P0 | Siguiente episodio y progreso | Selección por episodio/`bingeGroup`, cuenta atrás, vistos y guardado de progreso simulados | Reproducir los tres episodios en la ventana; conserva grupo de fuente, permite cancelar la cuenta atrás y no ofrece el episodio sin estrenar. Reabrir Vela y comprobar progreso/vistos. |
| TOR-01 | P0 | Temporada completa, un torrent local | Prueba Rust `streams_a_complete_season_from_one_torrent`: seed TCP, selección de tres archivos, comparación íntegra y sesión reutilizada | Ejecutar con los MP4 sintéticos. Esto acredita bytes y selección; PLAY-06 sigue siendo necesario para acreditar visionado continuo. |
| TOR-02 | P0 | Torrent sin pares o índice no reproducible | Mensajes y selección de archivos cubiertos con pruebas; fuentes del addon de validación | En la ventana, cancelar una preparación sin pares, elegir otra fuente y comprobar que la sesión anterior no sustituye la nueva. Un índice de subtítulo no se reproduce como vídeo. |
| TOR-03 | P1 | Piezas grandes y saltos en red controlada | Benchmark Rust optativo de 64 MiB con piezas de 4 MiB, seed TCP local y Range | Repetir el benchmark; conservar resultados sin extrapolarlos a Internet, NAT o peers lentos. |
| TOR-04 | P0 | Enjambre público y condiciones reales de red | Benchmark de Sintel ejecutado: arranque con caché nueva y archivo completo; salto posterior desde caché | Faltan piezas grandes, peers lentos, variaciones de NAT, saltos a datos ausentes y una temporada de material propio/libre reproducida desde la ventana. |
| MPV-01 | P0 | MPV externo por IPC | Pruebas Windows con tubería con nombre y proceso simulado; subtítulos tardíos cubiertos | Con `mpv.exe` real: reanudar, informar progreso, cerrar, terminar y avanzar de episodio; conservar vistos. La tubería simulada no acredita el ejecutable real. |
| HLS-01 | P0 | Conversión y cambio de audio | Construcción de URL y decisiones de códec simuladas | Con el servicio instalado: convertir un archivo no compatible, cambiar audio y comprobar sonido, posición y continuidad. No declarar probado el cambio de pista por tener una playlist válida. |
| HLS-02 | P1 | HLS protegido sin extensión y cabeceras de respuesta | Límite actual documentado; `.m3u8` protegido se deriva a mpv | Mantener el límite visible; antes de anunciar soporte, probar playlist y segmentos relativos, cabeceras y saltos de principio a fin. |
| ACC-01 | P0 | Cuenta, biblioteca, temporales y vistos | Contratos API y planificador con datos simulados en `stremioApi.test.ts` | Cuenta de pruebas y biblioteca exportada: añadir/quitar, ver un episodio, sincronizar en ambos sentidos y comprobar el siguiente episodio. Confirmar que otros perfiles siguen locales. |
| ACC-02 | P0 | Fallos y conflictos de cuenta | Planificador y 14 pruebas de integración del store: respuestas tardías, errores, perfiles y credenciales | Editar en ambos clientes, interrumpir red, cerrar sesión y cambiar de cuenta/perfil durante operaciones pendientes; ningún resultado antiguo se aplica al contexto nuevo. Repetir el recorrido con cuenta real antes de darlo por validado en producción. |
| DATA-01 | P0 | Recuperación desde Ajustes | Rust: copia previa, validación y reemplazo atómico; frontend: drenaje de escrituras antiguas, confirmación, errores y guard infantil | En entorno de pruebas, crear una copia con perfiles y progreso, cambiar los datos, restaurar y comprobarlos tras recargar. Restaurar también el respaldo previo para deshacer. Una copia dañada no reemplaza datos. La cuenta queda desvinculada hasta volver a enlazarla. |
| DATA-02 | P0 | Importar exportación JSON | Parser y combinación por timestamps, idempotencia, copia previa, confirmación, errores, PIN y cambio de perfil durante la copia | Exportar en un perfil de pruebas, avanzar un episodio, importar y comprobar que no retrocede. Probar archivo dañado y fallo de copia; no cambian la biblioteca. Recuperar el respaldo previo para deshacer. |
| ADDON-01 | P1 | Diagnóstico y reintento | Servicio con transporte simulado y componente: éxito, fallo, identidad cambiada, eliminación/reinstalación y addons locales | Probar un addon local de validación disponible y caído, repetir comprobación y verificar la fecha. Confirmar que «manifiesto correcto» no se confunde con fuentes disponibles. |

## Repetir las comprobaciones automáticas

Desde la raíz del repositorio, con dependencias instaladas:

```powershell
pnpm test src/lib/playback.test.ts src/lib/streamingServer.test.ts src/lib/torrentEngine.test.ts src/lib/embeddedMpv.test.ts src/lib/externalPlayback.test.ts src/components/Player.test.tsx src/components/EmbeddedPlayer.test.tsx src/components/player/useMediaSource.test.ts src/components/player/useWatchProgress.test.tsx src/components/player/useNextCountdown.test.tsx src/lib/mediaProbe.test.ts src/lib/mediaProbe.files.test.ts src/lib/subtitles.test.ts src/lib/episodes.test.ts
```

Los archivos locales se generan en `.tmp/media/`, fuera del control de versiones:

```powershell
node dev/make-validation-media.mjs
pnpm test src/lib/mediaProbe.files.test.ts
```

FFmpeg y FFprobe deben estar en `PATH`. La prueba del sondeo **se omite** si
faltan FFprobe o los medios: revisar el contador de omitidas antes de atribuirle
cobertura. El generador produce patrones, tonos y subtítulos propios; no requiere
descargar películas ni instalar FFmpeg como dependencia de Vela.

Pruebas Rust locales, sin un enjambre público ni cuenta:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml proxy::tests
cargo test --locked --manifest-path src-tauri/Cargo.toml mpv::tests
$env:VELA_SEASON_MEDIA = (Resolve-Path '.tmp/media').Path
try {
    cargo test --locked --manifest-path src-tauri/Cargo.toml streams_a_complete_season_from_one_torrent -- --nocapture
} finally {
    Remove-Item Env:VELA_SEASON_MEDIA -ErrorAction SilentlyContinue
}
cargo test --locked --manifest-path src-tauri/Cargo.toml large_piece_loopback_benchmark -- --ignored --nocapture
```

La temporada usa directorios temporales y sus propios seed/cliente; no comparte
la base de datos de Vela. El benchmark de piezas grandes mueve hasta 192 MiB por
loopback en sus tres pasadas, sin demostrar rendimiento de un enjambre público.

## Repetir los casos en Windows

1. Usar una máquina virtual o usuario Windows de pruebas. Preparar ahí los medios,
   el instalador candidato y, cuando el caso lo requiera, Stremio Service y MPV.
   No usar el perfil ni la biblioteca de una instalación personal. Cambiar solo
   el identificador Tauri no aísla por sí mismo todos los servicios y enlaces del
   sistema.
2. En una consola de ese entorno, ejecutar `node dev/validation-addon.mjs` e
   instalar `http://127.0.0.1:7010/manifest.json` en Vela. El addon escucha solo en
   loopback. Cerrar el proceso con `Ctrl+C` al terminar.
3. Para los casos sin servicio, seleccionar el motor Vela y configurar una
   dirección de servicio de pruebas que no responda, por ejemplo
   `http://127.0.0.1:11999`, comprobando antes que ese puerto esté libre. Registrar
   si libmpv se detectó, se descargó o no estaba disponible.
4. Ejecutar PLAY-01 a PLAY-06 y TOR-02 con las fuentes del addon. Para los casos
   con servicio, devolver la dirección a la instalación del entorno de pruebas
   y repetir HLS-01. El addon sirve episodios directos: su serie no sustituye la
   prueba de una temporada torrent en red real.
5. Repetir MPV-01 configurando un `mpv.exe` real. Los controles de mpv integrado y
   la tubería de los tests no sustituyen ese recorrido externo.
6. Repetir con el instalador empaquetado. `pnpm dev`, jsdom y una ventana Tauri de
   desarrollo aportan evidencias distintas del ejecutable de release.

No hay una fuente local HLS en este addon: HLS-01 necesita la conversión del
servicio; HLS-02 requiere preparar una playlist de prueba específica. No marcar
esos casos como correctos por reproducir el MP4 directo.

## Enjambre público: ejecución separada

El benchmark de Internet está ignorado por defecto. Establecer siempre el hash
de una obra libre identificada: no usar el valor por defecto del test. Este
ejemplo usa la muestra Sintel de Blender Foundation que ya sirve el addon
(CC BY 3.0), con índice de vídeo explícito:

```powershell
$env:VELA_BENCH_HASH = '08ada5a7a6183aae1e09d831df6748d566095a10'
$env:VELA_BENCH_FILE = '5'
$env:VELA_BENCH_TIME = '60'
try {
    cargo test --locked --manifest-path src-tauri/Cargo.toml streaming_benchmark -- --ignored --nocapture
} finally {
    Remove-Item Env:VELA_BENCH_HASH,Env:VELA_BENCH_FILE,Env:VELA_BENCH_TIME -ErrorAction SilentlyContinue
}
```

Cerrar otras sesiones que descarguen el mismo torrent para no medir un seed
local como si fuese Internet. Registrar conexión, tamaño de pieza y estado de
pares: esta muestra no demuestra por sí sola piezas grandes, NAT problemático,
una temporada ni rendimiento constante. Para comparar ajustes, mantener el mismo
material y entorno y repetir; no convertir una pasada favorable en una garantía.

## Registro de ejecución y criterio de cierre

Por caso, anotar: commit/build, Windows y WebView2, motor/reproductor/servicio,
medio utilizado, pasos, resultado esperado/observado y evidencia. Para reproducción
real añadir tiempo al primer fotograma, cortes y posición antes/después de un
salto o cambio de reproductor. Mantener los datos locales; omitir claves y URLs
de addons que puedan contener tokens.

En casos de cuenta real, usar una cuenta de pruebas preparada para esos cambios,
exportar ambos estados iniciales y revisar biblioteca, temporales, vistos y
perfiles antes/después. No guardar credenciales en scripts ni en este documento.

El sprint cierra cuando los P0 afectados por el cambio pasan sobre el candidato
Windows, los fallos tienen una regresión cuando sea viable y los casos no
ejecutados conservan explícitamente ese estado. La CI actual ejecuta tipos,
build y tests frontend en Ubuntu, y formato, Clippy y tests Rust en Windows; no
ejecuta los recorridos de ventana/instalador, una cuenta real ni los benchmarks
ignorados, y tampoco exige medios locales/FFprobe para el sondeo de archivos.
