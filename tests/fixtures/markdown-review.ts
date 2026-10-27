export const markdownBefore = `# Retry failed requests

The client retries a request **three times** before it returns an error. The delay increases after each attempt.

## Connection setup

Open a connection before sending a request.

Use the configured endpoint.

Keep credentials outside the request log.

Close idle connections after the timeout.

Reuse healthy connections for later requests.

Record connection failures separately.

## Retry policy

- Retry transient connection errors.
- Stop after three attempts.
- Keep the request ID between attempts.

| Setting | Value | Purpose |
| --- | --- | --- |
| Attempts | 3 | Bound the retry loop |
| Delay | 100 ms | Give the service time to recover |

Read [the retry guide](./old-guide.md) before changing the policy.

\`\`\`typescript
const attempts = 3;
await retry(request, { attempts });
\`\`\`

## Recovery

A failed request stays in the queue until the next connection.

## Monitoring

Record the final attempt in the request log.
`;
export const markdownAfter = `# Retry failed requests

The client retries a request **five times** before it returns an error. The delay increases after each attempt.

## Connection setup

Open a connection before sending a request.

Use the configured endpoint.

Keep credentials outside the request log.

Close idle connections after the timeout.

Reuse healthy connections for later requests.

Record connection failures separately.

## Retry policy

- Retry transient connection errors.
- Stop after five attempts.
- Keep the request ID between attempts.
- Cancel the retry when the caller disconnects.

| Setting | Value | Purpose |
| --- | --- | --- |
| Attempts | 5 | Bound the retry loop |
| Delay | 250 ms | Give the service time to recover |

Read [the retry guide](./retry-guide.md) before changing the policy.

\`\`\`typescript
const attempts = 5;
await retry(request, { attempts });
\`\`\`

## Monitoring

Record the final attempt in the request log.

## Recovery

A failed request stays in the queue until the next connection.

> Cancellation stops future attempts. It does not undo a request that already reached the server.
`;
export const markdownFiles = [
  { path: 'docs/retry.md', status: 'modified' as const, additions: 10, deletions: 6, changeId: 'markdown-review-v1' },
  { path: 'docs/new.md', status: 'added' as const, additions: 5, deletions: 0, changeId: 'markdown-new-v1' },
  { path: 'docs/removed.md', status: 'deleted' as const, additions: 0, deletions: 5, changeId: 'markdown-removed-v1' },
];
