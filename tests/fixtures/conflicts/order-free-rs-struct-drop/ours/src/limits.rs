pub struct Limits {
    pub width: u32,
    pub height: u32,
    pub log: Flusher,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
