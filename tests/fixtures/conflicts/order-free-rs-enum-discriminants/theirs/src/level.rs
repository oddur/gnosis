#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Level {
    Low = 1,
    High = 9,
    Critical = 12,
}

pub fn is_high(level: Level) -> bool {
    level as u8 >= 5
}
