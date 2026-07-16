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
    fetch_bytes,
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

# Graded reference pool: every station is characterised, not randomly sampled.
# The rural anchors are "Q0" co-located gold references — a long COOP record merged
# with its co-located successor into one homogeneous series, the handover verified
# by their overlap (e.g. Stillwater, operated on university property with an
# unbroken co-located transition). The rest are GSN/HCN reference-network stations
# (NOAA/WMO curated long records), drawn one per built-up grade so the pool spans
# open country → city and the station-vs-reanalysis match can be read across that
# gradient. Card labels ("region") expose only the setting, never the shape.
# Non-Q0 members drawn with OS-entropy seed 2003835860
# (tmp-investigation/take2/code/build_reference_pool.py). Q0 entries carry
# "composite": [coop_id, colocated_id] and are merged per calendar month.
STATIONS = [
    {"id": "USC00348501", "name": "Stillwater (co-located reference)", "place": "Oklahoma, United States", "region": "town", "composite": ["USC00348501", "USW00053926"]},
    {"id": "USC00012813", "name": "Fairhope (co-located reference)", "place": "Alabama, United States", "region": "rural", "composite": ["USC00012813", "USW00063869"]},
    {"id": "USC00402202", "name": "Crossville (co-located reference)", "place": "Tennessee, United States", "region": "rural", "composite": ["USC00402202", "USW00063855"]},
    {"id": "RSM00027648", "name": "Elatma", "place": "Russia", "region": "rural"},
    {"id": "USW00093729", "name": "Cape Hatteras", "place": "North Carolina, United States", "region": "town edge"},
    {"id": "JA000047817", "name": "Nagasaki", "place": "Japan", "region": "city"},
    {"id": "FR000007630", "name": "Toulouse-Blagnac Airport", "place": "France", "region": "city"},
    {"id": "USC00053005", "name": "Fort Collins", "place": "Colorado, United States", "region": "city"},
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


def fetch_klymot_qcu_monthly(station_id: str) -> dict[str, float]:
    """{"YYYY-MM": °C} from klymot's QCU CSV (integer hundredths; empty = missing)."""
    text = fetch_bytes(f"https://www.klymot.com/data/qcu/{station_id}.csv").decode("utf-8")
    out: dict[str, float] = {}
    for line in text.splitlines():
        parts = line.split(",")
        if not parts or not parts[0].strip().isdigit():
            continue
        year = int(parts[0])
        for mi, cell in enumerate(parts[1:13], start=1):
            cell = cell.strip()
            if not cell:
                continue
            try:
                value = int(cell)
            except ValueError:
                continue
            if abs(value) < 6000:  # guard against any sentinel leaking in
                out[f"{year:04d}-{mi:02d}"] = value / 100.0
    return out


MIN_OVERLAP_YEARS_PER_MONTH = 3


def build_composite(source_ids: list[str], start_ym: str, end_ym: str) -> dict:
    """Merge a co-located pair into one homogeneous series by an **overlap splice**
    (not averaging — averaging would bake a half-step into the join):

      * anchor on the newer reference station, unchanged;
      * shift the older record onto the new level by the mean (old − new) offset;
      * estimate that offset **per calendar month** (a 12-value vector), because a
        siting/exposure difference is usually seasonal, not a single constant —
        a month with < MIN_OVERLAP_YEARS_PER_MONTH overlapping years falls back to
        the pooled all-month offset;
      * if the two records never overlap, the shift is 0 and the merge is flagged
        uncorrected (nothing to anchor on).

    Handles internal gaps in either record — only months actually present are used,
    and a month absent from both is left None.
    """
    maps = {sid: fetch_klymot_qcu_monthly(sid) for sid in source_ids}
    # Newer reference = the record extending latest; the other is the older record.
    new_id = max(maps, key=lambda s: max(maps[s]) if maps[s] else "")
    old_id = next(s for s in source_ids if s != new_id)
    new, old = maps[new_id], maps[old_id]

    overlap = sorted(ym for ym in old if ym in new)
    pooled = (sum(old[ym] - new[ym] for ym in overlap) / len(overlap)) if overlap else 0.0
    by_month: dict[int, list[float]] = {m: [] for m in range(1, 13)}
    for ym in overlap:
        by_month[int(ym[5:7])].append(old[ym] - new[ym])
    offset_m: dict[int, float] = {}
    fallback = []
    for m in range(1, 13):
        if len(by_month[m]) >= MIN_OVERLAP_YEARS_PER_MONTH:
            offset_m[m] = sum(by_month[m]) / len(by_month[m])
        else:
            offset_m[m] = pooled
            if overlap:
                fallback.append(m)

    values: list[float | None] = []
    for ym in month_range(start_ym, end_ym):
        if ym in new:
            values.append(new[ym])                              # newer reference, unchanged
        elif ym in old:
            values.append(round(old[ym] - offset_m[int(ym[5:7])], 2))  # shifted onto new level
        else:
            values.append(None)

    note = ("no overlap — older record left uncorrected" if not overlap
            else "per-month splice" if not fallback
            else f"per-month splice; pooled fallback for months {fallback}")
    return {
        "values": values,
        "anchor_id": new_id, "shifted_id": old_id,
        "offset_by_month_c": {str(m): round(offset_m[m], 3) for m in range(1, 13)},
        "offset_pooled_c": round(pooled, 3),
        "overlap_years_by_month": {str(m): len(by_month[m]) for m in range(1, 13)},
        "overlap_months": len(overlap),
        "overlap_span": [overlap[0], overlap[-1]] if overlap else None,
        "note": note,
    }


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
    parser.add_argument("--skip-existing", action="store_true",
                        help="Skip the reanalysis fetch for stations whose JSON already exists "
                             "(resumable refresh; the manifest entry is still rebuilt).")
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
        output_dir.mkdir(parents=True, exist_ok=True)
        station_file = output_dir / f"{station['id']}.json"
        # Only skip when the existing JSON still matches the current config: a
        # composite entry needs a "measured" block, a plain entry must not have one.
        # A config change (composite added/removed) forces a refetch even under
        # --skip-existing, so the file and the manifest can't drift apart.
        skip = False
        if args.skip_existing and station_file.exists():
            try:
                existing = json.loads(station_file.read_text())
                skip = bool(existing.get("measured")) == bool(station.get("composite"))
            except (json.JSONDecodeError, OSError):
                skip = False
            if not skip:
                print(f"{station['id']}: composite config changed since JSON; refetching",
                      file=sys.stderr)
        if skip:
            print(f"{station['id']} ({station['name']}): JSON exists, skipping reanalysis fetch",
                  file=sys.stderr)
        else:
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
            if station.get("composite"):
                # Q0 gold reference: embed the overlap-spliced merged series so the
                # page uses it directly (no single klymot CSV for a composite).
                comp = build_composite(station["composite"], start_ym, end_ym)
                record["composite"] = station["composite"]
                record["composite_merge"] = {k: comp[k] for k in (
                    "anchor_id", "shifted_id", "offset_by_month_c", "offset_pooled_c",
                    "overlap_years_by_month", "overlap_months", "overlap_span", "note")}
                record["units"]["measured"] = ("co-located pair spliced onto the newer "
                                               "reference station's level (older record shifted by "
                                               "the per-month overlap offset), °C")
                record["measured"] = {"start": start_ym, "end": end_ym, "values": comp["values"]}
                n_meas = sum(1 for v in comp["values"] if v is not None)
                print(f"  {station['id']}: composite anchor={comp['anchor_id']} shift={comp['shifted_id']} "
                      f"pooled_offset={comp['offset_pooled_c']:+.3f}C over {comp['overlap_months']}mo — "
                      f"{comp['note']}; {n_meas} measured months", file=sys.stderr)
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
            "composite": bool(station.get("composite")),
            **bu_context_of(entry),
        })

    manifest = {
        "generated_at": generated_at,
        "source": (
            "Measured: NOAA GHCNm v4 monthly series fetched by the page from "
            "klymot.com's data mirror (co-located reference sites are merged "
            "per month and served with this file). Modelled: ERA5-family "
            "reanalysis via Open-Meteo, aggregated to the GHCNm monthly-mean "
            "definition."
        ),
        "pool_rule": (
            "Reference-grade long records only: GSN/HCN reference-network stations "
            "and co-located gold references (a COOP record merged with its "
            "co-located successor), each with a near-continuous annual record since "
            "1940, chosen to span built-up settings from open country to city."
        ),
        "stations": manifest_stations,
    }
    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_file}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
