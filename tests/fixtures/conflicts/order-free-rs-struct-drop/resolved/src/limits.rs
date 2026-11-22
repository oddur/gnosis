pub struct Limits {
    pub width: u32,
    pub height: u32,
    pub log: Flusher,
    pub lock: Guard,
}

impl Limits {
    pub fn wide(&self) -> bool {
        self.width > 80
    }
}
