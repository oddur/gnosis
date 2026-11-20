def connect(host, port, timeout, retries):
    return Client(host=host, port=port, timeout=timeout, retries=retries)
