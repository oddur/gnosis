#[derive(Debug, Clone, Copy)]
pub enum Color {
    Red,
    Green,
    Blue,
    Yellow,
}

pub fn name(c: Color) -> &'static str {
    match c {
        Color::Red => "red",
        Color::Green => "green",
        Color::Blue => "blue",
        Color::Yellow => "yellow",
    }
}
