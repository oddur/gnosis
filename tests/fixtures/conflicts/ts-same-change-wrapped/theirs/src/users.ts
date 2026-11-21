export function fetchUser(id: string) {
  const url = `/users/${id}`;
  return request(url, { retries: 3, timeout: 5000 }, 'json');
}

export function bye() {
  return 'bye';
}
