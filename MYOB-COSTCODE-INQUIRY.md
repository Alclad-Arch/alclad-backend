# ✅ RESOLVED 2026-09-16 — NOTHING IS NEEDED FROM MYOB. DO NOT ACTION THIS.

**The inquiry this document asked to have built already existed: `ALX_JobAnalysis_Detail`**, the
`_Detail` sibling of `ALX_JobAnalysis`, already exposed over OData and already readable by the same
credentials the nightly sync uses. It answers every requirement below.

**So: do not build or extend an inquiry, do not tick "Expose via OData" on `PMBudget` (PMGI0010),
and do not chase the 403 on `ALX_JobBudgets`.** All three were investigated and all three are
unnecessary.

It reconciles exactly. Job 6163, per-code sums against what `ALX_JobAnalysis` reports per package:

|                    | Glazing      | Cladding     |
|--------------------|--------------|--------------|
| `BudgetCost`       | 151,365.50 ✓ | 323,003.38 ✓ |
| `CostsToDate`      |  82,457.48 ✓ | 114,597.57 ✓ |
| `CostAtCompletion` | 142,191.57 ✓ | 259,079.38 ✓ |

Built on it: `myobCostCodes.js` + its tests, `myob_cost_budget`, and the bars on the Financials tab.
The traps found in the real rows — chiefly that the inquiry's **`Type` column is wrong on revenue
rows** — are documented at the top of `myobCostCodes.js`, which is the file to read, not this one.

**The method lesson, which is why this document is kept rather than deleted:** two rounds of probing
went to `VelixoReportsPro-PMBudget`, `-CostBudgets`, `ALX_JobBudgets` and `PMBudget` before anyone
tried the `_Detail` sibling of the inquiry already being read. **When an inquiry is the wrong grain,
probe its `_Detail` / sibling variants first.** The catalogue is 87 names and `probe-odata.js` lists
them all in one request.

The original specification follows, unchanged, for the record.

---

# What the hub needs from MYOB to show cost-code bars

**For: whoever changes the Generic Inquiry in MYOB Acumatica (Jed / Nathan).**
Nothing here needs code from the app side first — the app change is small and waits on this.

---

## Why

Jed asked (2026-09-16) for a horizontal bar per cost code on a project's Financials tab, comparing
**budget / forecast / actual** with the same anatomy and colour rules as the dials at the top of the
page. The bar component is built and tested (`src/pm/CostCodeBar.jsx`). It cannot be wired up,
because the figures it needs do not exist at cost-code grain in anything we sync.

## What we found, and the thing to not repeat

`myobJobAnalysis.js` carries a comment saying `ALX_JobAnalysis` returns

> one row per project × task × cost code, ~171 rows for the whole company

**That is not what it returns.** Probing job 6163 on the live tenant gave **2 rows** — one per
package type (G and C), each carrying the whole package's figures:

| | row 1 | row 2 |
|---|---|---|
| `Type` | `G` | `C` |
| `BudgetCost` | 151,365.50 | 323,003.38 |
| `CostsToDate` | 82,457.48 | 114,597.57 |
| `CostAtCompletion` | 142,191.57 | 259,079.38 |

⚠ **The rows DO carry cost-code columns, and that is the trap.** Each row has **two of them** with
**different values** — `CostCode "1000105"` *and* `CostCode_2 "1000306"` on the same row. A row
cannot have two cost codes as its grain; those are artefacts of a join inside the inquiry. Reading
`CostCode` off these rows would attach a whole package's budget to one arbitrary code and look
entirely plausible on screen.

## What is needed

**One row per `Project` × `CostCode`** (per `Type` as well, if a code can appear under more than one
package type on a job), carrying:

| Column | Why |
|---|---|
| `Project` | the job number, as now |
| `Type` | G / C / R / F — so bars can be grouped by package |
| `CostCode` | **exactly one per row** — this is the whole point |
| *cost code description* | the bar's label. `PM`, `DESIGN` in Jed's sketch — a bare `1000105` is unreadable |
| `BudgetCost` | the **budget** — the solid tick |
| `CostsToDate` | the **actual** — the filled section and the ▼ |
| `CostAtCompletion` | the **forecast** — the dotted line and the △ |
| `OpenCommittedAmt` | optional; open POs, useful on hover |
| `AccountGroupID` | optional; lets a wrong classification be explained without going back to MYOB |

`CostProjection` is not needed separately if `CostAtCompletion` is present.
Revenue columns are not needed — these bars are about cost only.

## The check that proves it is right

> For every job and package type, the **sum of per-code `BudgetCost` must equal the `BudgetCost`
> the current inquiry returns for that job and type.**

On 6163 that means the Glazing codes must sum to **151,365.50** and the Cladding codes to
**323,003.38**. Same for `CostsToDate` (82,457.48 / 114,597.57) and `CostAtCompletion`
(142,191.57 / 259,079.38).

If those do not reconcile, the inquiry is double-counting across a join — which is exactly what the
two `CostCode` columns above suggest is already happening. **Please check this before handing it
over**, because a set of bars that each look reasonable while summing to the wrong total is worse
than no bars: the project dials and the bars beneath them would disagree, and neither would say so.

## Either is fine

- **extend `ALX_JobAnalysis`** so it returns this grain, or
- **add a second inquiry** (e.g. `ALX_JobCostCodes`) and leave `ALX_JobAnalysis` alone

The second is safer: the nightly sync depends on the current shape, and the hub's whole financial
picture comes through it. A new inquiry cannot break what already works.

## What happens then

1. Add the columns to `BUDGET_SELECT` in `myobJobAnalysis.js` (or a new reader for a new inquiry).
2. A `myob_cost_budget` table keyed `(project_id, package_type, cost_code)`, synced the same way.
3. The hub reads it into `CostCodeBar`, which is already written and tested.

Roughly half a day on our side once the inquiry answers.

## Also worth knowing

**Actual cost per cost code is ALREADY synced** — `myob_actuals`, keyed
`(project_id, cost_code, fin_period)`, from `ALX_JobTrans`. So only the **budget** and the
**forecast** are missing. If the inquiry can only be made to yield one of the two, **budget is the
one that matters**: without it there is no scale, no tick and no colour, and the bar stops being the
thing Jed sketched.
