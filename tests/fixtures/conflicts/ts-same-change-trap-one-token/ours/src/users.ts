export function fetchUser(id: string) {
  const url = `/users/${id}`;
  return request(
    url,
    { retries: 3, cache: true },
    'json'
  );
}

export function bye() {
  return 'bye';
}
