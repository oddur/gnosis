pub fn parse(s: &str) -> i32 {
    s.parse().unwrap_or(0)
}

pub fn validate(s: &str) -> bool {
    !s.is_empty()
}
