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

Los addons de terceros y el servidor de streaming de Stremio no forman parte de Vela; sus vulnerabilidades deben comunicarse a quienes los mantienen.
