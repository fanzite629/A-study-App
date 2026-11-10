# Dev fixtures (not production art)

- `test-pack/` — **development test material only**. `idle.png` is a placeholder used to exercise loading, hit-testing and dragging; `focus.png` is the same image in grayscale so state switching is visible in tests. It is **not** the T计划 character and must not be extended or shipped.
- `broken-pack/` — a pack whose idle image is missing; used to verify that a failed load reports a clear error and keeps the previous pack.

Run with the test pack: `npm run start:testpack`.
