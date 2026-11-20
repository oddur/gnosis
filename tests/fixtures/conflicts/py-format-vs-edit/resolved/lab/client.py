def connect(host, port, timeout, retries):
    return Client(
        host=host,
        port=port,
        timeout=timeout or 30,
        retries=retries,
    )
