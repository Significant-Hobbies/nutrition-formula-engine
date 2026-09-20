# Design direction

## Selected system

**Clear Compliance Desk** — a restrained, conventional professional workspace
for submitting one formula, correcting identity exceptions, and reading a dense
composition report without decorative interface complexity.

## Primary workflow

1. Paste a formula or choose one common text, spreadsheet, image, or PDF file.
2. Select **Prepare formula for review**.
3. Correct the recovered `Item / Quantity / Unit` rows and confirm the draft.
4. Review only the ingredient identities needing attention.
5. Confirm, reject, or search for another identity.
6. See the present-components result update immediately on the same page.

There are no upload tabs, input-mode selectors, dashboards, or setup wizard.

## Layout

- One centered workspace with a clear product title and brief instruction.
- A single large paste area is the dominant control above the fold.
- The editable recovered formula appears before calculation.
- The macro/micronutrient result follows, then assumptions and missing evidence.
- Uncertain rows expand inline; corrections do not open a separate workflow.
- On narrow screens, tables become labelled stacked rows without hiding units,
  ranges, source status, or decision actions.

## Visual language

- Neutral white and soft gray surfaces with dark slate text.
- A single accessible blue action colour.
- Amber is reserved for assumptions; red is reserved for unresolved or invalid
  inputs; green is reserved for a user-confirmed identity.
- System typography, modest radii, thin borders, and compact table spacing.
- No gradients, glass effects, decorative illustrations, or dashboard tiles.

## Interaction rules

- **Confirm** applies a candidate and recalculates.
- **Reject** removes that candidate from the current line's suggestions.
- **Search alternatives** opens one inline search field on that row.
- Every recalculation shows what changed and provides Undo.
- Colour is never the only status signal; every status has visible text.
- Keyboard focus order follows input, recovered-row review, unresolved rows, result, and
  export actions.

## Result hierarchy

1. Submitted formula with normalized equivalents and interpretation
2. Non-zero macro- and micronutrients. Screened zero results remain in the
   machine-readable calculation and are available to a future regulatory view.
3. Other chemicals/materials when present
4. Assumptions, alternatives, and evidence still required

A nutrient with no identified contribution must be labelled `Not established`
when unresolved ingredient profiles could contain it. Coverage is summarized
once above the result rather than repeated as open-ended zero ranges.
