//! A one-source HTTP proxy on 127.0.0.1 that adds the request headers a source demands, for
//! players that cannot send them (VLC). It serves a single secret path, forwards GET and HEAD with
//! the player's Range header, streams the answer back unchanged and stops when dropped.

use std::collections::BTreeMap;
use std::hash::{BuildHasher, Hasher};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;

const MAX_REQUEST_HEAD: usize = 16 * 1024;
/// Response headers worth passing to the player; the rest describe the upstream connection.
const FORWARDED: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "last-modified",
    "etag",
];

pub struct HeaderProxy {
    pub url: Url,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for HeaderProxy {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// 128 unguessable bits from the OS-seeded keys of the standard library's hasher.
pub(crate) fn token() -> String {
    let part = || {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|time| time.as_nanos())
                .unwrap_or_default(),
        );
        hasher.finish()
    };
    format!("{:016x}{:016x}", part(), part())
}

pub async fn serve(target: Url, headers: BTreeMap<String, String>) -> Result<HeaderProxy, String> {
    let failed = || "No se pudo preparar la fuente para el reproductor.".to_owned();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(5))
        .connect_timeout(Duration::from_secs(15))
        // Media must reach the player byte for byte, so that lengths and ranges stay valid.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .build()
        .map_err(|_| failed())?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| failed())?;
    let port = listener.local_addr().map_err(|_| failed())?.port();
    let path = format!("/{}", token());
    let name = target
        .path_segments()
        .and_then(|mut segments| segments.next_back().map(str::to_owned))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "video".to_owned());
    let url = Url::parse(&format!("http://127.0.0.1:{port}{path}/{name}")).map_err(|_| failed())?;
    let served = url.path().to_owned();
    let task = tokio::spawn(async move {
        while let Ok((socket, _)) = listener.accept().await {
            let (client, target, headers, served) = (
                client.clone(),
                target.clone(),
                headers.clone(),
                served.clone(),
            );
            tokio::spawn(async move {
                let _ = handle(socket, &client, &target, &headers, &served).await;
            });
        }
    });
    Ok(HeaderProxy { url, task })
}

pub(crate) async fn read_head(socket: &mut TcpStream) -> Option<String> {
    let mut head = Vec::new();
    let mut buffer = [0; 2048];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = socket.read(&mut buffer).await.ok()?;
        if read == 0 || head.len() + read > MAX_REQUEST_HEAD {
            return None;
        }
        head.extend_from_slice(&buffer[..read]);
    }
    String::from_utf8(head).ok()
}

pub(crate) async fn reply(socket: &mut TcpStream, status: &str) -> std::io::Result<()> {
    socket
        .write_all(
            format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await
}

async fn handle(
    mut socket: TcpStream,
    client: &reqwest::Client,
    target: &Url,
    headers: &BTreeMap<String, String>,
    served: &str,
) -> std::io::Result<()> {
    let Some(head) = read_head(&mut socket).await else {
        return reply(&mut socket, "400 Bad Request").await;
    };
    let mut lines = head.split("\r\n");
    let mut request = lines.next().unwrap_or_default().split(' ');
    let (method, path) = (
        request.next().unwrap_or_default(),
        request.next().unwrap_or_default(),
    );
    if path.split('?').next() != Some(served) {
        return reply(&mut socket, "404 Not Found").await;
    }
    let method = match method {
        "GET" => reqwest::Method::GET,
        "HEAD" => reqwest::Method::HEAD,
        _ => return reply(&mut socket, "405 Method Not Allowed").await,
    };
    let range = lines.find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.trim()
            .eq_ignore_ascii_case("range")
            .then(|| value.trim().to_owned())
    });
    let mut upstream = client.request(method.clone(), target.clone());
    for (name, value) in headers {
        upstream = upstream.header(name, value);
    }
    if let Some(range) = range {
        upstream = upstream.header(reqwest::header::RANGE, range);
    }
    let Ok(mut response) = upstream.send().await else {
        return reply(&mut socket, "502 Bad Gateway").await;
    };
    let status = response.status();
    let mut answer = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for name in FORWARDED {
        if let Some(value) = response
            .headers()
            .get(*name)
            .and_then(|value| value.to_str().ok())
        {
            answer.push_str(&format!("{name}: {value}\r\n"));
        }
    }
    answer.push_str("Connection: close\r\n\r\n");
    socket.write_all(answer.as_bytes()).await?;
    if method == reqwest::Method::GET {
        while let Ok(Some(chunk)) = response.chunk().await {
            socket.write_all(&chunk).await?;
        }
    }
    socket.shutdown().await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Origin that answers 206 only when the proxy forwarded the source's header and the range.
    async fn origin() -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let head = read_head(&mut socket)
                    .await
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let answer: &[u8] = if head.contains("x-vela-token: ok")
                    && head.contains("range: bytes=2-5")
                {
                    b"HTTP/1.1 206 Partial Content\r\nContent-Type: video/mp4\r\nContent-Range: bytes 2-5/10\r\nContent-Length: 4\r\nX-Upstream: secret\r\n\r\n2345"
                } else {
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"
                };
                let _ = socket.write_all(answer).await;
                let _ = socket.shutdown().await;
            }
        });
        Url::parse(&format!("http://{address}/media/movie.mp4?sig=1")).unwrap()
    }

    #[tokio::test]
    async fn adds_headers_forwards_ranges_and_serves_only_its_path() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let headers = BTreeMap::from([("X-Vela-Token".to_owned(), "ok".to_owned())]);
        let proxy = serve(origin().await, headers).await.unwrap();
        assert!(
            proxy.url.as_str().starts_with("http://127.0.0.1:")
                && proxy.url.path().ends_with("/movie.mp4")
        );
        let client = reqwest::Client::new();
        let response = client
            .get(proxy.url.clone())
            .header("Range", "bytes=2-5")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(response.headers()["content-range"], "bytes 2-5/10");
        assert!(response.headers().get("x-upstream").is_none());
        assert_eq!(response.bytes().await.unwrap().as_ref(), b"2345");
        let mut other = proxy.url.clone();
        other.set_path("/guess/movie.mp4");
        assert_eq!(client.get(other).send().await.unwrap().status(), 404);
        let post = client.post(proxy.url.clone()).send().await.unwrap();
        assert_eq!(post.status(), 405);
        let url = proxy.url.clone();
        drop(proxy);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(client.get(url).send().await.is_err());
    }
}
