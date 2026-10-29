//! VLC as an external player. VLC has no IPC like MPV's, so Vela turns on its HTTP interface on a
//! free local port, with the session id as password, and reads `/requests/status.json` while it
//! runs. Checked with VLC 3.0.23: `--start-time`, `:meta-title`, subtitle URLs through
//! `--input-slave` (VLC ignores URLs in `--sub-file`), and `subtitle_track=-1` to hide them. VLC
//! closes when asked for a subtitle track that does not exist, so no other track is selected.

use crate::mpv::Playback;
use std::path::Path;
use std::time::Duration;

pub fn is_vlc(executable: &Path) -> bool {
    executable
        .file_stem()
        .and_then(|stem| stem.to_str())
        .is_some_and(|stem| stem.eq_ignore_ascii_case("vlc"))
}

/// A free port for VLC's HTTP interface. The listener is released before VLC binds it.
pub fn free_port() -> Option<u16> {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .ok()
}

/// Options placed before the media URL.
pub fn arguments(
    interface: Option<(u16, &str)>,
    start: Option<f64>,
    subtitles: &[String],
) -> Vec<String> {
    let mut arguments = vec!["--no-one-instance".to_owned(), "--play-and-exit".to_owned()];
    if let Some((port, password)) = interface {
        arguments.extend([
            "--extraintf=http".to_owned(),
            "--http-host=127.0.0.1".to_owned(),
            format!("--http-port={port}"),
            format!("--http-password={password}"),
        ]);
    }
    if let Some(start) = start.filter(|value| value.is_finite() && *value >= 1.0) {
        arguments.push(format!("--start-time={start:.1}"));
    }
    // `#` separates slaves, so it must not appear inside a URL (it would be a fragment anyway).
    let slaves: Vec<String> = subtitles
        .iter()
        .filter(|url| url.len() <= 2048)
        .filter_map(|url| crate::transport::checked_url(url).ok())
        .map(|mut url| {
            url.set_fragment(None);
            url.to_string()
        })
        .filter(|url| !url.contains('#'))
        .take(10)
        .collect();
    if !slaves.is_empty() {
        arguments.push(format!("--input-slave={}", slaves.join("#")));
    }
    arguments
}

/// Options placed after the media URL, which VLC applies to that item.
pub fn item_options(title: Option<&str>) -> Vec<String> {
    title
        .map(|title| {
            title
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect::<String>()
        })
        .filter(|title| !title.trim().is_empty())
        .map(|title| vec![format!(":meta-title={title}")])
        .unwrap_or_default()
}

/// Reads one `status.json` answer into the state shared with MPV sessions.
pub fn read_status(value: &serde_json::Value) -> Option<Playback> {
    let state = value["state"].as_str()?;
    let length = value["length"].as_f64().filter(|length| *length > 0.0);
    // `time` is in whole seconds; `position` (0–1) gives a finer value when the length is known.
    let position = match (length, value["position"].as_f64()) {
        (Some(length), Some(fraction)) if (0.0..=1.0).contains(&fraction) => {
            Some(fraction * length)
        }
        _ => value["time"].as_f64(),
    };
    Some(Playback {
        position,
        duration: length,
        paused: state == "paused",
        eof: matches!((position, length), (Some(position), Some(length)) if length - position <= 1.5),
        end_reason: None,
    })
}

/// Folds one `status.json` answer into the last known state and returns the reading to report.
/// When a video ends, `--play-and-exit` makes VLC report `stopped` with time and length 0 just
/// before closing; that answer must not replace the real position, it marks the end instead.
fn advance(last: &mut Option<Playback>, value: &serde_json::Value) -> Option<Playback> {
    if value["state"] == "stopped" {
        if let Some(state) = last.as_mut()
            && let (Some(position), Some(duration)) = (state.position, state.duration)
            && duration - position <= (duration * 0.05).max(10.0)
        {
            state.eof = true;
        }
        return None;
    }
    let reading = read_status(value)?;
    reading.position?;
    // Before the media is open VLC reports no length; such readings say nothing useful.
    reading.duration?;
    *last = Some(reading.clone());
    Some(reading)
}

/// Polls VLC while `alive` holds and calls `progress` with each reading. Hides the subtitles once
/// playback starts unless `show` is set. Returns the last state, or `None` if VLC never answered.
pub async fn follow(
    port: u16,
    password: &str,
    session: &str,
    hide_subtitles: bool,
    mut alive: impl FnMut() -> bool,
    mut progress: impl FnMut(serde_json::Value),
) -> Option<Playback> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .ok()?;
    let status = format!("http://127.0.0.1:{port}/requests/status.json");
    let mut last: Option<Playback> = None;
    let mut hidden = !hide_subtitles;
    while alive() {
        let answer = client
            .get(&status)
            .basic_auth("", Some(password))
            .send()
            .await
            .ok()
            .filter(|response| response.status().is_success());
        if let Some(response) = answer
            && let Ok(value) = response.json::<serde_json::Value>().await
        {
            if !hidden && value["state"] == "playing" {
                hidden = client
                    .get(format!("{status}?command=subtitle_track&val=-1"))
                    .basic_auth("", Some(password))
                    .send()
                    .await
                    .is_ok();
            }
            if let Some(reading) = advance(&mut last, &value) {
                progress(reading.to_json(session));
            }
        }
        tokio::time::sleep(Duration::from_millis(if last.is_some() {
            2000
        } else {
            500
        }))
        .await;
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_vlc_and_builds_its_arguments() {
        assert!(is_vlc(Path::new("C:/Program Files/VideoLAN/VLC/vlc.exe")));
        assert!(!is_vlc(Path::new("C:/mpv/mpv.exe")));
        let subtitles = vec![
            "https://subs.example/a b.srt#frag".to_owned(),
            "file:///C:/x.srt".to_owned(),
            "http://127.0.0.1:11470/sub.vtt".to_owned(),
        ];
        assert_eq!(
            arguments(Some((9851, "abc")), Some(95.04), &subtitles),
            vec![
                "--no-one-instance",
                "--play-and-exit",
                "--extraintf=http",
                "--http-host=127.0.0.1",
                "--http-port=9851",
                "--http-password=abc",
                "--start-time=95.0",
                "--input-slave=https://subs.example/a%20b.srt#http://127.0.0.1:11470/sub.vtt",
            ]
        );
        assert_eq!(arguments(None, Some(0.5), &[]).len(), 2);
        assert_eq!(
            item_options(Some("Serie · E1\n")),
            vec![":meta-title=Serie · E1"]
        );
        assert!(item_options(Some("  ")).is_empty());
    }

    #[test]
    fn reads_status_answers() {
        let playing =
            serde_json::json!({ "state": "playing", "time": 9, "length": 25, "position": 0.376 });
        let state = read_status(&playing).unwrap();
        assert!((state.position.unwrap() - 9.4).abs() < 0.01);
        assert_eq!(state.duration, Some(25.0));
        assert!(!state.paused && !state.eof);
        let end =
            serde_json::json!({ "state": "playing", "time": 24, "length": 25, "position": 0.98 });
        assert!(read_status(&end).unwrap().eof);
        let paused =
            serde_json::json!({ "state": "paused", "time": 3, "length": 0, "position": 0 });
        let state = read_status(&paused).unwrap();
        assert_eq!(
            (state.position, state.duration, state.paused),
            (Some(3.0), None, true)
        );
        assert!(read_status(&serde_json::json!({})).is_none());
    }

    #[test]
    fn keeps_the_last_position_and_marks_the_end_when_vlc_stops() {
        let mut last = None;
        // Opening: no length yet.
        assert!(
            advance(
                &mut last,
                &serde_json::json!({ "state": "playing", "time": 0, "length": 0, "position": 0 })
            )
            .is_none()
        );
        let reading = advance(
            &mut last,
            &serde_json::json!({ "state": "playing", "time": 22, "length": 25, "position": 0.88 }),
        );
        assert!(reading.is_some() && !last.as_ref().unwrap().eof);
        // `--play-and-exit` at the end of the file.
        assert!(
            advance(
                &mut last,
                &serde_json::json!({ "state": "stopped", "time": 0, "length": 0, "position": 0 })
            )
            .is_none()
        );
        let state = last.unwrap();
        assert!(
            state.eof
                && (state.position.unwrap() - 22.0).abs() < 0.01
                && state.duration == Some(25.0)
        );
        // Stopped far from the end (the user stopped it): not an end.
        let mut last = None;
        advance(
            &mut last,
            &serde_json::json!({ "state": "playing", "time": 600, "length": 3000, "position": 0.2 }),
        );
        advance(
            &mut last,
            &serde_json::json!({ "state": "stopped", "time": 0, "length": 0, "position": 0 }),
        );
        assert!(!last.unwrap().eof);
    }
}
