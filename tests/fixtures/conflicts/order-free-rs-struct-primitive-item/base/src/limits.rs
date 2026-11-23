pub struct u8(String);

pub struct Limits {
    pub width: u32,
    pub height: u32,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
