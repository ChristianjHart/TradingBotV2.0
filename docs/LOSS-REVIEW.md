# Loss review: how the app learns from its results

## What "training" means here

The AI is a hosted model (OpenRouter). A few dozen trades cannot retrain it, and the app does not try. Instead it runs a **feedback loop**:

1. **Measure.** The review scores every proposal, taken or not, with the same exit rules (the "shadow" score). Your own picking does not bias it.
2. **Look for patterns that lose again and again.** It checks groups such as shorts, crypto, low confidence, tight stops, and trades against the market trend.
3. **Guard against noise.** Most apparent patterns in a few weeks of trades are luck. The guards below remove most of them.
4. **Pass solid findings on, if you choose.** You can switch on "Give these lessons to the trader". Each proposal then records which lessons it had. The review later compares proposals made with and without them.

Nothing here trades, and nothing changes a setting for you. The lessons switch is **off** by default.

## Where the money goes

- **Result** and **costs**: fees and slippage, and what the trades made before costs.
- **Biggest loss.** The app sizes each trade so a full stop-out costs up to **2% of equity**. One bad trade can therefore explain a whole 2% drawdown. Look here first.
- **Stop-outs**: how many losses were stop-outs and how fast. Stops sit near 2 hourly ATRs, but trades run 24 hours. Many stop-outs within 4 hours point to stops that are too tight.

## The guards against noise

A group becomes a **lesson** only if all of these are true:

| Guard | Why |
|---|---|
| 8 or more outcomes in the group, and 20 or more in total | Tiny groups look dramatic by accident |
| Average result at or below −0.25R | The loss must be big enough to matter |
| Same sign in both halves of the timeline | A pattern that only shows in one half is probably luck |
| A low chance of luck **after counting every group checked** (Holm correction, Student t) | Check 35 groups and a few always look bad |
| A **primary** group (side, stock or crypto, confidence, stop distance, side and market trend) | These were chosen before looking at data, because the code gives a reason to suspect them. Other groups (sector, time of day, RSI…) show only as hints |
| Still weak **after removing trades a stronger finding already explains** | "Stocks" can look weak only because it contains the losing shorts |

## How well it works (measured)

Run `node scripts/review-sim.mjs` to repeat this. A win pays +1.5R, a loss costs −1R, and a 40% win rate is break-even.

| Scored outcomes | Luck-only data: review names a pattern | Real leak (a group wins 15% instead of 40%): review finds it |
|---|---|---|
| 30 | 6% | 4% |
| 60 | 8% | 16% |
| 120 | 5% | 38% |
| 240 | 3% | 69% |
| 400 | 4% | 93% |

(Each cell is the share of 500 simulated reviews. The numbers move by a point or two between runs.)

**What this means for you:** with a few weeks of data the review will usually say "no clear pattern", even when a real problem exists. It needs roughly **250 to 400 scored outcomes** to find a moderate leak reliably. A 2% loss over two weeks is well inside normal luck. The review is built to say so instead of inventing a story.

## Ideas to test

The review can replay your past proposals with seven ready-made rule changes (wider stops, nearer targets, no break-even stop, a 48-hour hold, half size). Each idea is judged on the same trades that picked it, so the best one looks better than it will be. An idea gets the "holds" mark only when it also helped in **both halves** of the timeline. Try an idea on new trades before you trust it.

## What it does not do

- It does not retrain or fine-tune any model.
- It does not change a setting, a stop, or a size for you.
- It cannot tell skill from luck on a small sample. No tool can.
- Past losses may not repeat. Markets change, so lessons can go stale. Turn the switch off if results get worse.

## Settings and API

- Setting `useLessons` (boolean, default `false`).
- `GET /api/review`: money, weakest groups with their chance of being luck, lessons, with/without comparison.
- `GET /api/review/experiments`: the seven rule changes replayed on past proposals.
