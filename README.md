# Finch

Public thin-client app for Finch.

## Deployment posture

Finch is a public product surface, not a private operator dashboard.

That means:

- the install site and app UI stay public
- customer-facing API routes remain reachable through the product domain
- raw infrastructure URLs should not be exposed in browser code
- browser code should prefer same-origin API calls or a branded API hostname

## Frontend API rule

Do not hardcode `workers.dev` URLs in client JavaScript.

Finch now resolves its API base in this order:

1. `window.__FINCH_API_BASE__`
2. `<meta name="finch-api-base" content="...">`
3. same-origin `window.location.origin`

That keeps Finch public for users while hiding the raw worker hostname from the app surface.
