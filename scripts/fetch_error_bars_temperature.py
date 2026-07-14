#!/usr/bin/env python3
"""Fetch modelled monthly temperature for the Error Bars — Temperature lab.

The lab compares GHCNm station records (fetched by the page at runtime from
klymot.com's data mirror) against the
ERA5-family reanalysis estimate for the same coordinates. This script fetches
the reanalysis side: daily 2 m maximum/minimum temperature from the Open-Meteo
Historical Weather API for each pool station's coordinates, aggregated to
monthly means of the daily (Tmax+Tmin)/2 midpoint — the same definition GHCNm
monthly means are built from, so the comparison is like-for-like on definition
(the midpoint-vs-true-mean question is a different lab's subject).

Station metadata and built-up context come from klymot.com's station index and
are written into a manifest for the page's station cards.

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
    fetch_klymot_station_index,
    fetch_open_meteo_daily,
    klymot_station_by_id,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "error-bars-temperature" / "data"

# ERA5 coverage starts in 1940; every pool station's GHCN record starts earlier,
# so the comparison window is 1940 → present at all of them.
MODELLED_START = "1940-01-01"

MODELLED_UNIT = (
    "monthly mean of daily (Tmax+Tmin)/2 (°C), ERA5-family reanalysis via "
    "Open-Meteo, aggregated to match the GHCNm monthly-mean definition"
)

# Span a wide range of 2020 built-up context; each has at least ~1000 GHCN
# monthly values from 1940 onward on both QCU and QCF, with only small gaps.
STATIONS = [
    {"id": "UK000003026", "name": "Stornoway Airport", "place": "Scotland, United Kingdom", "region": "Very low BU"},
    {"id": "DAM00006011", "name": "Torshavn", "place": "Faroe Islands", "region": "Very low BU"},
    {"id": "EI000003953", "name": "Valentia Observatory", "place": "Ireland", "region": "Low BU"},
    {"id": "USW00013733", "name": "Lynchburg Rgnl AP", "place": "Virginia, United States", "region": "Low BU"},
    {"id": "USW00014914", "name": "Fargo Hector Intl AP", "place": "North Dakota, United States", "region": "Low BU"},
    {"id": "GM000010962", "name": "Hohenpeissenberg", "place": "Bavaria, Germany", "region": "Moderate BU"},
    {"id": "NLM00006260", "name": "De Bilt", "place": "Netherlands", "region": "Moderate-high BU"},
    {"id": "AU000005010", "name": "Kremsmünster", "place": "Austria", "region": "Moderate-high BU"},
    {"id": "BE000006447", "name": "Uccle", "place": "Belgium", "region": "High BU"},
    {"id": "HUM00012843", "name": "Budapest Pestszentlörinc", "place": "Hungary", "region": "High BU"},
    {"id": "PO000008535", "name": "Lisbon Geophysical", "place": "Portugal", "region": "Very high BU"},
    {"id": "HR000142360", "name": "Zagreb Gric", "place": "Croatia", "region": "Very high BU"},
]


def monthly_midpoint_means(dates: list[str], tmax: list, tmin: list,
                           min_fraction: float = 0.9) -> dict[str, float]:
    """Monthly mean of daily (Tmax+Tmin)/2, keyed "YYYY-MM".

    A month only gets a value when at least min_fraction of its calendar days
    have both Tmax and Tmin — a month missing much of its record could be
    seasonally skewed.
    """
    sums: dict[str, float] = {}
    counts: dict[str, int] = {}
    days_in_month: dict[str, int] = {}
    for date, mx, mn in zip(dates, tmax, tmin):
        ym = date[:7]
        days_in_month[ym] = days_in_month.get(ym, 0) + 1
        if mx is None or mn is None:
            continue
        sums[ym] = sums.get(ym, 0.0) + (mx + mn) / 2.0
        counts[ym] = counts.get(ym, 0) + 1
    out: dict[str, float] = {}
    for ym, total_days in days_in_month.items():
        n = counts.get(ym, 0)
        if total_days and n / total_days >= min_fraction:
            out[ym] = round(sums[ym] / n, 2)
    return out


def month_range(start_ym: str, end_ym: str) -> list[str]:
    """Every "YYYY-MM" from start to end inclusive."""
    year, month = int(start_ym[:4]), int(start_ym[5:7])
    end_year, end_month = int(end_ym[:4]), int(end_ym[5:7])
    out = []
    while (year, month) <= (end_year, end_month):
        out.append(f"{year:04d}-{month:02d}")
        month += 1
        if month == 13:
            month = 1
            year += 1
    return out


def monthly_to_calendar_values(monthly: dict[str, float], start_ym: str, end_ym: str) -> list[float | None]:
    return [monthly.get(ym) for ym in month_range(start_ym, end_ym)]


def bu_context_of(entry: dict) -> dict:
    return {
        "bu_2020_idx": entry.get("bu_2020_idx"),
        "bu_2020_1km": entry.get("bu_2020_1km"),
        "bu_2020_5km": entry.get("bu_2020_5km"),
        "bu_2020_20km": entry.get("bu_2020_20km"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--end-date", help="End date, YYYY-MM-DD. Defaults to yesterday UTC.")
    parser.add_argument("--sleep", type=float, default=0.8, help="Seconds to sleep between API calls")
    args = parser.parse_args()

    today = dt.date.today()
    end_date = args.end_date or (today - dt.timedelta(days=1)).isoformat()
    # Only complete months can meet the coverage rule; stop at the last full month.
    end_ym_date = dt.date.fromisoformat(end_date).replace(day=1) - dt.timedelta(days=1)
    end_ym = end_ym_date.isoformat()[:7]
    start_ym = MODELLED_START[:7]

    output_dir = Path(args.output)
    index = fetch_klymot_station_index()
    generated_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")

    manifest_stations: list[dict] = []
    for station in STATIONS:
        entry = klymot_station_by_id(station["id"], index)
        if entry is None:
            print(f"Warning: {station['id']} not in klymot index; skipped", file=sys.stderr)
            continue
        station_elevation = entry.get("elevation_m")
        print(f"{station['id']} ({station['name']}): ERA5 daily {MODELLED_START}..{end_date}"
              f" at elevation {station_elevation} m",
              file=sys.stderr)
        # timezone=auto: daily extremes over local days, matching how the
        # station's own observing day is defined.
        # elevation: pass the station's true GHCN elevation so Open-Meteo
        # downscales ERA5 to it, rather than guessing from its DEM (which lands
        # ~100 m too high at coastal points and biases the model ~1 °C cold).
        daily = fetch_open_meteo_daily(
            entry["lat"], entry["lng"], MODELLED_START, end_date,
            ["temperature_2m_max", "temperature_2m_min"], timezone="auto",
            elevation=station_elevation,
        )
        time.sleep(args.sleep)
        monthly = monthly_midpoint_means(
            daily.get("time", []),
            daily.get("temperature_2m_max", []),
            daily.get("temperature_2m_min", []),
        )
        values = monthly_to_calendar_values(monthly, start_ym, end_ym)
        n_present = sum(1 for v in values if v is not None)
        print(f"  {station['id']}: {n_present} of {len(values)} months", file=sys.stderr)
        if n_present < 0.9 * len(values):
            print(f"  Warning: {station['id']} modelled coverage below 90%", file=sys.stderr)

        record = {
            "id": station["id"],
            "name": station["name"],
            "place": station["place"],
            "lat": entry["lat"],
            "lon": entry["lng"],
            "elevation_m": station_elevation,
            "modelled_elevation_m": station_elevation,
            "ghcn_first_year": entry.get("ghcn_first_year"),
            "ghcn_last_year": entry.get("ghcn_last_year"),
            "modelled_source": "Open-Meteo Historical Weather API (ERA5-family reanalysis)",
            "generated_at": generated_at,
            "updated": today.isoformat(),
            "bu_context": bu_context_of(entry),
            "units": {"modelled": MODELLED_UNIT},
            "monthly": {"start": start_ym, "end": end_ym, "modelled": values},
        }
        output_dir.mkdir(parents=True, exist_ok=True)
        station_file = output_dir / f"{station['id']}.json"
        station_file.write_text(json.dumps(record) + "\n", encoding="utf-8")
        print(f"  Wrote {station_file}", file=sys.stderr)

        manifest_stations.append({
            "id": station["id"],
            "name": station["name"],
            "place": station["place"],
            "region": station["region"],
            "since": entry.get("ghcn_first_year"),
            # lat lets the page name seasons by hemisphere (DJF is winter north
            # of the equator, summer south of it).
            "lat": entry["lat"],
            **bu_context_of(entry),
        })

    manifest = {
        "generated_at": generated_at,
        "source": (
            "Measured: NOAA GHCNm v4 monthly series fetched by the page from "
            "klymot.com's data mirror. Modelled: ERA5-family reanalysis via "
            "Open-Meteo, aggregated to the GHCNm monthly-mean definition."
        ),
        "pool_rule": (
            "Long-record GHCN stations spanning a wide range of 2020 built-up "
            "context, each with at least ~1000 monthly GHCN values from 1940 "
            "onward on both QCU and QCF for a full ERA5 comparison window."
        ),
        "stations": manifest_stations,
    }
    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_file}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
