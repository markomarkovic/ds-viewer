#!/usr/bin/env python3
"""Extract oracle values from the vendor's saved reports into expected.json.

Usage:
    tools/reports-to-json.py DIR          # DIR holds the two .docx; writes DIR/expected.json
    tools/reports-to-json.py DIR --dump   # print every table for label inspection

Deterministic, stdlib-only, no network. The .docx contain only derived
numbers, no waveform data, but expected.json still lives outside the repo
with the recordings it describes.
"""
import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
DATE_RE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")
NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
FULLWIDTH_COLON = "："  # the vendor's own "Label：value" separator


def doc_tables(path: Path) -> list[list[list[str]]]:
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    tables = []
    for tbl in root.iter(f"{W}tbl"):
        rows = []
        for tr in tbl.findall(f"{W}tr"):
            rows.append(
                [
                    "".join(t.text or "" for t in tc.iter(f"{W}t")).strip()
                    for tc in tr.findall(f"{W}tc")
                ]
            )
        tables.append(rows)
    return tables


def dump(tables: list[list[list[str]]], name: str) -> None:
    print(f"==== {name} ====")
    for ti, t in enumerate(tables):
        print(f"-- table {ti} --")
        for r in t:
            print(" | ".join(r))


def flatten(tables: list[list[list[str]]]) -> dict[str, str]:
    """Flatten every printed table into a label -> raw value-text map.

    The vendor prints values two ways, both observed in the real reports
    (see --dump): a self-contained cell "Label：value" using a FULL-WIDTH
    colon, or a plain label cell immediately followed by its value cell (no
    colon at all — e.g. "Avg.TV" | "199"). Device-setting cells like
    "Max. Pressure:25cmH2O" use a half-width colon baked into one cell and
    are deliberately left unsplit so they can never shadow the measured
    "Max. Pressure" | "8.5" pair cell used elsewhere in the same report.
    """
    out: dict[str, str] = {}
    for t in tables:
        for row in t:
            i = 0
            while i < len(row):
                cell = row[i]
                if FULLWIDTH_COLON in cell:
                    label, _, value = cell.partition(FULLWIDTH_COLON)
                    if label.strip():
                        out[label.strip()] = value.strip()
                    i += 1
                elif (
                    i + 1 < len(row)
                    and row[i + 1].strip()
                    and cell.strip()
                    and FULLWIDTH_COLON not in row[i + 1]
                ):
                    out[cell.strip()] = row[i + 1].strip()
                    i += 2
                else:
                    i += 1
    return out


def value_num(s: str) -> float:
    # I:E prints as "1 : 1.7" -> the x after the colon is the value we want.
    m = re.search(r":\s*(-?\d+(?:\.\d+)?)", s)
    if m:
        return float(m.group(1))
    m = NUM_RE.search(s)
    if not m:
        raise SystemExit(f"no number in {s!r}")
    return float(m.group(0))


def val(labels: dict[str, str], key: str) -> float:
    if key not in labels:
        raise SystemExit(f"label {key!r} not found; run with --dump and fix the key")
    return value_num(labels[key])


def iso(d: str, m: str, y: str) -> str:
    return f"{y}-{m}-{d}"


def duration_hours(cell: str) -> float:
    # H:M:S, minutes/seconds not always zero-padded (e.g. "9:5:7").
    hms = re.search(r"(\d+):(\d{1,2}):(\d{1,2})", cell)
    if hms:
        h, m, s = (int(g) for g in hms.groups())
        return round(h + m / 60 + s / 3600, 4)
    return float(NUM_RE.search(cell).group(0))


PCT = (("p50", 50), ("p90", 90), ("p95", 95))

# Known 11/08 values, straight from the spec; extraction must reproduce them.
SELFCHECK = {
    ("daily", "press", "p90"): 6.3,
    ("daily", "press", "p95"): 6.9,
    ("daily", "tv", "avg"): 199,
    ("daily", "tv", "p95"): 289,
    ("daily", "bpm", "avg"): 15.1,
    ("daily", "bpm", "p95"): 19.3,
    ("daily", "leak", "avg"): 14.8,
    ("daily", "ie", "p95"): 1.7,
    ("daily", "durationHours"): 7.48,
}


def parse_daily(tables) -> dict:
    labels = flatten(tables)
    return {
        "date": "2026-08-11",
        "durationHours": duration_hours(labels["Effective Duration"]),
        "press": {
            "avg": val(labels, "Avg. Pressure"),
            "max": val(labels, "Max. Pressure"),
            "min": val(labels, "Min. Pressure"),
            "p90": val(labels, "P90"),
            "p95": val(labels, "P95"),
        },
        "tv": {
            "avg": val(labels, "Avg.TV"),
            "p50": val(labels, "50% TV"),
            "p90": val(labels, "90% TV"),
            "p95": val(labels, "95% TV"),
        },
        "bpm": {
            "avg": val(labels, "BPM"),
            "p50": val(labels, "50% BPM"),
            "p90": val(labels, "90% BPM"),
            "p95": val(labels, "95% BPM"),
        },
        "leak": {
            "avg": val(labels, "Avg. Leakage"),
            "p50": val(labels, "50% Leakage"),
            "p90": val(labels, "90% Leakage"),
            "p95": val(labels, "95% Leakage"),
        },
        # the daily report prints no I:E average
        "ie": {
            "p50": val(labels, "50% I/E"),
            "p90": val(labels, "90% I/E"),
            "p95": val(labels, "95% I/E"),
        },
    }


def parse_statistical(tables) -> tuple[list[dict], dict]:
    nights = []
    for row in (r for t in tables for r in t):
        dm = DATE_RE.search(row[0]) if row else None
        if not dm or len(row) < 9:
            continue
        # columns: Date, Duration, Avg. Pressure, P90, P95, Max. Pressure,
        # AHI, Apnea, Avg. Leakage, Work Mode, Mask Fit
        nights.append(
            {
                "date": iso(*dm.groups()),
                "durationHours": duration_hours(row[1]),
                "pressAvg": value_num(row[2]),
                "p90": value_num(row[3]),
                "p95": value_num(row[4]),
                "max": value_num(row[5]),
                "ahi": value_num(row[6]),
                "apnea": int(value_num(row[7])),
                "leakAvg": value_num(row[8]),
            }
        )
    labels = flatten(tables)
    aggregates = {
        "tv": {p: val(labels, f"{pct}% Avg. TV") for p, pct in PCT},
        "bpm": {p: val(labels, f"{pct}% Avg. BPM") for p, pct in PCT},
        "ie": {p: val(labels, f"{pct}% Avg. I/E") for p, pct in PCT},
        "mv": {p: val(labels, f"{pct}% Avg. Minute Volume") for p, pct in PCT},
    }
    return nights, aggregates


def main() -> None:
    dirp = Path(sys.argv[1]).expanduser()
    daily_t = doc_tables(dirp / "Daily Report.docx")
    stat_t = doc_tables(dirp / "Statistical Report.docx")
    if "--dump" in sys.argv:
        dump(daily_t, "Daily Report")
        dump(stat_t, "Statistical Report")
        return
    daily = parse_daily(daily_t)
    nights, aggregates = parse_statistical(stat_t)
    out = {"daily": daily, "nights": nights, "aggregates": aggregates}
    for path, want in SELFCHECK.items():
        got = out
        for k in path:
            got = got[k]
        if abs(float(got) - float(want)) > 1e-9:
            raise SystemExit(f"selfcheck failed: {path} = {got}, expected {want}")
    (dirp / "expected.json").write_text(json.dumps(out, indent=2) + "\n")
    print(f"wrote {dirp / 'expected.json'} ({len(nights)} nights)")


if __name__ == "__main__":
    main()
