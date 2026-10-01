# Dashboard copy style

The dashboard text follows the plain rules of Simplified Technical English (ASD-STE100), in its relaxed "STE-flavored" form
(see <https://github.com/danyuchn/asd-ste100-skill>). The goal is short text that one reading cannot get wrong.

## Rules

1. **One idea per sentence.** Aim for 20 words or fewer.
2. **Active voice.** Name who acts: "The app refreshes the list", not "The list is being refreshed".
3. **Simple tenses.** "The server rejected the token", not "has rejected". Keep a compound form only when it carries meaning ("may have failed").
4. **No semicolons.** Split into two sentences. Avoid em-dash joins.
5. **Verb, not noun.** "Analyze the log", not "perform an analysis of the log".
6. **No marketing words** (seamless, robust, powerful). Show a number instead.
7. **No phrasal verbs** (spin up, reach out). Use one plain verb.
8. **One word per idea.** The app says *run*, *proposal*, *position*, *budget*, *key*. Do not rotate synonyms.
9. **Keep hedges.** "May be closed" must not become "is closed". A shorter text must not state a fact the code does not know.
10. **Say what happened and what to do next.** "Nothing opened. Re-run the AI for a new one."

## Layout rules that keep the dashboard calm

- Proposals stay open. Positions is the only section open by default. Every other block is a one-line section with a summary.
- A summary shows the one number that matters ("net edge +$1,528"). Details sit one click away.
- Put a long list behind "Show all N". Put secondary numbers behind a fold (`<details>`).
- The dashboard shows headline numbers. The Performance page shows the full tables.

## Check your wording

```bash
python3 scripts/copy-extract.py /tmp/copy.txt          # pull the dashboard strings
python3 ../asd-ste100-skill/scripts/ste-lint.py /tmp/copy.txt
```

The linter finds semicolons, long sentences, passive voice, compound tenses, phrasal verbs, nominalization, marketing words and synonym rotation.
Passive voice is only advisory: a state such as "the market is closed" is fine.
