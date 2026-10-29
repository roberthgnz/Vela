# Vela

Cliente de escritorio independiente para Windows, construido con Tauri 2, Rust, React y TypeScript. Compatible con el protocolo HTTP/JSON de addons de Stremio. No es una aplicación oficial de Stremio.

La [investigación de Stremio y el estado de integración](docs/stremio.md) recoge los repositorios, licencias observadas, contratos de addons, API de cuenta, servidor de streaming, arquitectura de Vela y trabajo pendiente. Leerla antes de continuar las integraciones.

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
pnpm package
```

El instalador se genera en `src-tauri/target/release/bundle/nsis/`. La aplicación empaquetada incluye su interfaz y no requiere Node ni el servidor Vite en el equipo del usuario. WebView2 es un requisito de ejecución.

## Primera versión

- Catálogos reales de películas y series de Cinemeta; búsqueda remota, detalles y episodios.
- Instalación de addons mediante su URL de manifiesto, activación, desactivación y eliminación.
- Consulta de fuentes y subtítulos a los addons instalados.
- Biblioteca y progreso de reproducción locales, con exportación de biblioteca a JSON.
- Reproductor integrado para MP4; ramas implementadas de HLS y subtítulos VTT/SRT, pendientes de validación multimedia E2E. Incluye velocidad y pantalla completa.
- Apertura de fuentes externas y lanzamiento de MPV instalado por el usuario.
- Dirección configurable de Stremio Service para fuentes torrent con hash e índice de archivo. Para películas sin índice envía `-1` y delega la selección al servicio; las series requieren un índice explícito. Pendiente de prueba con el servicio real.
- Dos tráileres de demostración para probar la reproducción sin un proveedor de películas.

## Límites actuales

La UI/UX es provisional. No hay inicio de sesión ni sincronización con la cuenta de Stremio. La biblioteca se guarda en este dispositivo; las consultas se envían a los proveedores de addons correspondientes.

Cinemeta proporciona metadatos, no películas reproducibles. Las fuentes dependen de los addons que instale el usuario. Stremio Service y MPV no se incluyen. La integración torrent requiere el servicio externo y todavía necesita una prueba con ese servicio en ejecución. No hay motor torrent propio, libmpv integrado ni transcodificación automática. Los enlaces con cabeceras de proxy obligatorias muestran una limitación explícita en lugar de intentar reproducirlos incorrectamente.

Los enlaces directos y las listas HLS también dependen de sus códecs, CORS y disponibilidad. Abrir un instalador generado localmente sin firma puede mostrar el aviso habitual de Windows.

## Créditos

Big Buck Bunny y Sintel son obras de Blender Foundation. Vela incluye ilustraciones propias y enlaces a sus tráileres, alojados por W3C; no incluye las películas completas. Los tráileres se distribuyen bajo [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Véanse [Big Buck Bunny](https://peach.blender.org/) y [Sintel](https://durian.blender.org/).

El cliente implementa el [protocolo de addons](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/protocol.md). No incorpora código de las interfaces oficiales de Stremio. Las dependencias conservan sus propias licencias.
