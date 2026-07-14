#!/usr/bin/env python3
"""Fetch USCRN sub-hourly data for the thermometer-shop validation.

The Thermometer Shop's weather is synthetic, so unlike the other labs it has
no page-served data. What it does have is a validation pipeline: its
simulated day's 5-minute temperature texture is checked against real US
Climate Reference Network sub-hourly (5-minute) records. This script fetches
the raw station-year files that check runs on; the comparison itself is
scripts/validate-thermometer-shop-cloud.mjs (it needs to import the lab's JS
model, hence Node).

Stations and year come from validation/thermometer-shop/stations.json —
near-sea-level stations (the synthetic baseline has no altitude), one per
cloud regime the validation distinguishes.

This lab's validation data directory is isolated — nothing here is read from
or written to any other lab's data. Fetch logic is shared via fetch_common.py.
The raw files (~14 MB per station-year) are git-ignored and re-fetchable.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from fetch_common import fetch_bytes

REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATION_DIR = REPO_ROOT / "validation" / "thermometer-shop"
DEFAULT_OUTPUT_DIR = VALIDATION_DIR / "data"

USCRN_SUBHOURLY_BASE = "https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01"

# 288 five-minute rows per day; used only as a sanity check on the download.
ROWS_PER_DAY = 288


def subhourly_filename(year: int, slug: str) -> str:
    return f"CRNS0101-05-{year}-{slug}.txt"


def subhourly_url(year: int, slug: str) -> str:
    return f"{USCRN_SUBHOURLY_BASE}/{year}/{subhourly_filename(year, slug)}"


def load_manifest(path: Path) -> dict:
    manifest = json.loads(path.read_text())
    if not manifest.get("stations"):
        raise ValueError(f"No stations in {path}")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--year",
        type=int,
        default=None,
        help="station-year to fetch (default: the year in stations.json)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"where to write the raw files (default: {DEFAULT_OUTPUT_DIR})",
    )
    args = parser.parse_args()

    manifest = load_manifest(VALIDATION_DIR / "stations.json")
    year = args.year or manifest["year"]
    args.output_dir.mkdir(parents=True, exist_ok=True)

    for station in manifest["stations"]:
        url = subhourly_url(year, station["slug"])
        out_path = args.output_dir / subhourly_filename(year, station["slug"])
        print(f"Fetching {station['label']} — {url}")
        data = fetch_bytes(url)
        rows = data.count(b"\n")
        if rows % ROWS_PER_DAY != 0:
            print(
                f"  WARNING: {rows} rows is not a whole number of days "
                f"({ROWS_PER_DAY}/day) — file may be truncated or mid-year",
                file=sys.stderr,
            )
        out_path.write_bytes(data)
        print(f"  wrote {out_path} ({len(data):,} bytes, {rows:,} rows)")

    print("\nNow run: npm run validate:thermometer-shop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
