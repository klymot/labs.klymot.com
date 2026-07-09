#!/usr/bin/env python3
"""Fetch measured + modelled daily solar radiation for the Error Bars — Sunshine lab.

For each site in the pool the script fetches:
- the real pyranometer record from its national archive (DWD / KNMI / SMHI), and
- the ERA5-family reanalysis estimate for the same coordinates from the
  Open-Meteo Historical Weather API,

then aligns both onto one daily calendar and writes a per-site JSON file plus
a manifest to this lab's own data directory. The pool deliberately spans
surrounding built-up contexts, from remote mountain to city centre; built-up
context for each site comes from the nearest GHCN station in klymot.com's
station index (the same source behind the main site's built-up layers).

This lab's data directory is isolated — nothing here is read from or written
to any other lab's data. Fetch logic is shared via fetch_common.py.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import time
from pathlib import Path

from fetch_common import (
    bu_context_from_station,
    fetch_dwd_solar_daily,
    fetch_klymot_station_index,
    fetch_knmi_daily_radiation,
    fetch_open_meteo_daily,
    fetch_smhi_daily_radiation,
    nearest_klymot_station,
    open_meteo_rows,
    rows_to_calendar_values,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "error-bars-sunshine" / "data"

MEASURED_UNIT = "daily global horizontal irradiance (MJ/m²/day), pyranometer measurement"
MODELLED_UNIT = "daily shortwave radiation sum (MJ/m²/day), ERA5-family reanalysis via Open-Meteo"

SOURCE_LABELS = {
    "dwd": "Deutscher Wetterdienst (DWD) Climate Data Centre — daily global radiation FG_STRAHL (J/cm² ÷ 100 → MJ/m²)",
    "knmi": "Royal Netherlands Meteorological Institute (KNMI) daggegevens — daily global radiation Q (J/cm² ÷ 100 → MJ/m²)",
    "smhi": "Swedish Meteorological and Hydrological Institute (SMHI) open data — hourly global irradiance aggregated to daily MJ/m²",
}

# Pool spanning surrounding built-up contexts (remote mountain → city), all
# from freely downloadable national archives. start_date is the first year
# with pyranometer data at that site (per the archive's station inventory).
SITES = [
    {"key": "POT", "name": "Potsdam, Germany", "lat": 52.3812, "lon": 13.0622,
     "source_type": "dwd", "network_station": "03987", "start_date": "1946-01-01"},
    {"key": "HOH", "name": "Hohenpeißenberg, Germany", "lat": 47.8009, "lon": 11.0108,
     "source_type": "dwd", "network_station": "02290", "start_date": "1953-01-01"},
    {"key": "WUR", "name": "Würzburg, Germany", "lat": 49.7704, "lon": 9.9576,
     "source_type": "dwd", "network_station": "05705", "start_date": "1957-01-01"},
    {"key": "FIC", "name": "Fichtelberg, Germany", "lat": 50.4283, "lon": 12.9536,
     "source_type": "dwd", "network_station": "01358", "start_date": "1958-01-01"},
    {"key": "NOR", "name": "Norderney, Germany", "lat": 53.7123, "lon": 7.1519,
     "source_type": "dwd", "network_station": "03631", "start_date": "1964-01-01"},
    {"key": "DBL", "name": "De Bilt, Netherlands", "lat": 52.1017, "lon": 5.1783,
     "source_type": "knmi", "network_station": "260", "start_date": "1957-07-01"},
    {"key": "STO", "name": "Stockholm, Sweden", "lat": 59.3293, "lon": 18.0686,
     "source_type": "smhi", "network_station": "98735", "start_date": "1983-01-01"},
]


def fetch_measured(site: dict, start_date: str, end_date: str) -> list[dict]:
    source = site["source_type"]
    if source == "dwd":
        return fetch_dwd_solar_daily(site["network_station"], start_date, end_date)
    if source == "knmi":
        return fetch_knmi_daily_radiation(int(site["network_station"]), start_date, end_date)
    if source == "smhi":
        return fetch_smhi_daily_radiation(int(site["network_station"]), start_date, end_date)
    raise ValueError(f"Unknown source_type {source!r} for {site['key']}")


def coverage(values: list) -> float:
    return sum(1 for v in values if v is not None) / max(1, len(values))


def build_site_record(site: dict, end_date: str, stations: list[dict],
                      generated_at: str, today_iso: str, sleep_seconds: float) -> dict:
    start_date = site["start_date"]
    print(f"{site['key']} [{site['source_type']} {site['network_station']}]: "
          f"{start_date}..{end_date}", file=sys.stderr)

    measured_rows = fetch_measured(site, start_date, end_date)
    print(f"  {site['key']}: {len(measured_rows)} measured days", file=sys.stderr)

    daily_block = fetch_open_meteo_daily(
        site["lat"], site["lon"], start_date, end_date, ["shortwave_radiation_sum"],
    )
    time.sleep(sleep_seconds)
    modelled_rows = open_meteo_rows(daily_block, "shortwave_radiation_sum")
    print(f"  {site['key']}: {len(modelled_rows)} modelled days", file=sys.stderr)

    measured = rows_to_calendar_values(measured_rows, start_date, end_date)
    modelled = rows_to_calendar_values(modelled_rows, start_date, end_date)
    if coverage(measured) < 0.5:
        print(f"  Warning: {site['key']} measured coverage below 50%", file=sys.stderr)
    if coverage(modelled) < 0.9:
        print(f"  Warning: {site['key']} modelled coverage below 90%", file=sys.stderr)

    nearest = nearest_klymot_station(site["lat"], site["lon"], stations)

    return {
        "key": site["key"],
        "name": site["name"],
        "lat": site["lat"],
        "lon": site["lon"],
        "source_type": site["source_type"],
        "network_station": site["network_station"],
        "measured_source": SOURCE_LABELS[site["source_type"]],
        "modelled_source": "Open-Meteo Historical Weather API (ERA5-family reanalysis)",
        "generated_at": generated_at,
        "updated": today_iso,
        "start_date": start_date,
        "end_date": end_date,
        "bu_context": bu_context_from_station(nearest),
        "units": {"measured": MEASURED_UNIT, "modelled": MODELLED_UNIT},
        "daily": {
            "start": start_date,
            "end": end_date,
            "measured": measured,
            "modelled": modelled,
        },
    }


def reusable_existing_records(output_dir: Path, end_date: str) -> dict[str, dict]:
    reusable: dict[str, dict] = {}
    for json_file in output_dir.glob("*.json"):
        if json_file.stem == "manifest":
            continue
        try:
            record = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if record.get("end_date") == end_date and record.get("daily", {}).get("measured"):
            reusable[record["key"]] = record
    return reusable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--end-date", help="End date, YYYY-MM-DD. Defaults to yesterday UTC.")
    parser.add_argument("--sleep", type=float, default=0.8, help="Seconds to sleep between API calls")
    parser.add_argument("--refresh-existing", action="store_true", help="Refetch all sites")
    parser.add_argument("--only", help="Comma-separated site keys to fetch (default: all)")
    args = parser.parse_args()

    today = dt.date.today()
    end_date = args.end_date or (today - dt.timedelta(days=1)).isoformat()
    output_dir = Path(args.output)
    existing = {} if args.refresh_existing else reusable_existing_records(output_dir, end_date)
    only = set(args.only.split(",")) if args.only else None

    stations = fetch_klymot_station_index()
    generated_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    manifest_sites: list[dict] = []
    for site in SITES:
        if only and site["key"] not in only:
            continue
        existing_record = existing.get(site["key"])
        if existing_record and existing_record.get("start_date") == site["start_date"]:
            record = existing_record
            print(f"{site['key']}: reused existing data", file=sys.stderr)
        else:
            record = build_site_record(site, end_date, stations, generated_at,
                                       today.isoformat(), args.sleep)
        output_dir.mkdir(parents=True, exist_ok=True)
        site_file = output_dir / f"{site['key']}.json"
        site_file.write_text(json.dumps(record) + "\n", encoding="utf-8")
        print(f"  Wrote {site_file}", file=sys.stderr)
        manifest_sites.append({
            "key": record["key"],
            "name": record["name"],
            "source_type": record["source_type"],
            "network_station": record["network_station"],
            "start_year": int(record["start_date"][:4]),
            "bu_context": record.get("bu_context"),
        })

    manifest = {
        "generated_at": generated_at,
        "source": "Measured: DWD/KNMI/SMHI national archives. Modelled: ERA5-family reanalysis via Open-Meteo.",
        "bu_context_rule": (
            "Built-up context is that of the nearest GHCN station in klymot.com's "
            "station index, with its distance from the site recorded."
        ),
        "sites": manifest_sites,
    }
    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_file}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
