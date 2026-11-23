ROUTES = {
    "/health": "health",
    "/api/": "api",
}


def route(path):
    for prefix, name in ROUTES.items():
        if path.startswith(prefix):
            return name
    return None
