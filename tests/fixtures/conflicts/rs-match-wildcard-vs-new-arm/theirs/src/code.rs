pub fn code(s: &str) -> u16 {
    match s {
        "ok" => 200,
        "missing" => 404,
        "denied" => 403,
    }
}
