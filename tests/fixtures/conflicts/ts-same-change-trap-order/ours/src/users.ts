export function fetchUser(id: string) {
  const url = `/users/${id}`;
  return request(
    url,
    'json',
    { retries: 3 }
  );
}

export function bye() {
  return 'bye';
}
