#[derive(Debug, Clone, Copy)]
pub enum Color {
    Red,
    Green,
}

pub fn name(c: Color) -> &'static str {
    match c {
        Color::Red => "red",
        Color::Green => "green",
    }
}
