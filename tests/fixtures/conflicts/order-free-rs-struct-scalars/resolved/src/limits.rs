#[derive(Clone, Copy, PartialEq, Default)]
pub struct Limits {
    pub width: u32,
    pub height: u32,
    pub depth: u32,
    pub margin: u16,
    pub ratio: f64,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
