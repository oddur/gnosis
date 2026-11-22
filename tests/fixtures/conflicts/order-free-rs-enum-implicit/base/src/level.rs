#[derive(Debug, Clone, Copy)]
pub enum Level {
    Low,
    High,
}

pub fn is_high(level: Level) -> bool {
    level as u8 >= 5
}
