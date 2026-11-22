#[derive(Debug, Clone, PartialEq)]
pub struct Limits {
    pub width: u32,
    pub height: u32,
    pub ratio: f64,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
