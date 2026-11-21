export function fetchUser(id: string) {
  const url = `/users/${id}`;
  return request(url, { retries: 3 }, 'json');
}

export function bye() {
  return 'bye';
}
