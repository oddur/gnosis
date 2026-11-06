# Writing names and descriptions

Every card on the map shows a **name** and a **description**. The file path and route path are still shown, but in small type underneath. The goal is that someone who has never seen the code can read the board like a system diagram.

This guide covers the names and descriptions in `descriptions/*.json` and the `label` / `summary` of nodes and `project.summary` in `architecture.json`.

## Who you're writing for: `audience`

`architecture.json` has an optional top-level `"audience"`. Each worksheet header repeats it.

- **`"everyone"` (default).** Assume the reader is the owner of the app, not an engineer. Often they built it with AI and don't know how it works inside. Write in **plain language**: what the thing does for the business or its users, in everyday words. Stay specific and accurate. See [Plain language](#plain-language) below.
- **`"developers"`.** The reader is an engineer joining the codebase. Naming frameworks, patterns and mechanics is fine and often useful ("Flask blueprint", "SQLAlchemy model", "Pub/Sub consumer").

Use `"developers"` only when the user asks for it, or the map is plainly for an engineering team (a library, an SDK, infrastructure code). If you're unsure, use `"everyone"`.

## Where they go

`describe.mjs` writes one worksheet per module (`floorplan/.cache/worksheets/<key>.md`) and a matching skeleton (`floorplan/descriptions/<key>.json`):

```json
{
  "files": {
    "api/app/services/inventory_bulk_service.py": { "name": "Bulk stock updates", "description": "Applies stock changes from an uploaded spreadsheet in the background, checking every row before anything changes." }
  },
  "routes": {
    "GET /api/products/<int:product_id>/activity": { "name": "Product history", "description": "Shows who changed a product and when, most recent first." }
  }
}
```

Fill in every `description` and improve every `name`. **Don't change, add or remove keys.** The keys are how `build.mjs` matches entries to files and routes. Keep the JSON valid.

## Names

- 2–5 words in sentence case, naming what the thing *is* or *does* in the business's own words. Short and concrete: "Staff app", "Main server", "Gift cards", "Refunds".
- Don't just restate the filename. `inventory_bulk_service.py` becomes "Bulk stock updates", not "Inventory bulk service". `page.tsx` under `dashboard/products/` becomes "Products page".
- UI components get the name a user would recognise: "Product photo editor", "Discount rules table".
- Tests: "<subject> tests", e.g. "Bulk stock update tests".
- Migrations and scripts say what they do: "Add gift-card balances", "Backfill Stripe customer links".
- Routes are named from the caller's point of view: "Product history", "Mark orders shipped", "Stripe payment alerts".
- Product names stay as they are (Stripe, Shopify, Postgres, SendGrid). People know them, and the glossary in the viewer explains the technical ones.

## Descriptions

- **One sentence, ideally under 140 characters**, present tense, starting with a verb: "Keeps…", "Shows…", "Sends…", "Checks…".
- Say what it's responsible for and anything notable: a side effect (changes prices on Shopify, emails the customer), a constraint (staff only, safe to retry), or a role (the one place X is decided).
- Use concrete domain nouns: "gift card", "pick list", "Shopify listing", not "data", "items", "stuff".
- Don't say "This file…", don't hedge, and don't repeat the name.
- For routes, describe the effect, not the HTTP mechanics. "Marks an order as shipped and emails the customer their tracking link" beats "POST endpoint for shipping".

## Plain language

The default audience is `"everyone"`. Write as if explaining the app to its owner over coffee: they know the business inside out, but not the code.

**You don't need to carry the technical identity.** The real path is printed under every card, and endpoint cards show the method and URL (`POST /api/orders/<id>/ship`). "Show technical detail" in the viewer reveals exports, line counts and developer terms. So the description is free to say only what the thing is *for*.

### Rules

1. **Lead with the job, not the mechanism.** What does it do for staff, customers or the business? "Takes card payments at checkout", not "Stripe Payments API wrapper".
2. **Everyday words.** Swap jargon for the plain phrase in the table below. If a technical word really is the clearest (a "database", a "login"), it's fine. The viewer underlines common terms and explains them on hover.
3. **Keep it specific.** Plain doesn't mean vague. "Handles orders" is plain *and* useless. "Holds an online order's stock while payment is checked, then releases or ships it" is plain and tells you something.
4. **Name the outside services.** "Sends new prices to Shopify and Amazon" beats "Syncs with external channels".
5. **No framework or library names in descriptions** (Flask, SQLAlchemy, React, Radix, Pydantic…) unless the thing exists *because* of that tool. Labels can keep a product name the owner chose and knows (e.g. "Stripe", "Google Cloud").
6. **No counts of code, file names or code identifiers** ("~6.7k lines", "product_routes.py", `ApiClient`) in summaries. Those belong in `annotations` or are shown elsewhere.
7. **Warnings in plain terms.** "Run by hand against live data; double-check before using" rather than "non-idempotent prod script".

### Jargon → plain

| Instead of | Say |
|---|---|
| API | the way programs talk to each other; for your own, "the main server" (e.g. "asks Shippo for shipping rates") |
| endpoint, route (backend) | a request the app can receive (e.g. "the request that marks an order shipped") |
| page, route (frontend) | a screen / page |
| webhook | a message another service sends your app when something happens ("Stripe tells us a payment went through") |
| REST, HTTP, GET/POST | (leave out; the method and URL are already on the card) |
| frontend / client | the app people use / the screens |
| backend / server / service | the main server, the part that does the work behind the screens |
| monolith | one main server that does everything |
| blueprint, router, controller | a group of related requests (e.g. "order requests") |
| middleware | a check every request passes through (e.g. "makes sure you're signed in") |
| ORM model, schema, entity | how a kind of record is stored (e.g. "how an order is stored") |
| table, row | a list of records / a record |
| query | a lookup / a search of the records |
| database (Postgres, MySQL, RDS, Cloud SQL) | the database, where all the records are kept |
| migration | a change to how records are stored (e.g. "adds a place to store gift-card numbers") |
| seed, fixture | sample data for testing |
| worker, background job | a task that runs on its own in the background |
| queue, outbox, Pub/Sub, message bus | a waiting line of tasks / a way to hand work to background tasks |
| cron, scheduler, scheduled job | runs automatically on a timetable (e.g. "every night at 2am") |
| cache, snapshot | a saved copy kept so things load faster |
| SDK, client library, API client | ready-made code for talking to a service (e.g. "talks to Stripe") |
| integration, sync | keeps X and Y in step / copies changes between X and Y |
| env var, config | settings (e.g. "which store and password to use") |
| secret, API key, token | a password for a service / a sign-in pass |
| auth, authentication | sign-in |
| authorization, roles, permissions, RBAC | who is allowed to do what |
| session | staying signed in |
| hook, context, provider (React) | shared screen logic / keeps the screens in step |
| component, UI kit, primitives | a building block of the screens (button, table, dialog) |
| state | what the screen currently remembers |
| deploy, CI/CD | putting a new version live |
| container, Docker, Cloud Run, serverless | where the server runs in the cloud |
| storage bucket, S3, GCS, blob | file storage in the cloud (images, uploads, exports) |
| CDN | a fast delivery network for images and files |
| idempotent | safe to run twice |
| rate limit | a cap on how often something can be asked |
| reconcile | compares two records of the same thing and fixes differences |
| refactor, tech debt | (leave out) |
| MCP server | a connection that lets AI assistants (like Claude) look things up in your app |
| unit tests, test suite | automatic checks that the code still works |

### Examples

**Modules / subsystems (`architecture.json` `summary`)**

| | |
|---|---|
| ✗ | "Flask monolith with route blueprints over a growing service layer and SQLAlchemy models." |
| ✓ | "The main server: the storefront and the admin app both talk to it, and it keeps stock, prices, orders and gift cards in step across Shopify, Stripe and the warehouse." |
| ✗ | "Radix-based primitives (components/ui) and the dashboard shell." |
| ✓ | "The shared building blocks of every screen: buttons, tables, dialogs, and the menu and frame around the staff app." |
| ✗ | "Long-running Cloud Run workers: bulk inventory, pricing, abandoned-cart emails, Stripe reconcile." |
| ✓ | "Tasks that run on their own in the background or on a timetable: big stock uploads, price changes, abandoned-cart emails and the nightly Stripe payout check." |

**Files (`descriptions/*.json`)**

| | |
|---|---|
| ✗ | name "Stripe gift card service", "Wraps the Stripe customer balance API for ledger projection." |
| ✓ | name "Gift card balances", "Keeps each customer's gift-card balance in Stripe matching the balance the shop shows them." |
| ✗ | name "useAuth context", "React context provider exposing auth state and token refresh." |
| ✓ | name "Staff sign-in", "Remembers which staff member is signed in, keeps them signed in, and hides the dashboard from everyone else." |
| ✗ | name "Order lock", "Postgres advisory lock keyed by Shopify order id." |
| ✓ | name "One order at a time", "Stops the same online order being processed twice when Shopify sends duplicate alerts." |

**Routes (endpoints)**

| | |
|---|---|
| ✗ | name "POST ship", "POST endpoint that transitions an order to shipped." |
| ✓ | name "Mark order shipped", "Marks an order as shipped and emails the customer their tracking link." |
| ✗ | name "Stripe webhook", "Receives and signature-checks Stripe webhook payloads." |
| ✓ | name "Stripe alerts", "Stripe calls this when a payment, refund or dispute changes; it checks the message is genuine and queues it." |

For `"developers"`, the ✗ column is closer to right (minus the filler). Same rules otherwise: one sentence, verb first, specific.

## How to work

1. Read the worksheet. It lists each file's definitions, docstrings, what it uses and what uses it, and each route's handler. That's enough for most files.
2. Open the file (the top ~80 lines, or the specific handler) only when the digest leaves the purpose unclear. Generic names (`utils.py`, `index.ts`, `common.py`) and big files usually need a look.
3. Write the JSON in one go per worksheet, in the style the worksheet's `Audience:` line asks for.
4. Be consistent within a module: sibling files should read as a set.

## Quality bar

A good description lets someone pick the right file to open without opening the others. If two siblings end up with nearly identical descriptions, find what actually distinguishes them and say that. For `"everyone"`, also check: would the owner understand every word without asking?
