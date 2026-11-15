# Comment format check[^c-h1]

The quarterly numbers[^c-7f3a] look good, and the forecast is stable.

A sentence with a real footnote[^1] and a second comment on "forecast"[^c-91bd].

| Region | Value |
| --- | --- |
| North[^c-t1] | 12 |
| South | 14 |

```js
const x = 1; // a comment on code cannot carry a mark
```

[^1]: A real footnote with a source.

[^c-7f3a]: 💬 on "quarterly numbers"

    - **@alice** · 2026-11-14 10:32 — Where do these come from?
    - **@bob** · 2026-11-14 11:02 — From the Q3 controlling export. @alice

[^c-91bd]: 💬 on "forecast"

    - **@carol** · 2026-11-14 12:00 — Is this the March or the June forecast?

[^c-t1]: 💬 on "North"

    - **@dave** · 2026-11-14 12:05 — Does North include the islands?

[^c-h1]: 💬 on "Comment format check"

    - **@erin** · 2026-11-14 12:06 — Heading comment.

[^c-0c0d]: 💬 on "const x = 1;"

    - **@frank** · 2026-11-14 12:07 — Thread whose mark is missing (code block).

[^c-tight]: 💬 on "tight variant"
    - **@gina** · 2026-11-14 12:08 — No blank line after the first line.
