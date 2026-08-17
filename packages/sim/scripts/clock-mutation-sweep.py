#!/usr/bin/env python3
"""
THE CLOCK MUTATION SWEEP (item 119) — the acceptance test for the clock census.

For every place in the sim where a clock crosses a transfer, replace it with a literal 0 and run
the whole suite. Every one of them must go RED. A crossing that survives is a door that can be
reverted to the bug it was fixed for, with nobody noticing.

**A LITERAL 0 IS THE FAITHFUL REVERT AND `+1` IS NOT**, which is worth stating because the wrong
mutant was tried first: `FRESHNESS_BUCKET_TICKS` is 300, so a one-tick nudge is legitimately
absorbed and proves nothing. `mergedFreshness`, `beltInsert`, `putHopper` and `addItemFresh` all
read 0 as "no opinion" and answer with a FULL window. **These lines do not lose time when they
break. They mint it.**

Two families of site, matching `clockDoors()` and `clockWrites()` in `test/goods.ts`:
  DOOR   — a call handing a clock to a container primitive: the last argument becomes 0.
  ASSIGN — a direct write to a clock field: the right-hand side becomes 0.

Usage, from the repo root:
  python3 packages/sim/scripts/clock-mutation-sweep.py --list     # enumerate the sites
  python3 packages/sim/scripts/clock-mutation-sweep.py            # run the sweep (~6 min)

Measured at HEAD 5ce5175, before item 119: 32 mutants, 23 caught, NINE SURVIVED.
Measured at HEAD 5ce5175 + item 119: 32 mutants, 32 caught, none survived.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path("/Users/lucasleite/age-of-potatoes")
SRC = REPO / "packages/sim/src"

DOORS = ["beltInsert", "putHopper", "putStorage", "addItemFresh", "depotAccept", "placeOnFace"]
# The door primitives' own bodies are the door, not a user of it.
PLUMBING_OWNERS = set(DOORS) | {"addItem"}


def source_files():
    out = []
    for path in sorted(SRC.rglob("*.ts")):
        out.append((str(path.relative_to(SRC)).replace(".ts", ""), path))
    return out


def enclosing(lines):
    owners, current = [], "(top level)"
    for line in lines:
        m = re.match(r"^(?:export )?(?:async )?function\*? ([A-Za-z0-9_]+)", line) or re.match(
            r"^(?:export )?const ([A-Za-z0-9_]+) = (?:\([^)]*\)|[A-Za-z0-9_]+) =>", line
        )
        if m:
            current = m.group(1)
        owners.append(current)
    return owners


def find_call_end(text, open_paren):
    """Index just past the matching close paren."""
    depth = 0
    i = open_paren
    while i < len(text):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i
        i += 1
    return -1


def split_args(inner):
    """Top-level comma split."""
    args, depth, start = [], 0, 0
    for i, ch in enumerate(inner):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            args.append((start, i))
            start = i + 1
    args.append((start, len(inner)))
    # Prettier puts a trailing comma on multi-line calls, which leaves a final empty segment.
    while len(args) > 1 and inner[args[-1][0] : args[-1][1]].strip() == "":
        args.pop()
    return args


def collect_sites():
    sites = []
    for label, path in source_files():
        text = path.read_text()
        lines = text.split("\n")
        owners = enclosing(lines)
        # Offset of the start of each line in `text`.
        offsets, run = [], 0
        for line in lines:
            offsets.append(run)
            run += len(line) + 1

        for i, line in enumerate(lines):
            if re.match(r"^\s*(?://|\*|/\*)", line):
                continue
            if re.match(r"^\s*(?:export )?function ", line):
                continue
            owner = owners[i]
            for door in DOORS:
                if owner in PLUMBING_OWNERS:
                    continue
                m = re.search(rf"(?<![A-Za-z0-9_.]){door}\(", line)
                if not m:
                    continue
                start = offsets[i] + m.end() - 1
                end = find_call_end(text, start)
                if end < 0:
                    continue
                inner = text[start + 1 : end]
                args = split_args(inner)
                a_start, a_end = args[-1]
                arg = inner[a_start:a_end].strip()
                if arg == "0":
                    continue
                sites.append(
                    {
                        "kind": "DOOR",
                        "id": f"{label}:{owner}:{door}",
                        "file": str(path),
                        "line": i + 1,
                        "abs_start": start + 1 + a_start,
                        "abs_end": start + 1 + a_end,
                        "was": arg,
                    }
                )
            m = re.search(r"\.([A-Za-z0-9_]*(?:[Ff]reshTicks|[Ss]poilAtTick))\s*=([^=].*)$", line)
            if m and owner not in PLUMBING_OWNERS:
                rhs = m.group(2).rstrip()
                if rhs.endswith(";"):
                    rhs = rhs[:-1]
                if rhs.strip() in ("0", ""):
                    continue
                # Only single-line assignments; multi-line ones are handled as DOOR calls or skipped.
                if rhs.count("(") != rhs.count(")"):
                    continue
                sites.append(
                    {
                        "kind": "ASSIGN",
                        "id": f"{label}:{owner}:{m.group(1)}",
                        "file": str(path),
                        "line": i + 1,
                        "abs_start": offsets[i] + m.start(2),
                        "abs_end": offsets[i] + m.start(2) + len(m.group(2).rstrip().rstrip(";")),
                        "was": rhs.strip(),
                    }
                )
    return sites


def run_suite():
    r = subprocess.run(
        ["yarn", "test"], cwd=REPO, capture_output=True, text=True, timeout=900
    )
    out = r.stdout + r.stderr
    m = re.search(r"Tests\s+(.*)", out)
    summary = m.group(1).strip() if m else "NO SUMMARY"
    caught = "failed" in summary
    return caught, summary


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    sites = collect_sites()
    if only == "--list":
        for s in sites:
            print(f"{s['kind']:6} {s['id']:55} {Path(s['file']).name}:{s['line']}  was={s['was']}")
        print(f"\n{len(sites)} sites")
        return
    results = []
    for n, s in enumerate(sites, 1):
        path = Path(s["file"])
        original = path.read_text()
        mutated = original[: s["abs_start"]] + " 0" + original[s["abs_end"] :]
        path.write_text(mutated)
        try:
            caught, summary = run_suite()
        finally:
            path.write_text(original)
        results.append({**s, "caught": caught, "summary": summary})
        verdict = "CAUGHT " if caught else "SURVIVED"
        print(
            f"[{n}/{len(sites)}] {verdict} {s['id']:55} {path.name}:{s['line']} "
            f"({s['was'][:34]} -> 0)  {summary}",
            flush=True,
        )
    out = Path(sys.argv[1]) if only and not only.startswith("--") else Path("/tmp/sweep.json")
    out.write_text(json.dumps(results, indent=2))
    survived = [r for r in results if not r["caught"]]
    print(f"\n=== {len(results)} mutants, {len(results)-len(survived)} caught, "
          f"{len(survived)} SURVIVED ===")
    for r in survived:
        print(f"  SURVIVED {r['id']}  {Path(r['file']).name}:{r['line']}  was={r['was']}")


main()
