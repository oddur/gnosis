#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub enum Level {
    Low = 1,
    High = 9,
}

pub fn is_high(level: Level) -> bool {
    level as u8 >= 5
}
