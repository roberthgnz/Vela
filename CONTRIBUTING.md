# Contribuir a Vela

Gracias por tu interés. Vela es un cliente de escritorio para Windows (Tauri 2, Rust, React y TypeScript) compatible con el protocolo de addons de Stremio. Antes de cambiar integraciones, lee [docs/stremio.md](docs/stremio.md): recoge los contratos verificados, lo que falta por probar y por qué el código está hecho así.

## Preparar el entorno

Requisitos: Windows 10/11, Node 22.12 o posterior, pnpm 11, Rust estable, las herramientas de compilación C++ de Microsoft y WebView2.

```powershell
pnpm install --frozen-lockfile
pnpm desktop
```

`pnpm desktop` abre la ventana Tauri con recarga automática. Para probar fuentes reales sin depender de proveedores externos:

```powershell
node dev/make-validation-media.mjs   # medios sintéticos (necesita FFmpeg)
node dev/validation-addon.mjs        # addon en http://127.0.0.1:7010/manifest.json
```

Los torrents, la conversión de formatos y los subtítulos incrustados necesitan el servidor de streaming que instala Stremio (`http://127.0.0.1:11470`).

## Antes de abrir un pull request

```powershell
pnpm build
pnpm test
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

La CI ejecuta lo mismo. No hay pruebas automáticas de interfaz: comprueba los cambios visibles en la ventana Tauri y descríbelo en el pull request.

- Añade pruebas unitarias para los cambios de comportamiento y de regresión para los errores que corrijas.
- Distingue en la descripción lo verificado contra servicios reales de lo cubierto solo por pruebas simuladas, y actualiza `docs/stremio.md` cuando cambie lo que sabemos de un contrato o de un servicio.
- Sigue el estilo del código que rodea tu cambio. La interfaz está en español.
- Mensajes de commit al estilo [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `ci:`, `chore:`.

## Límites del proyecto

- **Contenido**: Vela no incluye ni enlaza contenido protegido. Las pruebas, capturas y ejemplos usan solo medios propios, sintéticos o con licencia libre (por ejemplo, las películas de Blender Foundation bajo CC BY). No añadas enlaces, hashes ni capturas de contenido sin permiso.
- **Código de terceros**: no copies código de las aplicaciones oficiales de Stremio (stremio-web es GPL-2.0, stremio-shell es GPL-3.0). Implementa a partir de los contratos documentados y cita la fuente en `docs/stremio.md`.
- **Privacidad**: Vela no envía actividad de reproducción a los addons ni datos a servicios que el usuario no haya configurado. Los cambios que lo hagan necesitan consentimiento explícito en la interfaz.
- **Seguridad**: no registres claves de sesión ni URLs de configuración de addons (pueden contener tokens). Los problemas de seguridad se comunican según [SECURITY.md](SECURITY.md), no en issues públicos.

## Publicar una versión

Ver «Versiones en GitHub» en el [README](README.md#versiones-en-github).

Al contribuir aceptas que tu aportación se distribuya bajo la [licencia MIT](LICENSE) del proyecto y te comprometes a seguir el [código de conducta](CODE_OF_CONDUCT.md).
