ROUTES = {
    "/health": "health",
    "/api/v2/": "api_v2",
    "/api/": "api",
}


def route(path):
    for prefix, name in ROUTES.items():
        if path.startswith(prefix):
            return name
    return None
