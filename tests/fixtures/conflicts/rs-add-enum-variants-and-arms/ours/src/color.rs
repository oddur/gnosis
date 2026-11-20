#[derive(Debug, Clone, Copy)]
pub enum Color {
    Red,
    Green,
    Blue,
}

pub fn name(c: Color) -> &'static str {
    match c {
        Color::Red => "red",
        Color::Green => "green",
        Color::Blue => "blue",
    }
}
