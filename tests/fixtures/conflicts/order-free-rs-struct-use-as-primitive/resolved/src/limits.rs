use crate::guard::Guard as u8;

pub struct Limits {
    pub width: u32,
    pub height: u32,
    pub depth: u8,
    pub flag: bool,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
