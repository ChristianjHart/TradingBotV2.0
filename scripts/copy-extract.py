"""Pull user-facing sentences out of the dashboard JS so a prose linter can read them.

Usage: python3 scripts/copy-extract.py OUT.txt [FILE ...]     (default: public/js/*.js and public/index.html)
Then:  python3 path/to/asd-ste100-skill/scripts/ste-lint.py OUT.txt
Heuristic: it keeps quoted strings of 4+ words and drops code-like ones. Use it to compare before and after, not as a gate.
"""
import re, sys, glob, json
FILES = sys.argv[2:] or sorted(glob.glob('public/js/*.js')) + ['public/index.html']
STR = re.compile(r"""'((?:\\.|[^'\\\n])*)'|"((?:\\.|[^"\\\n])*)"|`((?:\\.|[^`\\])*)`""", re.S)
out = []
for f in FILES:
    src = open(f, encoding='utf-8').read()
    for m in STR.finditer(src):
        s = next(g for g in m.groups() if g is not None)
        s = re.sub(r'\$\{[^}]*\}', 'X', s)            # template expressions
        s = re.sub(r'<[^>]+>', ' ', s)                  # html tags
        s = re.sub(r'&amp;|&nbsp;', ' ', s)
        s = s.replace('\\n', ' ').replace("\\'", "'").replace('\\"', '"')
        s = re.sub(r'\s+', ' ', s).strip()
        words = s.split()
        if len(words) < 4 or not re.search(r'[A-Za-z]{3}', s): continue
        if re.search(r'[{}=<>\\]|=>|\bfunction\b|^[.#\[]|\(\)|\w\.\w+\(|^[a-z]+(-[a-z]+)+$|^\w+:\s', s): continue   # code, selectors, css
        if re.search(r'[a-z][A-Z][a-z]', s) and ' ' not in s[:12]: continue
        if sum(c.isalpha() for c in s) < 0.6 * len(s): continue
        out.append((f, s))
seen = set(); rows = []
for f, s in out:
    if s in seen: continue
    seen.add(s); rows.append((f, s))
open(sys.argv[1], 'w', encoding='utf-8').write('\n\n'.join(s if s.endswith(('.', '!', '?', ':')) else s + '.' for _, s in rows) + '\n')
json.dump(rows, open(sys.argv[1] + '.json', 'w'))
print(len(rows), 'strings,', sum(len(s.split()) for _, s in rows), 'words')
