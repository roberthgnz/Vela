//! Follows an MPV process started by Vela through its JSON IPC (`--input-ipc-server`).
//!
//! MPV writes one JSON object per line to the pipe. Vela observes `time-pos`, `duration`,
//! `pause` and `eof-reached`, forwards progress to the window and reports when the player
//! closes so the interface can save the position and offer the next episode.
//! Protocol: <https://mpv.io/manual/stable/#json-ipc>.

use serde_json::{Value, json};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// Property ids used with `observe_property`.
const OBSERVED: [(u64, &str); 4] = [
    (1, "time-pos"),
    (2, "duration"),
    (3, "pause"),
    (4, "eof-reached"),
];
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROGRESS_INTERVAL: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Playback {
    pub position: Option<f64>,
    pub duration: Option<f64>,
    pub paused: bool,
    pub eof: bool,
    /// Reason given by the last `end-file` event (`eof`, `quit`, `error`…).
    pub end_reason: Option<String>,
}

impl Playback {
    /// Applies one IPC line. Returns true when the visible state changed.
    pub fn apply(&mut self, line: &str) -> bool {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return false;
        };
        match message.get("event").and_then(Value::as_str) {
            Some("property-change") => {
                let data = message.get("data");
                match message.get("name").and_then(Value::as_str) {
                    Some("time-pos") => {
                        let next = data
                            .and_then(Value::as_f64)
                            .filter(|v| v.is_finite() && *v >= 0.0);
                        // MPV reports null after the file ends; keep the last known position.
                        if next.is_some() && next != self.position {
                            self.position = next;
                            return true;
                        }
                    }
                    Some("duration") => {
                        let next = data
                            .and_then(Value::as_f64)
                            .filter(|v| v.is_finite() && *v > 0.0);
                        if next.is_some() && next != self.duration {
                            self.duration = next;
                            return true;
                        }
                    }
                    Some("pause") => {
                        let next = data.and_then(Value::as_bool).unwrap_or(false);
                        if next != self.paused {
                            self.paused = next;
                            return true;
                        }
                    }
                    Some("eof-reached") => {
                        let next = data.and_then(Value::as_bool).unwrap_or(false);
                        if next != self.eof {
                            self.eof = next;
                            return true;
                        }
                    }
                    _ => {}
                }
            }
            Some("end-file") => {
                let reason = message
                    .get("reason")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_owned();
                if reason == "eof" {
                    self.eof = true;
                }
                self.end_reason = Some(reason);
                return true;
            }
            _ => {}
        }
        false
    }

    pub fn to_json(&self, session: &str) -> Value {
        json!({
            "session": session,
            "position": self.position,
            "duration": self.duration,
            "paused": self.paused,
            "ended": self.eof,
            "reason": self.end_reason,
        })
    }
}

/// Session ids come from the interface and become part of a pipe name.
pub fn valid_session(session: &str) -> bool {
    (1..=40).contains(&session.len())
        && session
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

pub fn pipe_name(session: &str) -> String {
    if cfg!(windows) {
        format!(r"\\.\pipe\vela-mpv-{session}")
    } else {
        std::env::temp_dir()
            .join(format!("vela-mpv-{session}.sock"))
            .to_string_lossy()
            .into_owned()
    }
}

pub fn ipc_arguments(session: &str, start: Option<f64>) -> Vec<String> {
    let mut arguments = vec![format!("--input-ipc-server={}", pipe_name(session))];
    if let Some(start) = start.filter(|value| value.is_finite() && *value >= 1.0) {
        arguments.push(format!("--start={start:.1}"));
    }
    arguments
}

/// Connects to the pipe, observes playback and calls `progress` while MPV runs.
/// Returns the last state once MPV closes the pipe, or `None` if it never answered.
#[cfg(windows)]
pub async fn follow(
    pipe: &str,
    session: &str,
    mut alive: impl FnMut() -> bool,
    mut progress: impl FnMut(Value),
) -> Option<Playback> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let started = tokio::time::Instant::now();
    let client = loop {
        match ClientOptions::new().open(pipe) {
            Ok(client) => break client,
            Err(_) if started.elapsed() < CONNECT_TIMEOUT && alive() => {
                tokio::time::sleep(Duration::from_millis(150)).await;
            }
            Err(_) => return None,
        }
    };
    let (reader, mut writer) = tokio::io::split(client);
    for (id, name) in OBSERVED {
        let command = json!({ "command": ["observe_property", id, name] });
        if writer
            .write_all(format!("{command}\n").as_bytes())
            .await
            .is_err()
        {
            return Some(Playback::default());
        }
    }
    let mut state = Playback::default();
    let mut lines = BufReader::new(reader).lines();
    let mut last_sent = tokio::time::Instant::now() - PROGRESS_INTERVAL;
    let mut last_paused = false;
    while let Ok(Some(line)) = lines.next_line().await {
        if state.apply(&line)
            && (last_sent.elapsed() >= PROGRESS_INTERVAL || state.paused != last_paused)
        {
            last_sent = tokio::time::Instant::now();
            last_paused = state.paused;
            progress(state.to_json(session));
        }
    }
    Some(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_position_duration_pause_and_end() {
        let mut state = Playback::default();
        assert!(
            state.apply(r#"{"event":"property-change","id":2,"name":"duration","data":1420.5}"#)
        );
        assert!(
            state.apply(r#"{"event":"property-change","id":1,"name":"time-pos","data":12.25}"#)
        );
        assert!(
            !state.apply(r#"{"event":"property-change","id":1,"name":"time-pos","data":12.25}"#)
        );
        assert!(state.apply(r#"{"event":"property-change","id":3,"name":"pause","data":true}"#));
        // Replies to commands and unrelated events are ignored.
        assert!(!state.apply(r#"{"request_id":0,"error":"success"}"#));
        assert!(!state.apply("not json"));
        // MPV sends null for time-pos after the file ends; the last position is kept.
        assert!(!state.apply(r#"{"event":"property-change","id":1,"name":"time-pos"}"#));
        assert!(state.apply(r#"{"event":"end-file","reason":"quit"}"#));
        assert_eq!(
            state,
            Playback {
                position: Some(12.25),
                duration: Some(1420.5),
                paused: true,
                eof: false,
                end_reason: Some("quit".into()),
            }
        );
        let mut finished = Playback::default();
        finished.apply(r#"{"event":"end-file","reason":"eof"}"#);
        assert!(finished.eof);
    }

    #[test]
    fn validates_sessions_and_builds_arguments() {
        assert!(valid_session("a1b2-c3"));
        assert!(!valid_session(""));
        assert!(!valid_session(r"..\x"));
        assert!(!valid_session(&"a".repeat(41)));
        let arguments = ipc_arguments("abc", Some(95.04));
        assert!(
            arguments[0].starts_with("--input-ipc-server=")
                && arguments[0].ends_with("vela-mpv-abc")
        );
        assert_eq!(arguments[1], "--start=95.0");
        assert_eq!(ipc_arguments("abc", Some(0.2)).len(), 1);
        assert_eq!(ipc_arguments("abc", Some(f64::NAN)).len(), 1);
    }

    /// Plays the role of MPV on a real named pipe: answers the observe commands with
    /// property changes, then closes as MPV does when the user quits.
    #[cfg(windows)]
    #[tokio::test]
    async fn follows_a_named_pipe_until_the_player_closes() {
        use tokio::net::windows::named_pipe::ServerOptions;
        let pipe = pipe_name("test-follow");
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe)
            .unwrap();
        let fake = tokio::spawn(async move {
            server.connect().await.unwrap();
            let (reader, mut writer) = tokio::io::split(server);
            let mut lines = BufReader::new(reader).lines();
            let mut commands = Vec::new();
            for _ in 0..4 {
                commands.push(lines.next_line().await.unwrap().unwrap());
            }
            for event in [
                r#"{"event":"property-change","id":2,"name":"duration","data":600}"#,
                r#"{"event":"property-change","id":1,"name":"time-pos","data":61.5}"#,
                r#"{"event":"property-change","id":3,"name":"pause","data":true}"#,
                r#"{"event":"end-file","reason":"quit"}"#,
            ] {
                writer
                    .write_all(format!("{event}\n").as_bytes())
                    .await
                    .unwrap();
            }
            commands
        });
        let mut updates = Vec::new();
        let state = follow(&pipe, "test-follow", || true, |value| updates.push(value))
            .await
            .unwrap();
        let commands = fake.await.unwrap();
        assert!(commands[0].contains(r#""observe_property",1,"time-pos""#));
        assert_eq!(state.position, Some(61.5));
        assert_eq!(state.duration, Some(600.0));
        assert_eq!(state.end_reason.as_deref(), Some("quit"));
        assert!(!updates.is_empty());
        assert_eq!(updates.last().unwrap()["paused"], true);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn gives_up_when_the_player_exits_without_ipc() {
        let state = follow(&pipe_name("test-missing"), "test-missing", || false, |_| {}).await;
        assert!(state.is_none());
    }
}
