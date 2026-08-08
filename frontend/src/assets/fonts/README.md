# Electroharmonix

Latin letters drawn as katakana. Used for the splash wordmark only — the word
stays English, only the hand changes.

- Source: https://www.1001fonts.com/electroharmonix-font.html
- Licence: **public domain**, free for personal and commercial use.
- Original: `Electroharmonix.otf`, 25.4 KB, 387 glyphs.

`electroharmonix.otf` here is a **subset**: `U+0020-007E` (printable ASCII),
desubroutinized, hinting stripped — 9.8 KB. Subsetting rather than shipping the
whole face because it draws exactly one word; kept at full ASCII rather than the
two glyphs actually used so that changing the wordmark does not silently produce
tofu.

Regenerate with:

    pyftsubset Electroharmonix.otf --unicodes="U+0020-007E" \
      --output-file=electroharmonix.otf --desubroutinize --no-hinting

OTF rather than WOFF2 only because `fontTools` here had no `brotli` module. WOFF2
would be roughly half the size and is a safe swap if the tooling is available —
the `@font-face` in styles.css is the only thing that would need to change.
