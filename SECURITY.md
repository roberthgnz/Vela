# Seguridad

## Versiones con soporte

Solo la última versión publicada en [Releases](https://github.com/roberthgnz/Vela/releases) recibe correcciones de seguridad.

## Informar de una vulnerabilidad

No abras un issue público. Usa el informe privado de vulnerabilidades de GitHub: pestaña **Security** › **Report a vulnerability** en este repositorio.

Incluye la versión de Vela y de Windows, los pasos para reproducirlo y el impacto que esperas. Recibirás respuesta en unos días; cuando haya una corrección se publicará una versión nueva y se dará crédito a quien lo informó, si lo desea.

## Alcance

Interesan especialmente:

- Ejecución de código o acceso a archivos desde un addon, un manifiesto, una fuente o un subtítulo malicioso.
- Salida de la clave de sesión de Stremio del Administrador de credenciales de Windows, o su aparición en registros o capturas.
- Peticiones del transporte nativo que se salten las comprobaciones de URL (solo HTTP/HTTPS, sin credenciales en la URL, límites de tamaño).
- Inyección de argumentos o cabeceras al lanzar un reproductor externo.
- Formas de que la actualización automática instale algo no firmado con la clave de Vela.
- Acceso desde la página o desde la red al servidor local del motor de torrents (127.0.0.1, ruta con un token aleatorio) o a archivos fuera de lo que sirve.
- Que mpv integrado cargue una biblioteca que no sea una libmpv instalada en las rutas conocidas, o abra archivos locales fuera de Descargas\Vela.

## Política de contenido (CSP) de la ventana

La CSP de `src-tauri/tauri.conf.json` no permite scripts remotos ni `eval` (solo `wasm-unsafe-eval`, que necesita JASSUB), y limita los marcos a `youtube-nocookie.com` para los tráileres. En cambio, `img-src`, `media-src` y `connect-src` aceptan `http:` y `https:` de cualquier origen, a propósito: los carteles, los vídeos directos y las listas HLS vienen de los addons que instala cada usuario, que pueden estar en cualquier dominio o en la red local (por ejemplo, un addon propio en 127.0.0.1). Las peticiones JSON y de subtítulos no dependen de esa CSP: pasan por el transporte nativo de Rust, que solo admite HTTP/HTTPS sin credenciales en la URL. Lo que un addon puede hacer con esa apertura es mostrar imágenes y reproducir medios; no puede ejecutar código en la ventana. Si encuentras una forma de convertir una de esas fuentes en ejecución de código, es un fallo de seguridad e interesa.

Los addons de terceros y el servidor de streaming de Stremio no forman parte de Vela; sus vulnerabilidades deben comunicarse a quienes los mantienen.
