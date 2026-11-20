def fetch(url, attempts=3):
    return http.get(url, attempts=attempts)
