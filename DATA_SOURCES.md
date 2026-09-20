# Validation data sources

The example catalog is intentionally small. It proves calculation and data
quality behavior; it is not intended to be a comprehensive ingredient database.

## Frozen pilot benchmark

`benchmarks/manifest.json` separates quality evidence by failure stage instead
of blending OCR, identity, and arithmetic into one accuracy number. It contains
20 deterministic extraction cases, 20 local identity-ranking cases, and 26
independently published calculation cases. The recorded thresholds are 100%
exact extraction for the frozen fixtures, 100% expected top candidate for the
identity fixtures, and no more than 5% difference for each published
calculation target. These are regression thresholds, not regulatory release
limits or laboratory uncertainty claims.

## USDA FoodData Central reference profiles

- Granulated sugar — FDC 169655
- Instant nonfat dry milk with added vitamins A and D — FDC 171272
- Unsweetened cocoa powder — FDC 169593
- Canola oil — FDC 172336

The recorded nutrient values are expressed per 100 g. They are reference-food
values, not substitutes for a manufacturer's current specification or lot CoA.

## Calculation-validation specifications

The electrolyte salts, ascorbic acid, and whey protein isolate use clearly
labelled validation-only supplier-style specifications. They exist to exercise
unit conversion, micronutrient addition, incomplete supplier data, and
provenance reporting. They must be replaced before calculating a real product.

The submitted 1,000 L syrup/tonic scenario additionally uses the JECFA ferric
ammonium citrate specification range. Its displayed 19.5% iron is a midpoint
scenario for the brown grade, not an identification of the photographed raw
material. Zinc sulphate monohydrate, pure vitamin inputs, paraben identities,
orange flavour, and xanthan fibre values are likewise explicit scenario
assumptions pending supplier specifications.

## Targeted chemical identity verification

Accessed 2026-09-20 using PubChem PUG REST. These were targeted single-record
or nine-record batch lookups; no pagination or local filtering was required.

- Cyanocobalamin: CID 166596686, C63H88CoN14O14P, 1355.4 g/mol
- Folic acid: CID 135398658, C19H19N7O6, 441.4 g/mol
- Zinc sulphate monohydrate: CID 62639, H2O5SZn, 179.5 g/mol
- Pyridoxine hydrochloride: CID 6019, C8H12ClNO3, 205.64 g/mol
- Pyridoxine: CID 1054, C8H11NO3, 169.18 g/mol
- Propylparaben: CID 7175, C10H12O3, 180.20 g/mol
- Bronopol: CID 2450, C3H6BrNO4, 199.99 g/mol
- Sodium benzoate: CID 517055, C7H5NaO2, 144.10 g/mol
- Benzoic acid: CID 243, C7H6O2, 122.12 g/mol
- Sucrose: CID 5988, C12H22O11, 342.30 g/mol

Endpoints:

- `/rest/pug/compound/name/cyanocobalamin/property/Title,MolecularFormula,MolecularWeight,InChIKey/JSON`
- `/rest/pug/compound/cid/135398658,62639,6019,1054,7175,2450,517055,243,5988/property/Title,MolecularFormula,MolecularWeight,InChIKey/JSON`
- Exact name-to-CID lookups for `Nepazene` and `Nepasol` both returned no CID.
- The exact `Nipasol` lookup resolved to propylparaben CID 7175. This supports
  an explicit spelling scenario but does not prove that the photographed
  `NEPASOL` is Nipasol.

A broader spelling search found Indian pharmaceutical-excipient listings for
`Nipazine` as sodium methylparaben alongside `Nipasol` as sodium
propylparaben. That pair closely matches the photographed `NEPAZENE` and
`NEPASOL`, and the formula uses them together. FDA GSRS, however, lists
`NIPASOL` as a propylparaben brand name rather than proving the sodium salt.
The engine therefore records Nipazine/sodium methylparaben as the leading
candidate for `NEPAZENE`, but keeps it unresolved and does not calculate a
methylparaben or sodium contribution until the supplier label or CoA confirms
the identity and salt form.

The correction shortlist also includes neutral methylparaben (`Nipagin` or
`Nipagin M`, FDA UNII A2I8C7HI9T) and a Nipasept-type mixed-paraben
preservative. FDA GSRS identifies `Nipagin M Sodium` as a brand name for sodium
methylparaben (UNII CR6K9C2NHK), while PubChem records `Nipagin` and `Nipagin M`
for neutral methylparaben. Clariant describes Nipasept Sodium as a paraben
blend, so no fixed composition is assigned without its grade-specific supplier
specification.

Count reconciliation: 10 requested named compounds were retrieved with one
property record each; two exact photographed trade-name searches returned zero
records; the one normalized `Nipasol` cross-check returned one propylparaben
record. No API records were dropped by local filtering.

External database payloads were used only for the listed identity and property
fields. Supplier identity, grade, hydrate, assay, and lot evidence remain the
authority for the actual raw materials.

## Public-product regression labels

The engine is also checked against independently published finished-product
compositions rather than only self-authored examples:

- WHO reduced-osmolarity ORS: glucose 13.5 g/L, sodium chloride 2.6 g/L,
  potassium chloride 1.5 g/L, trisodium citrate dihydrate 2.9 g/L; published
  targets 75 mmol/L glucose, 75 mEq/L sodium, 65 mEq/L chloride, 20 mEq/L
  potassium, and 10 mmol/L citrate.
- DailyMed 0.9% Sodium Chloride Injection: sodium chloride 9 g/L; 154 mEq/L
  sodium and 154 mEq/L chloride.
- DailyMed Lactated Ringer's Injection: sodium chloride 6.0 g/L, sodium lactate
  3.1 g/L, potassium chloride 0.3 g/L, calcium chloride dihydrate 0.2 g/L.
- DailyMed Ringer's Injection: sodium chloride 8.6 g/L, potassium chloride
  0.3 g/L, calcium chloride dihydrate 0.33 g/L; published ionic concentrations
  approximately 147 mEq/L sodium, 4 mEq/L potassium, 4.5 mEq/L calcium, and
  156 mEq/L chloride.
- DailyMed 5% and 10% Dextrose Injection: respectively 5 g and 10 g hydrous
  dextrose per 100 mL and 170/340 kcal per litre.

### Marketed-medicine active-moiety checks

Accessed 2026-09-20. These are five targeted current or publicly archived
DailyMed labels; no paginated result set or local record filtering was used.

- Kesin Pharma Magnesium Oxide tablet, set ID
  `31f417f0-1637-eefa-e063-6294a90a121b`: 400 mg magnesium oxide and 241.3 mg
  elemental magnesium per tablet.
- Rising Pharma Ferrous Sulfate tablet, set ID
  `4e88a847-397b-4ddb-83d7-42c9b963a0b7`: 325 mg ferrous sulfate equivalent,
  made with 202 mg dried ferrous sulfate, and 65 mg elemental iron per tablet.
- Somerset Therapeutics Zinc Sulfate Injection, set ID
  `c9d45d0e-a165-4112-81f9-c0e455572ecf`: each mL contains 3 mg zinc present
  as 7.41 mg zinc sulfate. The label separately identifies the manufactured
  salt as zinc sulfate heptahydrate. The regression fixture therefore records
  7.41 mg on the label's anhydrous-equivalent basis; treating it as 7.41 mg of
  physical heptahydrate would be chemically inconsistent with the declared
  3 mg zinc.
- CitraGen Calcium Carbonate tablet, set ID
  `766b3f3f-8bd1-281c-e053-2991aa0af54b`: 1250 mg calcium carbonate and 500 mg
  elemental calcium per tablet.
- Northstar Potassium Chloride extended-release tablet, set ID
  `b19a3fbf-cdbb-4f86-ac61-5dfb07e0a51a`: 750 mg potassium chloride equivalent
  to 10 mEq potassium per tablet.

The predictions use formula masses calculated from standard atomic weights.
They test label-basis interpretation and salt-to-active-moiety conversion, not
tablet weight, excipient composition, assay variability, dissolution,
bioavailability, sterility, or manufacturing release.

### Additional trace-element injection checks

Accessed 2026-09-21 through the official DailyMed v2 SPL API and PubChem PUG
REST. These six cases independently convert the label's stated salt quantity
to the declared ion or elemental amount:

- Magnesium sulfate heptahydrate, set ID
  `5a0f9db9-b8be-c923-e063-6394a90a7dd7`: 500 mg/mL and 4.06 mEq/mL
  magnesium.
- Calcium chloride dihydrate, set ID
  `3089499b-142d-482e-889d-1db4da7b1152`: 100 mg/mL and 27 mg/mL elemental
  calcium.
- Calcium gluconate, set ID
  `16307c00-d0d5-4e05-821f-17b0c1a29fc9`: 94 mg anhydrous calcium gluconate
  plus 4.5 mg calcium saccharate tetrahydrate per mL, declared as 9.3 mg/mL
  elemental calcium.
- Zinc chloride, set ID `2bd646d2-2a2a-4376-8da0-c7f08b0511ac`: 2.09 mg/mL
  and 1 mg/mL elemental zinc.
- Cupric chloride dihydrate, set ID
  `361d30f2-3c97-4a6c-b252-7fa864d0a625`: 1.07 mg/mL and 0.4 mg/mL elemental
  copper.
- Selenious acid, set ID `4adcba5d-74c7-4353-b54d-539ef89754d6`:
  65.4 micrograms/mL and 40 micrograms/mL elemental selenium.

DailyMed search reconciliation: the exact drug-name searches reported 211
magnesium-sulfate records over 22 pages, 3 calcium-chloride-injection records
on one page, 53 calcium-gluconate records over 6 pages, 98 zinc-chloride
records over 10 pages, 13 cupric-chloride records over 2 pages, and 3
selenious-acid records on one page. All records were retrieved for the two
three-result searches. The other searches were targeted label lookups, so the
named set ID was selected without claiming an exhaustive product census.

PubChem identity and formula-mass records used by these conversions were CID
24843 (magnesium sulfate heptahydrate, 246.48 g/mol), CID 6093260 (calcium
chloride dihydrate, 147.01 g/mol), CID 9290 (anhydrous calcium gluconate,
430.37 g/mol), CID 11954337 (calcium D-saccharate tetrahydrate, 320.26 g/mol),
CID 5727 (zinc chloride, 136.3 g/mol), CID 61482 (cupric chloride dihydrate,
170.48 g/mol), and CID 1091 (selenious acid, 128.99 g/mol). Each targeted
name lookup returned one property record; no returned property record was
dropped by local filtering.

### Phosphate and trace-element injection checks

Accessed 2026-09-21. Four additional targeted DailyMed labels were reproduced:

- Potassium phosphates injection, set ID
  `52f07402-1869-4a97-9c92-9729dc611f85`: 224 mg monobasic potassium phosphate
  plus 236 mg dibasic potassium phosphate per mL, declared as 3 mmol phosphorus
  and 170 mg elemental potassium.
- Sodium phosphates injection, set ID
  `e6169d3b-39d2-47f9-8d5b-b53ec069a722`: 276 mg monobasic sodium phosphate
  monohydrate plus 142 mg dibasic sodium phosphate anhydrous per mL, declared
  as 3 mmol phosphorus and 4 mEq sodium.
- Manganese chloride injection, set ID
  `6e979070-5035-4076-e09c-b52466be3c68`: 0.36 mg manganese chloride
  tetrahydrate per mL, declared as 0.1 mg elemental manganese.
- Chromic chloride injection, set ID
  `da207ca8-7836-4c66-92fe-36cc89baf773`: 20.5 micrograms chromic chloride
  hexahydrate per mL, declared as 4 micrograms elemental chromium.

The DailyMed name searches reported respectively 12, 8, 7, and 5 records.
These were targeted set-ID checks; one result page was retrieved for each and
no exhaustive product census was attempted. PubChem returned one property
record for CID 516951, 24450, 516949, 24203, 643989, and 104957. The first
exact `chromium chloride hexahydrate` name lookup returned no record; the
structure-preserving name `chromium(III) chloride hexahydrate` resolved to CID
104957. No successful property record was removed locally.

### USDA MyPlate food-recipe check

Accessed 2026-09-21. The USDA MyPlate `Yogurt Smoothie in a Bag` recipe lists
one-quarter cup vanilla yogurt, one tablespoon skim milk, and two teaspoons
orange juice concentrate, with a published one-recipe result of 77 kcal,
4 g protein, 14 g carbohydrate, 127 mg calcium, 237 mg potassium, and 17 mg
vitamin C.

The calculation uses official FoodData Central portion weights and profiles:

- Low-fat vanilla yogurt fortified with vitamin D: SR Legacy FDC 172219;
  245 g per cup.
- Fat-free milk: FNDDS FDC 2705388; 244 g per cup.
- Frozen unreconstituted orange juice: FNDDS FDC 2709191; 284 g per cup.

The FNDDS October 2024 JSON archive and SR Legacy April 2018 JSON archive were
downloaded from the official FoodData Central bulk-download page after the
public `DEMO_KEY` API returned HTTP 429. Local selection used exact FDC IDs;
three records were selected and none were dropped. The recipe permits nonfat
or plain yogurt, while its displayed nutrition is reproduced more closely by
the low-fat vanilla reference profile. That assumption is preserved in the
case data. The resulting differences are 2.908% energy, 4.333% protein, 4.513%
carbohydrate, 1.862% calcium, 1.250% potassium, and 0.931% vitamin C. This case
demonstrates that food-profile selection contributes more uncertainty than the
decimal arithmetic.

These are composition-calculation tests only and do not model sterility,
osmolarity, pH adjustment, packaging, clinical use, or manufacturing release.

### Additional external-formula checks

Added 2026-09-21:

- DailyMed Plasma-Lyte A, set ID
  `6ec9e61c-2c26-402f-8604-f446b2e34058`: each 100 mL declares 526 mg sodium
  chloride, 502 mg sodium gluconate, 368 mg sodium acetate trihydrate, 37 mg
  potassium chloride, and 30 mg magnesium chloride hexahydrate. The label's
  one-litre targets are 140 mEq sodium, 5 mEq potassium, 3 mEq magnesium,
  98 mEq chloride, 27 mEq acetate, and 23 mEq gluconate. The engine checks all
  six rather than selecting only the best-matching ion.
- DailyMed Sodium Bicarbonate Injection USP 8.4%, set ID
  `9545d58c-1c49-79b3-e053-2995a90a9d40`: 84 mg sodium bicarbonate per mL is
  declared as 1 mEq/mL each of sodium and bicarbonate. Both ions are checked.
- WHO F-75 no-cereal recipe: 25 g dried skim milk, 100 g sugar, 27 g oil,
  20 mL mineral mix, 140 mg vitamin mix, and water to one litre. The targets are
  75 kcal and 0.9 g protein per 100 mL.
- WHO F-100 recipe: 80 g dried skim milk, 50 g sugar, 60 g oil, 20 mL mineral
  mix, 140 mg vitamin mix, and water to one litre. The targets are 100 kcal and
  2.9 g protein per 100 mL.

The therapeutic-milk predictions use USDA reference profiles already present
in the project: nonfat dry milk FDC 171272, granulated sugar FDC 169655, and
canola oil FDC 172336. This intentionally measures realistic reference-profile
variation rather than forcing the ingredient profiles to equal the WHO targets.
Predicted energy differs by 4.643% for F-75 and 1.030% for F-100; predicted
protein differs by 2.500% and 3.172%, respectively. These are acceptable recipe
reproduction checks, not lot-specific release tolerances.

DailyMed API reconciliation: a targeted `PLASMA-LYTE A` search requested five
records and returned both matching records on its only page; the human Baxter
label above was selected and the veterinary label excluded. A broad
`SODIUM BICARBONATE` search reported 306 records over 62 pages; only the first
five were retrieved because the named official label was already known and the
task was a targeted lookup, not an exhaustive product census. The set-ID
metadata endpoint returned HTTP 415, so the directly accessible official label
page was used for the declared composition.

PubChem PUG REST cross-checks retrieved one property record for each of four
requested names, with no pagination or local filtering: sodium bicarbonate CID
516892 (`CHNaO3`, 84.007 g/mol), sodium gluconate CID 23672301
(`C6H11NaO7`, 218.14 g/mol), sodium acetate trihydrate CID 23665404
(`C2H9NaO5`, 136.08 g/mol), and magnesium chloride hexahydrate CID 24644
(`Cl2H12MgO6`, 203.30 g/mol). The hydrate formulas are equivalent to the
dot-hydrate notation shown on the DailyMed label.

## Source policy

Production ingredient profiles should be stored in this order of preference:

1. Lot-specific analytical result or CoA
2. Approved supplier specification
3. Authoritative national food-composition record
4. Explicitly labelled user estimate

An absent nutrient is unknown. It is never converted to zero unless the source
explicitly establishes its absence.

## Production API strategy

The production search layer should be hybrid rather than API-only:

- Search the versioned accepted catalog first.
- Query USDA FoodData Central for food candidates. Its API requires a data.gov
  key and currently documents a default limit of 1,000 requests per hour per IP;
  the shared `DEMO_KEY` is suitable only for initial exploration.
- Query PubChem PUG REST for chemical candidates and keep below its documented
  five-request-per-second limit.
- Store confirmed external records with source ID, retrieval date, normalized
  units, and the raw fields used by the calculation. Recalculations should not
  change merely because an upstream search result changes later.

Targeted checks on 2026-09-20 resolved `sodium methylparaben` to PubChem CID
23663626 (`C8H7NaO3`, 174.13 g/mol) while an exact `Nepazene` lookup returned no
CID. A FoodData Central search using the public demonstration key returned a
rate-limit response, confirming that a production server-side key and local
cache are required.
