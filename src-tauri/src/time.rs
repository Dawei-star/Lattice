//! 极简时间工具：把 Unix 毫秒格式化成 ISO-8601 UTC 字符串。
//!
//! 说明：架构说明书要求「所有时间统一存 ISO-8601 UTC 字符串，便于跨时区与排序」。
//! 这里刻意不引入 `chrono`/`time` 等依赖 —— 需要的只是把 epoch 毫秒转成
//! `YYYY-MM-DDTHH:MM:SS.mmmZ`，用 days-from-civil 的逆运算即可，几行代码换掉一个依赖树。

use std::time::{SystemTime, UNIX_EPOCH};

/// 当前时间的 Unix 毫秒。系统时钟早于 1970 时返回 0，不 panic。
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 把 Unix 毫秒格式化为 ISO-8601 UTC 字符串（如 `2026-10-13T08:30:00.000Z`）。
pub fn iso8601_utc(millis: i64) -> String {
    let total_seconds = millis.div_euclid(1000);
    let milliseconds = millis.rem_euclid(1000);
    let days = total_seconds.div_euclid(86_400);
    let seconds_of_day = total_seconds.rem_euclid(86_400);

    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{milliseconds:03}Z")
}

/// Howard Hinnant 的 `civil_from_days`：把「1970-01-01 起的天数」还原成公历年月日。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = (shifted - era * 146_097) as u64;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era as i64 + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_prime + 2) / 5 + 1) as u32;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::iso8601_utc;

    #[test]
    fn formats_epoch_millis_as_iso8601_utc() {
        assert_eq!(iso8601_utc(0), "1970-01-01T00:00:00.000Z");
        // 2026-10-13T08:30:00.250Z
        assert_eq!(iso8601_utc(1_791_880_200_250), "2026-10-13T08:30:00.250Z");
        // 闰日与跨年边界
        assert_eq!(iso8601_utc(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(iso8601_utc(1_767_225_600_000), "2026-01-01T00:00:00.000Z");
    }

    #[test]
    fn handles_pre_epoch_millis_without_panicking() {
        // 1969-12-31T23:59:59.999Z：div_euclid/rem_euclid 保证不 panic
        assert_eq!(iso8601_utc(-1), "1969-12-31T23:59:59.999Z");
    }
}
