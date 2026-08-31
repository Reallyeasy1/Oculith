# Latch landing page

A small static landing page: `index.html` + `styles.css`, built into `dist/` by
`npm run build` (that is what the preview serves), checked by `npm test`.

Conventions for working here:

- Run commands one at a time from the workspace root (plain `npm test`, `npm run build`);
  do not chain them with `&&` or run them from subdirectories.
- The primary CTA button keeps its id (`cta`), its text ("Get started"), its accessible
  name, and its click behavior. Style changes are welcome; behavior changes are not.
- `npm test` is the definition of done: it checks the campaign design gate, text contrast,
  button behavior, and that `dist/` is freshly built. Run `npm run build` and `npm test`
  before replying.
