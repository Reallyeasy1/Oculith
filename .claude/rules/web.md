---
paths:
  - "apps/web/**"
---

# Web conventions (`@launchpad/web`)

- **Stay inside the existing shell.** `App.tsx` is one component file by design; add the policy panel, approval card and evidence list as small components in `apps/web/src/` and mount them in the existing Agent detail / Run areas. No new routes, navigation, or dashboards.
- **No new dependencies.** React 19 + Vite + plain CSS. Reuse `styles.css` tokens and existing class patterns (`config-banner`, `error-banner`, etc.).
- **All API calls go through `api.ts`'s `request()`** so the bearer token and error mapping apply. Add typed methods there.
- **`types.ts` mirrors the server's public types by hand** — change both sides in the same commit.
- **Polling already exists** for Run status; hook approval and event fetches into that loop rather than adding timers.
- **UI never decides authority.** Buttons call backend endpoints (`approve`, `reject`, `revoke`) and re-render from the response; the UI must render a denial the backend returned even if a local state said "approved".
- **Render redacted data only.** Never display raw parameters or downstream errors; show `parameterSummary`, `reasonCode`, target class, hashes.
- Keep it keyboard-usable: buttons are `<button>`, cards have headings, status is text as well as colour.
