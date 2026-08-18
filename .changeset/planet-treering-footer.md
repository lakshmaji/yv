---
"yv": patch
---

Docs site: give the hero planet round tree canopies in two rings (one behind
the disc, one in front) instead of a single flat ring, gradient-shade the
continents and foliage from the same light corner as the rest of the scene,
and replace the orbiting cloud puffs with cloud sheets that lie on the surface
and are clipped to the disc. Move the footer wordmark back into the normal
layout flow instead of an absolutely-positioned background watermark.

Also turns off rspack's persistent cache in the Docusaurus `faster` config —
it was aborting the build mid-run (`should have bucket pack metas`,
`write_scope.rs`); the rest of `faster` (swc, lightningcss, rspack itself)
stays on.
