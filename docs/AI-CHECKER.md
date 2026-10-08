# AI checker

A second AI looks at each pending proposal and answers: "Is this worth trading?" and "What is the chance it ends in profit?"

## How it works
- The checker sees **numbers only**: price, stop, target, size, risk, reward-to-risk, break-even win rate. It does **not** see the trader's reason or confidence, so it cannot copy the trader's view.
- It runs **2 to 5 times** per proposal (default 3), in parallel, at a higher temperature. The runs are combined:
  - call: take / skip / split (split = no majority)
  - agreement, mean chance of profit, lowest and highest
  - "steady" when the runs differ by 10 points or less
  - edge = mean chance minus the break-even win rate
- If some runs fail, the rest still count. Results are saved on the proposal, so repeats are free (`?force=1` asks again).
- Cost: one call per run. Budget-governed under the bot name `checker` (model: `JUDGE_MODEL`, else the trader model).

## Settings
| Setting | Meaning |
|---|---|
| `judgeRuns` | Runs per proposal (2 to 5) |
| `autoJudge` | Check each new proposal automatically (off by default; costs money) |

## Scorecard
`GET /api/judge/scorecard` (also in the Loss review). It compares proposals the checker said TAKE with those it said SKIP, using the real or shadow result.

It needs **20+ checked outcomes with 8+ on each side**. It reports:
- average R and profit per group, one Welch t-test (chance the gap is luck)
- filter effect: what you would have made if you took only TAKE trades
- Brier skill: whether its chance-of-profit beat just guessing the average win rate
- checks made after the trade ended are excluded (the checker could have known the result)

## Caveats
- LLM probabilities are **not calibrated**. Treat them as a ranking, not a promise.
- The scorecard shows if the checker helps. Do not trust it before it has enough outcomes.
- Demo mode (`MOCK_LLM`) gives canned numbers; the scorecard is then only a layout test.
