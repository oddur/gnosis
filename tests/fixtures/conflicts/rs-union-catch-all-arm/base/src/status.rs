pub fn status(s: &str) -> u16 {
    match s {
        "ok" => 200,
        "missing" => 404,
    }
}
