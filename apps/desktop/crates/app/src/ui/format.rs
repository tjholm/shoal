use std::time::{Duration, SystemTime};

/// A wall-clock time in the local time zone: "3:45 PM", with the weekday if
/// it isn't today.
pub fn clock(time: SystemTime) -> String {
    let zone = jiff::tz::TimeZone::system();
    let (Ok(time), Ok(now)) =
        (jiff::Timestamp::try_from(time), jiff::Timestamp::try_from(SystemTime::now()))
    else {
        return "later".to_owned();
    };
    let (time, now) = (time.to_zoned(zone.clone()), now.to_zoned(zone));
    if time.date() == now.date() {
        time.strftime("%-I:%M %p").to_string()
    } else {
        time.strftime("%a %-I:%M %p").to_string()
    }
}

/// "45s", "3m 05s", "1h 02m".
pub fn elapsed(duration: Duration) -> String {
    let secs = duration.as_secs();
    match secs {
        0..60 => format!("{secs}s"),
        60..3600 => format!("{}m {:02}s", secs / 60, secs % 60),
        _ => format!("{}h {:02}m", secs / 3600, secs % 3600 / 60),
    }
}

/// "940", "31.2k", "4.1M".
#[expect(clippy::cast_precision_loss, reason = "display precision only")]
pub fn count(n: u64) -> String {
    match n {
        0..1_000 => n.to_string(),
        1_000..1_000_000 => format!("{:.1}k", n as f64 / 1e3),
        _ => format!("{:.1}M", n as f64 / 1e6),
    }
}

/// Tokens per second, or `None` until there's enough to measure.
#[expect(clippy::cast_precision_loss, reason = "token counts are far below 2^52")]
pub fn rate(tokens: u64, duration: Duration) -> Option<String> {
    let secs = duration.as_secs_f64();
    (tokens > 1 && secs >= 0.5).then(|| format!("{:.1} tok/s", tokens as f64 / secs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations_read_naturally() {
        assert_eq!(elapsed(Duration::from_secs(45)), "45s");
        assert_eq!(elapsed(Duration::from_secs(185)), "3m 05s");
        assert_eq!(elapsed(Duration::from_mins(62)), "1h 02m");
        assert_eq!(rate(84, Duration::from_secs(2)), Some("42.0 tok/s".into()));
        assert_eq!(rate(1, Duration::from_secs(2)), None);
        assert_eq!(
            (count(940), count(31_240), count(4_100_000)),
            ("940".into(), "31.2k".into(), "4.1M".into())
        );
    }
}
