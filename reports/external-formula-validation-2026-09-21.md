# External Formula Validation — 2026-09-21

## Outcome

Four additional public formulas were added to the validation suite. All twelve
newly asserted targets pass their stated tolerances. The complete local suite
now covers 15 public formulas, 37 engine/API tests, and 19 browser/data tests.

These results validate formula parsing, exact decimal unit conversion,
stoichiometric expansion, final-volume normalization, and reference-food macro
calculation. They do not validate an unknown supplier lot, laboratory assay,
manufacturing process, clinical performance, or regulatory acceptance.

## New results

| Public formula | Target | Declared | Predicted | Absolute difference |
| --- | --- | ---: | ---: | ---: |
| Plasma-Lyte A | Sodium | 140 mEq/L | 140.0625 mEq/L | 0.045% |
| Plasma-Lyte A | Potassium | 5 mEq/L | 4.9631 mEq/L | 0.738% |
| Plasma-Lyte A | Magnesium | 3 mEq/L | 2.9513 mEq/L | 1.623% |
| Plasma-Lyte A | Chloride | 98 mEq/L | 97.9213 mEq/L | 0.080% |
| Plasma-Lyte A | Acetate | 27 mEq/L | 27.0429 mEq/L | 0.159% |
| Plasma-Lyte A | Gluconate | 23 mEq/L | 23.0127 mEq/L | 0.055% |
| Sodium Bicarbonate Injection 8.4% | Sodium | 1 mEq/mL | 0.9999 mEq/mL | 0.008% |
| Sodium Bicarbonate Injection 8.4% | Bicarbonate | 1 mEq/mL | 0.9999 mEq/mL | 0.008% |
| WHO F-75 no-cereal recipe | Energy | 75 kcal/100 mL | 71.518 kcal/100 mL | 4.643% |
| WHO F-75 no-cereal recipe | Protein | 0.9 g/100 mL | 0.8775 g/100 mL | 2.500% |
| WHO F-100 recipe | Energy | 100 kcal/100 mL | 101.03 kcal/100 mL | 1.030% |
| WHO F-100 recipe | Protein | 2.9 g/100 mL | 2.808 g/100 mL | 3.172% |

The therapeutic-milk differences are expected because the engine uses named
USDA reference-food profiles rather than back-solving ingredient profiles from
the WHO finished-product targets. Both recipes stay within the explicit 5%
validation envelope for energy and protein.

## Sources and retrieval reconciliation

- DailyMed Plasma-Lyte A set ID
  `6ec9e61c-2c26-402f-8604-f446b2e34058`. A targeted API search returned two
  records on one page; the human Baxter label was selected and the veterinary
  label excluded.
- DailyMed Sodium Bicarbonate Injection set ID
  `9545d58c-1c49-79b3-e053-2995a90a9d40`. A broad API search reported 306
  records; only the first five were retrieved because this was a targeted
  set-ID validation, not a complete product census. The official label page
  supplied the declared composition.
- WHO *Management of severe malnutrition: a manual for physicians and other
  senior health workers* supplied the F-75/F-100 recipes and finished-product
  energy/protein targets.
- USDA FoodData Central FDC 171272, 169655, and 172336 supplied the dried skim
  milk, sugar, and canola-oil reference profiles.
- PubChem PUG REST returned one property record for each requested compound:
  CID 516892, 23672301, 23665404, and 24644. Four requested, four retrieved,
  no pagination or local filtering.

## Replay

```bash
PYTHONPATH=src uv run python -m unittest tests.test_public_products -v
pnpm check
```

The complete project verification is:

```bash
PYTHONPATH=src uv run python -m unittest discover -s tests -v
uvx ruff check src tests
pnpm check
pnpm build
```
