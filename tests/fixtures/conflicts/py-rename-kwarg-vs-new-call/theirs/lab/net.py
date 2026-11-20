def fetch(url, retries=3):
    return http.get(url, retries=retries)


def fetch_twice(url):
    return fetch(url, retries=2)
