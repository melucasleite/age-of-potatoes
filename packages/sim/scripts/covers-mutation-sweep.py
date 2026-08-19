#!/usr/bin/env python3
"""
**THE MOVE CENSUS' COVERAGE CLAIMS, BROKEN ON PURPOSE** (item 123).

`scripts/clock-mutation-sweep.py` was deleted with the clock census it was about. It was also,
by item 123's own account, the only instrument in this family that had never turned out to be
prose — because it does not read anything, it breaks the world and runs the suite. This is the
same idea pointed at the guards item 123 added.

**WHAT IS BEING PROVED.** A `move-census-live.test.ts` scenario declares `covers:` — the census
rows it drives — and `doors:` — the bag doors it opens. Until item 123 nothing checked either, and
five of the nineteen declarations were false. `witnessMoves` now watches the live world and reports
which rows a scenario ACTUALLY executed. A guard that watches is only worth having if it bites, so:

  A. every scenario, given one extra row it does not drive, must go red;
  B. every scenario with doors, given one extra door it does not open, must go red;
  C. the sim's own `handOffFromHead` broken so the seam never carries — the arm scenario must go
     red, AND must go GREEN again with only the two witness assertions removed, which is the
     measurement that says the guard is what catches it and not the ledger;
  D. wiring up `beltTakeFromTile` must falsify the excuse that says nothing calls it;
  E. deleting either home of the name-blind guards must be loud in the third file.

Usage: python3 packages/sim/scripts/covers-mutation-sweep.py
Every file is restored from memory in a `finally`, including on a crash.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LIVE = ROOT / "packages/sim/test/move-census-live.test.ts"
CENSUS = ROOT / "packages/sim/test/move-census.test.ts"
SAVE = ROOT / "packages/sim/test/save.test.ts"
BELTS = ROOT / "packages/sim/src/belts.ts"
STATE = ROOT / "packages/sim/src/state.ts"

# A row and a door that NOTHING drives, so injecting either is a claim that must fail.
UNDRIVEN_ROW = "belts:beltTakeFromTile:items[]"
UNDRIVEN_DOOR = "state:createWorld:addItem"


def run_tests(*files: Path) -> tuple[bool, str]:
    """(passed, output). A non-zero exit or a parse failure both count as red."""
    proc = subprocess.run(
        ["npx", "vitest", "run", *[str(f.relative_to(ROOT)) for f in files]],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return proc.returncode == 0, proc.stdout + proc.stderr


def failing_names(output: str) -> set[str]:
    return set(re.findall(r"^ FAIL .*? > (?:.*? > )?(.+?)$", output, re.M))


def scenario_names(text: str) -> list[str]:
    """Every `name:` on a `CHECKS` entry, in source order."""
    end = text.index("// --- the tests ---")
    return re.findall(r"^    name: '(.+?)',$", text[:end], re.M)


def inject(text: str, field: str, index: int, value: str) -> str:
    """Add `value` to the `index`-th `field: [...]` declaration in `CHECKS`."""
    seen = -1
    out: list[str] = []
    cursor = 0
    for match in re.finditer(rf"^    {field}: \[", text, re.M):
        seen += 1
        if seen != index:
            continue
        at = match.end()
        out.append(text[cursor:at])
        out.append(f"'{value}', ")
        cursor = at
    out.append(text[cursor:])
    return "".join(out)


def report(label: str, ok: bool) -> bool:
    print(f"  {'BITES  ' if ok else 'MISSED '} {label}")
    return ok


def main() -> int:
    originals = {p: p.read_text() for p in (LIVE, CENSUS, SAVE, BELTS, STATE)}
    live = originals[LIVE]
    names = scenario_names(live)
    covers_count = len(re.findall(r"^    covers: \[", live, re.M))
    doors_count = len(re.findall(r"^    doors: \[", live, re.M))
    results: list[bool] = []

    try:
        print(f"A. {covers_count} `covers:` declarations, each given a row it does not drive")
        for i in range(covers_count):
            LIVE.write_text(inject(live, "covers", i, UNDRIVEN_ROW))
            passed, out = run_tests(LIVE)
            failed = failing_names(out)
            # The scenario itself must go red. Scenario order and `covers:` order agree because
            # every entry declares `covers` exactly once, in the order the names appear.
            target = names[i]
            results.append(report(f"covers[{i}] {target}", not passed and target in failed))
        LIVE.write_text(live)

        print(f"B. {doors_count} `doors:` declarations, each given a door it does not open")
        doors_owner = [
            n
            for n, body in zip(names, re.split(r"^  \{$", live[: live.index("// --- the tests ---")], flags=re.M)[1:])
            if re.search(r"^    doors: \[", body, re.M)
        ]
        for i in range(doors_count):
            LIVE.write_text(inject(live, "doors", i, UNDRIVEN_DOOR))
            passed, out = run_tests(LIVE)
            target = doors_owner[i]
            results.append(report(f"doors[{i}] {target}", not passed and target in failing_names(out)))
        LIVE.write_text(live)

        print("C. the sim's own belt seam, broken")
        broken = originals[BELTS].replace(
            "  const next = beltAt(state, nextX, nextY);\n  if (next === null || next.id === belt.id) return;",
            "  const next = beltAt(state, nextX, nextY);\n  if (next === null || next.id === belt.id) return;\n  return;",
        )
        assert broken != originals[BELTS], "the handOffFromHead guard clause moved"
        BELTS.write_text(broken)
        passed, out = run_tests(LIVE)
        seam = "an aged good crosses a belt seam, is lifted off, and is put down again"
        results.append(report("handOffFromHead never carries", not passed and seam in failing_names(out)))

        # ...and the same mutant with ONLY the two witness assertions gone. If this passes, the
        # ledger was blind to it and the witness is the entire reason it is caught.
        blinded = re.sub(
            r"  expect\(\n    check\.covers\.filter.*?\n  \)\.toEqual\(\[\]\);\n  expect\(\n    \(check\.doors \?\? \[\]\)\.filter.*?\n  \)\.toEqual\(\[\]\);\n",
            "",
            live,
            flags=re.S,
        )
        assert blinded != live, "could not find the witness assertions to remove"
        LIVE.write_text(blinded)
        passed, out = run_tests(LIVE)
        results.append(report("...and the LEDGER alone does not notice", passed))
        LIVE.write_text(live)
        BELTS.write_text(originals[BELTS])

        print("D. the excuse that says the sim never calls beltTakeFromTile")
        wired = originals[STATE].replace(
            "export function removeItem(",
            "export function unusedCanary(belt: never): unknown {\n"
            "  return beltTakeFromTile(belt, 0, 0, 0);\n"
            "}\n\nexport function removeItem(",
            1,
        )
        assert wired != originals[STATE]
        STATE.write_text(wired)
        passed, out = run_tests(LIVE)
        results.append(
            report(
                "a call site appears",
                not passed
                and "settles the one excuse that is a claim about the SIM rather than about this harness"
                in failing_names(out),
            )
        )
        STATE.write_text(originals[STATE])

        print("E. the name-blind guards, un-spread")
        for victim, label in ((SAVE, "save.test.ts"), (LIVE, "move-census-live.test.ts")):
            text = originals[victim]
            stripped = re.sub(r"\bworldDiff\(", "noWorldDiff(", text)
            stripped = re.sub(r"\bunfilledNumbers\(", "noUnfilledNumbers(", stripped)
            victim.write_text(stripped)
            passed, out = run_tests(CENSUS)
            results.append(
                report(
                    f"{label} stops asserting them",
                    not passed
                    and "keeps the two NAME-BLIND guards in more than one file, and says so out loud"
                    in failing_names(out),
                )
            )
            victim.write_text(text)
    finally:
        for path, text in originals.items():
            path.write_text(text)

    print(f"\n{sum(results)}/{len(results)} mutants caught")
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
