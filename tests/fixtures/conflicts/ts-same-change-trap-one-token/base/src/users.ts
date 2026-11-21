export function fetchUser(id: string) {
  const url = `/users/${id}`;
  return request(url, { retries: 2, cache: true }, 'json');
}

export function bye() {
  return 'bye';
}
