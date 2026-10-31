//! Calendar arithmetic without a dependency: UTC timestamps for log lines and backup names.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub fn now() -> Duration {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
}

/// `(year, month, day)` of a day count since 1970-01-01 (Howard Hinnant's civil-from-days).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn iso(at: Duration) -> String {
    let seconds = at.as_secs();
    let (year, month, day) = civil((seconds / 86_400) as i64);
    let rest = seconds % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        at.subsec_millis()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(iso(Duration::from_secs(0)), "1970-01-01T00:00:00.000Z");
        // 2024-02-29 12:34:56.789 UTC
        assert_eq!(
            iso(Duration::from_millis(1_709_210_096_789)),
            "2024-02-29T12:34:56.789Z"
        );
        assert_eq!(civil(19_723), (2024, 1, 1));
    }
}
