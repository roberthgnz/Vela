use std::time::Duration;
use url::Url;

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_REDIRECTS: usize = 5;
/// Largest slice of a media file read at once (container headers such as MKV chapters).
pub const MAX_RANGE_BYTES: u64 = 4 * 1024 * 1024;

pub fn checked_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 8192 {
        return Err("La dirección es demasiado larga.".to_owned());
    }
    let url =
        Url::parse(raw).map_err(|_| "Escribe una dirección HTTP o HTTPS válida.".to_owned())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Solo se admiten direcciones HTTP y HTTPS.".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("No se admiten direcciones con usuario o contraseña.".to_owned());
    }
    Ok(url)
}

pub struct HttpClient(reqwest::Client);

impl HttpClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(8))
            .timeout(REQUEST_TIMEOUT)
            .user_agent("Vela/0.3.2")
            .build()
            .map(Self)
    }

    async fn bytes(
        &self,
        raw: &str,
        body: Option<&serde_json::Value>,
        range: Option<(u64, u64)>,
    ) -> Result<Vec<u8>, String> {
        let mut url = checked_url(raw)?;
        tokio::time::timeout(REQUEST_TIMEOUT, async {
            for redirects in 0..=MAX_REDIRECTS {
                let request = match body {
                    Some(body) => self
                        .0
                        .post(url.clone())
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .body(body.to_string()),
                    None => match range {
                        Some((start, length)) => self.0.get(url.clone()).header(
                            reqwest::header::RANGE,
                            format!("bytes={}-{}", start, start + length - 1),
                        ),
                        None => self.0.get(url.clone()),
                    },
                };
                let mut response = request.send().await.map_err(|error| {
                    if error.is_timeout() {
                        "El addon no respondió a tiempo.".to_owned()
                    } else {
                        "No se pudo conectar con el addon. Comprueba su dirección y la conexión."
                            .to_owned()
                    }
                })?;
                if response.status().is_redirection() {
                    if body.is_some() {
                        return Err(
                            "El servicio respondió con una redirección inesperada.".to_owned()
                        );
                    }
                    if redirects == MAX_REDIRECTS {
                        return Err("El addon redirigió demasiadas veces.".to_owned());
                    }
                    let location = response
                        .headers()
                        .get(reqwest::header::LOCATION)
                        .and_then(|value| value.to_str().ok())
                        .ok_or_else(|| "El addon devolvió una redirección no válida.".to_owned())?;
                    let next = url
                        .join(location)
                        .map_err(|_| "El addon devolvió una redirección no válida.".to_owned())?;
                    url = checked_url(next.as_str())?;
                    continue;
                }
                if !response.status().is_success() {
                    return Err(format!(
                        "El addon respondió con HTTP {}.",
                        response.status().as_u16()
                    ));
                }
                // A server that ignores Range sends the whole file from the start: keep the first
                // bytes when they are the ones asked for, refuse otherwise.
                let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
                let wanted = match range {
                    Some((start, _)) if !partial && start > 0 => {
                        return Err("El servidor no admite lecturas parciales.".to_owned());
                    }
                    Some((_, length)) => Some(length as usize),
                    None => None,
                };
                if wanted.is_none()
                    && response
                        .content_length()
                        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
                {
                    return Err("La respuesta del addon supera el límite de 8 MB.".to_owned());
                }
                let mut bytes = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| "No se pudo leer la respuesta del addon.".to_owned())?
                {
                    if let Some(wanted) = wanted {
                        let take = chunk.len().min(wanted - bytes.len());
                        bytes.extend_from_slice(&chunk[..take]);
                        if bytes.len() == wanted {
                            break;
                        }
                        continue;
                    }
                    if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                        return Err("La respuesta del addon supera el límite de 8 MB.".to_owned());
                    }
                    bytes.extend_from_slice(&chunk);
                }
                return Ok(bytes);
            }
            unreachable!()
        })
        .await
        .map_err(|_| "El addon no respondió a tiempo.".to_owned())?
    }

    pub async fn json(&self, url: &str) -> Result<serde_json::Value, String> {
        let bytes = self.bytes(url, None, None).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "El addon devolvió un JSON no válido.".to_owned())
    }

    /// Sends a JSON body with POST. Redirects are refused so the body is never replayed elsewhere.
    pub async fn post_json(
        &self,
        url: &str,
        body: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let bytes = self.bytes(url, Some(body), None).await?;
        serde_json::from_slice(&bytes)
            .map_err(|_| "El servicio devolvió un JSON no válido.".to_owned())
    }

    pub async fn raw(&self, url: &str) -> Result<Vec<u8>, String> {
        self.bytes(url, None, None).await
    }

    /// Up to `length` bytes from `start` (fewer at the end of the file), with an HTTP Range request.
    pub async fn range(&self, url: &str, start: u64, length: u64) -> Result<Vec<u8>, String> {
        if length == 0 || length > MAX_RANGE_BYTES {
            return Err("Lectura parcial demasiado grande.".to_owned());
        }
        self.bytes(url, None, Some((start, length))).await
    }

    pub async fn text(&self, url: &str) -> Result<String, String> {
        let bytes = self.bytes(url, None, None).await?;
        String::from_utf8(bytes).map_err(|_| "El addon devolvió texto que no es UTF-8.".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn serve(response: Vec<u8>) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            let _ = socket.write_all(&response).await;
            let _ = socket.shutdown().await;
        });
        format!("http://{address}/manifest.json")
    }

    fn client() -> HttpClient {
        let _ = rustls::crypto::ring::default_provider().install_default();
        HttpClient::new().unwrap()
    }

    #[test]
    fn accepts_configured_local_services_but_rejects_credentials_and_non_http() {
        assert!(checked_url("http://127.0.0.1:11470/manifest.json").is_ok());
        assert!(checked_url("https://example.com/key/manifest.json").is_ok());
        for url in [
            "file:///C:/secret",
            "ftp://example.com",
            "https://user:secret@example.com",
            "not a url",
        ] {
            assert!(checked_url(url).is_err());
        }
    }

    #[tokio::test]
    async fn reads_ranges_and_handles_servers_that_ignore_them() {
        let url =
            serve(b"HTTP/1.1 206 Partial Content\r\nContent-Length: 4\r\n\r\nabcd".to_vec()).await;
        assert_eq!(client().range(&url, 100, 4).await.unwrap(), b"abcd");
        // A whole-file answer is cut to the length asked for when it starts at zero…
        let url = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789".to_vec()).await;
        assert_eq!(client().range(&url, 0, 4).await.unwrap(), b"0123");
        // …and refused when it would be read from the wrong place.
        let url = serve(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n0123456789".to_vec()).await;
        assert_eq!(
            client().range(&url, 5, 4).await.unwrap_err(),
            "El servidor no admite lecturas parciales."
        );
        assert!(client().range(&url, 0, MAX_RANGE_BYTES + 1).await.is_err());
    }

    #[tokio::test]
    async fn returns_valid_json_and_sanitizes_status_and_parse_errors() {
        let url =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".to_vec()).await;
        assert_eq!(
            client().json(&url).await.unwrap(),
            serde_json::json!({"ok": true})
        );
        let url =
            serve(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 12\r\n\r\nsecret-token".to_vec())
                .await;
        assert_eq!(
            client().json(&url).await.unwrap_err(),
            "El addon respondió con HTTP 403."
        );
        let url =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\nsecret-token".to_vec()).await;
        assert_eq!(
            client().json(&url).await.unwrap_err(),
            "El addon devolvió un JSON no válido."
        );
    }

    #[tokio::test]
    async fn rejects_oversized_content_length_and_streamed_body() {
        let url = serve(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .into_bytes(),
        )
        .await;
        assert!(
            client()
                .text(&url)
                .await
                .unwrap_err()
                .contains("límite de 8 MB")
        );
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.extend(vec![b'x'; MAX_RESPONSE_BYTES + 1]);
        let url = serve(response).await;
        assert!(
            client()
                .text(&url)
                .await
                .unwrap_err()
                .contains("límite de 8 MB")
        );
    }

    #[tokio::test]
    async fn posts_json_and_refuses_redirects() {
        let url =
            serve(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}".to_vec()).await;
        assert_eq!(
            client()
                .post_json(&url, &serde_json::json!({"a": 1}))
                .await
                .unwrap(),
            serde_json::json!({"ok": true})
        );
        let url = serve(
            b"HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:1/x\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
        )
        .await;
        assert_eq!(
            client()
                .post_json(&url, &serde_json::json!({}))
                .await
                .unwrap_err(),
            "El servicio respondió con una redirección inesperada."
        );
    }

    #[tokio::test]
    async fn checks_redirect_urls_before_following() {
        let url = serve(
            b"HTTP/1.1 302 Found\r\nLocation: file:///C:/private\r\nContent-Length: 0\r\n\r\n"
                .to_vec(),
        )
        .await;
        assert_eq!(
            client().text(&url).await.unwrap_err(),
            "Solo se admiten direcciones HTTP y HTTPS."
        );
    }
}
