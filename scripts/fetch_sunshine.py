#!/usr/bin/env python3
"""Fetch shortwave radiation data and pair each location with a covering GHCN station.

Source: Open-Meteo Historical Weather API, starting in 1940. Note: current data source is a placeholder pending integration of actual station measurement records.

For every configured location the script:
- Fetches monthly shortwave_radiation_sum (MJ/m²) from Open-Meteo.
- Pairs the location with the nearest GHCN temperature station (served via klymot.com) covering the full date range.
- Writes a per-station JSON file ({key}.json) to the output directory.
- Writes manifest.json listing all station keys.

Output files are consumed by the sunshine-temperature lab.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io
import json
import math
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from collections import defaultdict
from pathlib import Path


KLYMOT_INDEX_URL = "https://www.klymot.com/data/index.json"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Catalog source: AssessingSolar/solarstations on GitHub.
# The script fetches the latest main-branch CSV, resolves the commit hash via the
# GitHub API, and records the commit-pinned URL in the output JSON for reproducibility.
SOLARSTATIONS_GITHUB_REPO = "AssessingSolar/solarstations"
SOLARSTATIONS_GITHUB_API = (
    "https://api.github.com/repos/AssessingSolar/solarstations/"
    "commits?path=solarstations.csv&per_page=1"
)
SOLARSTATIONS_RAW_URL = (
    "https://raw.githubusercontent.com/AssessingSolar/solarstations/main/solarstations.csv"
)

# Start-year overrides applied before the catalog "Time period" is parsed.
# Used for two cases:
#   1. Stations with a missing period ('?' or '-'): catalog omits start date;
#      we supply it from independent research (source URL in comment).
#   2. Stations whose catalog period reflects only the modern instrument/data-
#      submission era, but whose *site* has a confirmed earlier measurement start.
#      The override replaces the start year; the catalog end year is preserved.
# Stations with a '?' period and NO confirmed start year are absent from this dict
# and will be skipped (not counted) per user policy.
STATION_START_OVERRIDES: dict[str, int] = {
    # Historical-era overrides (catalog records only modern data-submission start):
    "Norrköping":       1893,  # Ångström pyrheliometer, Stockholm 1893; Norrköping is SMHI national reference, still active
    "Davos":            1909,  # PMOD/WRC pyrheliometer operational from 1909; https://www.pmodwrc.ch/en/institute/pmod-wrc/
    "Tateno;Tsukuba":   1931,  # JMA solar radiation since 1931; Tateno is the JMA radiation reference; https://www.data.jma.go.jp/env/radiation/en/know_std_rad_e.html
    "Uccle":            1951,  # RMIB uninterrupted 30-min measurements from 1951; https://ui.adsabs.harvard.edu/abs/2010ems..confE..36J
    # Confirmed missing-period ('?' or '-') stations:
    "Valentia Observatory": 1954,  # https://www.met.ie/science/valentia/solar-radiation
    "Terra Nova Bay":       1987,  # Italian National Antarctic Program, first expedition 1986–87
    "Dongsha Atoll":        2010,  # NOAA GML DSI station, first sample date 2010-03-05
    "Summit Station":       2010,  # ICECAPS project, spring 2010 (NOAA/ARM)
    "Poprad-Ganovce":       1999,  # Slovak Hydrometeorological Institute (SHMI)
    "Zagreb-Maksimir":      2003,  # DHMZ Croatia systematic global-radiation monitoring
    # Remaining '?' stations: no confirmed start date — omitted (skipped by the fetch loop).
}

# Historical stations not present in the solarstations.org catalog at all but with
# documented measurement records.  These are appended to the catalog station list
# before computing annual counts.  Source URLs in comments.
EXTRA_HISTORICAL_STATIONS: list[dict] = [
    # Potsdam (DWD): global, diffuse and direct radiation since 1937.
    # https://pubmed.ncbi.nlm.nih.gov/17318610/ — UV reconstruction from 1893 references 1937 start
    {"name": "Potsdam (DWD)", "start": 1937, "end": None},
    # De Bilt (KNMI): solar radiation measurements from 1957.
    # https://dataplatform.knmi.nl/group/sunshine-and-radiation
    {"name": "De Bilt (KNMI)", "start": 1957, "end": None},
]
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "sunshine-temperature" / "data"

SOURCE = "Open-Meteo Historical Weather API (placeholder — to be replaced with actual station records)"
SHORTWAVE_UNIT = "monthly sum of daily shortwave_radiation_sum (MJ/m²); global horizontal irradiance"
STATION_PAIRING_RULE = (
    "Choose the nearest GHCN temperature station whose record starts no later "
    "than the sunshine start year and ends no earlier than the sunshine end year. "
    "Valentia is fixed to EI000003953."
)

DEFAULT_LOCATIONS = [
    {
        "key": "VAL",
        "name": "Valentia Observatory, Ireland",
        "lat": 51.9394,
        "lon": -10.2219,
        "start_date": "1940-01-01",
        "fixed_temp_station_id": "EI000003953",
    },
    {
        "key": "POT",
        "name": "Potsdam, Germany",
        "lat": 52.3833,
        "lon": 13.0639,
        "start_date": "1940-01-01",
    },
    {
        "key": "TOK",
        "name": "Tokyo, Japan",
        "lat": 35.683,
        "lon": 139.767,
        "start_date": "1940-01-01",
    },
    {
        "key": "STO",
        "name": "Stockholm, Sweden",
        "lat": 59.3293,
        "lon": 18.0686,
        "start_date": "1940-01-01",
    },
    {
        "key": "DAV",
        "name": "Davos, Switzerland",
        "lat": 46.8167,
        "lon": 9.85,
        "start_date": "1940-01-01",
    },
    {
        "key": "UCL",
        "name": "Uccle, Belgium",
        "lat": 50.7984,
        "lon": 4.3583,
        "start_date": "1951-01-01",
    },
    {
        "key": "DBL",
        "name": "De Bilt, Netherlands",
        "lat": 52.1017,
        "lon": 5.1783,
        "start_date": "1957-01-01",
    },
]


def fetch_json(url: str, timeout: int = 90, retries: int = 4) -> dict:
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == retries:
                raise
            wait_seconds = 10 * (attempt + 1)
            print(f"Rate limited by {urllib.parse.urlparse(url).netloc}; retrying in {wait_seconds}s", file=sys.stderr)
            time.sleep(wait_seconds)


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    radius = 6371.0088
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * radius * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def parse_year(date_string: str) -> int:
    return int(date_string[:4])


def choose_temperature_station(location: dict, stations: list[dict], start_year: int, end_year: int) -> dict:
    fixed_id = location.get("fixed_temp_station_id")
    if fixed_id:
        match = next((s for s in stations if s.get("id") == fixed_id), None)
        if not match:
            raise RuntimeError(f"Fixed station {fixed_id} for {location['key']} is not in GHCN index")
        if match.get("ghcn_first_year", 9999) > start_year or match.get("ghcn_last_year", 0) < end_year:
            raise RuntimeError(
                f"Fixed station {fixed_id} does not cover {start_year}-{end_year}: "
                f"{match.get('ghcn_first_year')}-{match.get('ghcn_last_year')}"
            )
        station = dict(match)
        station["distance_km"] = haversine_km(location["lat"], location["lon"], station["lat"], station["lng"])
        return station

    covering = [
        s for s in stations
        if s.get("category") == "station"
        and s.get("ghcn_first_year", 9999) <= start_year
        and s.get("ghcn_last_year", 0) >= end_year
        and "lat" in s and "lng" in s and "id" in s
    ]
    if not covering:
        raise RuntimeError(f"No GHCN station covers {location['key']} span {start_year}-{end_year}")

    best = min(covering, key=lambda s: haversine_km(location["lat"], location["lon"], s["lat"], s["lng"]))
    station = dict(best)
    station["distance_km"] = haversine_km(location["lat"], location["lon"], station["lat"], station["lng"])
    return station


def fetch_open_meteo_shortwave(location: dict, start_date: str, end_date: str) -> list[dict]:
    params = {
        "latitude": location["lat"],
        "longitude": location["lon"],
        "start_date": start_date,
        "end_date": end_date,
        # shortwave_radiation_sum: daily total downwelling shortwave in MJ/m² (global horizontal irradiance)
        "daily": "shortwave_radiation_sum",
        "timezone": "UTC",
    }
    url = f"{OPEN_METEO_ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
    data = fetch_json(url)
    daily = data.get("daily", {})
    dates = daily.get("time", [])
    radiation = daily.get("shortwave_radiation_sum", [])

    monthly: dict[str, dict] = defaultdict(lambda: {"shortwave_mj_m2": 0.0, "days": 0})
    for date_string, mj in zip(dates, radiation):
        if mj is None:
            continue
        month_key = date_string[:7]
        monthly[month_key]["shortwave_mj_m2"] += mj
        monthly[month_key]["days"] += 1

    monthly_rows = []
    for month_key in sorted(monthly):
        year, month = month_key.split("-")
        bucket = monthly[month_key]
        monthly_rows.append(
            {
                "year": int(year),
                "month": int(month),
                "shortwave_mj_m2": round(bucket["shortwave_mj_m2"], 2),
                "days": bucket["days"],
            }
        )
    return monthly_rows


def reusable_existing_records(output_dir: Path, end_date: str) -> dict[str, dict]:
    """Load per-station files from a previous run that already have the requested end_date."""
    reusable: dict[str, dict] = {}
    for json_file in output_dir.glob("*.json"):
        if json_file.stem == "manifest":
            continue
        try:
            record = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if record.get("end_date") == end_date and record.get("monthly"):
            reusable[record["key"]] = record
    return reusable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        default=str(DEFAULT_OUTPUT_DIR),
        help="Output directory for per-station JSON files and manifest.json",
    )
    parser.add_argument("--locations", help="Optional JSON file of sunshine locations")
    parser.add_argument("--start-date", help="Override all configured start dates, YYYY-MM-DD")
    parser.add_argument("--end-date", help="End date, YYYY-MM-DD. Defaults to yesterday UTC.")
    parser.add_argument("--sleep", type=float, default=0.8, help="Seconds to sleep between API calls")
    parser.add_argument(
        "--refresh-existing",
        action="store_true",
        help="Refetch stations already present in the output directory",
    )
    args = parser.parse_args()

    today = dt.date.today()
    end_date = args.end_date or (today - dt.timedelta(days=1)).isoformat()
    end_year = parse_year(end_date)

    output_dir = Path(args.output)
    existing = {} if args.refresh_existing else reusable_existing_records(output_dir, end_date)
    locations = DEFAULT_LOCATIONS
    if args.locations:
        locations = json.loads(Path(args.locations).read_text(encoding="utf-8"))

    print(f"Fetching GHCN station index from {KLYMOT_INDEX_URL}", file=sys.stderr)
    station_index = fetch_json(KLYMOT_INDEX_URL)
    stations = station_index["locations"]

    generated_at = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    station_keys: list[str] = []

    for location in locations:
        start_date = args.start_date or location["start_date"]
        start_year = parse_year(start_date)
        temp_station = choose_temperature_station(location, stations, start_year, end_year)
        print(
            f"{location['key']}: shortwave {start_date}..{end_date}; "
            f"temperature {temp_station['id']} {temp_station['name']} "
            f"({temp_station['ghcn_first_year']}-{temp_station['ghcn_last_year']}), "
            f"{temp_station['distance_km']:.1f} km",
            file=sys.stderr,
        )

        existing_record = existing.get(location["key"])
        if existing_record and existing_record.get("start_date") == start_date:
            monthly = existing_record["monthly"]
            print(f"{location['key']}: reused existing monthly shortwave data", file=sys.stderr)
        else:
            monthly = fetch_open_meteo_shortwave(location, start_date, end_date)
            time.sleep(args.sleep)

        record = {
            "key": location["key"],
            "name": location["name"],
            "lat": location["lat"],
            "lon": location["lon"],
            "source": SOURCE,
            "generated_at": generated_at,
            "start_date": start_date,
            "end_date": end_date,
            "temperature_station": {
                "id": temp_station["id"],
                "name": temp_station["name"],
                "lat": temp_station["lat"],
                "lon": temp_station["lng"],
                "elevation_m": temp_station.get("elevation_m"),
                "first_year": temp_station.get("ghcn_first_year"),
                "last_year": temp_station.get("ghcn_last_year"),
                "distance_km": round(temp_station["distance_km"], 2),
            },
            "units": {
                "shortwave_mj_m2": SHORTWAVE_UNIT,
            },
            "monthly": monthly,
        }

        output_dir.mkdir(parents=True, exist_ok=True)
        station_file = output_dir / f"{location['key']}.json"
        station_file.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(f"Wrote {station_file}", file=sys.stderr)
        station_keys.append(location["key"])

    manifest = {
        "generated_at": generated_at,
        "source": SOURCE,
        "station_pairing_rule": STATION_PAIRING_RULE,
        "stations": station_keys,
    }
    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_file}", file=sys.stderr)

    fetch_pyranometer_network_counts(output_dir)
    return 0


def _resolve_catalog_url() -> tuple[str, str]:
    """Return (raw_fetch_url, commit_pinned_url) for the solarstations catalog.

    Queries the GitHub API for the latest commit that touched solarstations.csv,
    then constructs a commit-pinned raw URL so the output JSON records exactly
    which version of the catalog was used.  Falls back to the main-branch URL on
    any network or parse error.
    """
    try:
        req = urllib.request.Request(
            SOLARSTATIONS_GITHUB_API,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "fetch_sunshine.py"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            commits = json.loads(resp.read())
        sha = commits[0]["sha"]
        raw_url = (
            f"https://raw.githubusercontent.com/{SOLARSTATIONS_GITHUB_REPO}/{sha}/solarstations.csv"
        )
        pinned_url = (
            f"https://github.com/{SOLARSTATIONS_GITHUB_REPO}/blob/{sha}/solarstations.csv"
        )
        return raw_url, pinned_url
    except Exception as exc:
        print(f"Warning: could not resolve catalog commit; using main branch ({exc})", file=sys.stderr)
        return SOLARSTATIONS_RAW_URL, SOLARSTATIONS_RAW_URL


def fetch_pyranometer_network_counts(output_dir: Path) -> None:
    """Download the AssessingSolar/solarstations catalog and write pyranometer-network-counts.json."""
    raw_url, pinned_url = _resolve_catalog_url()
    print(f"Fetching solarstations catalog from {raw_url}", file=sys.stderr)
    try:
        req = urllib.request.Request(raw_url, headers={"User-Agent": "fetch_sunshine.py"})
        with urllib.request.urlopen(req, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except Exception as exc:
        print(f"Warning: could not fetch solarstations catalog: {exc}", file=sys.stderr)
        return

    stations: list[dict] = []
    skipped_no_override = 0
    reader = csv.DictReader(io.StringIO(raw))
    for row in reader:
        name = row.get("Station name", "").strip()
        period = row.get("Time period", "").strip()
        parts = period.split("-")

        # Override check runs first — applies to stations with a researched/extended
        # start year regardless of what the catalog period says.
        if name in STATION_START_OVERRIDES:
            start_year = STATION_START_OVERRIDES[name]
        else:
            try:
                start_year = int(parts[0])
            except (ValueError, IndexError):
                skipped_no_override += 1
                print(
                    f"  Skipping {name!r}: no start date and no override entry",
                    file=sys.stderr,
                )
                continue

        end_year: int | None = None
        if len(parts) > 1 and parts[1].strip():
            try:
                end_year = int(parts[1].strip())
            except ValueError:
                pass
        stations.append({"start": start_year, "end": end_year})

    if skipped_no_override:
        print(
            f"Warning: {skipped_no_override} station(s) skipped (no start date, not in STATION_START_OVERRIDES)",
            file=sys.stderr,
        )

    # Append historical stations absent from the catalog entirely.
    for extra in EXTRA_HISTORICAL_STATIONS:
        stations.append({"start": extra["start"], "end": extra["end"]})
    print(
        f"Added {len(EXTRA_HISTORICAL_STATIONS)} extra historical station(s) not in catalog",
        file=sys.stderr,
    )

    current_year = dt.date.today().year
    series: list[dict] = []
    prev_count = -1
    for year in range(min(s["start"] for s in stations), current_year + 1):
        count = sum(
            1 for s in stations
            if s["start"] <= year and (s["end"] is None or s["end"] >= year)
        )
        if count != prev_count:
            series.append({"year": year, "active_stations": count})
            prev_count = count

    payload = {
        "source": "AssessingSolar/solarstations GitHub catalog",
        "source_url": pinned_url,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "methodology": (
            "Active station count per year from the AssessingSolar/solarstations catalog, "
            "supplemented by EXTRA_HISTORICAL_STATIONS (stations absent from the catalog with "
            "documented measurement records) and STATION_START_OVERRIDES (catalog stations whose "
            "period reflects only the modern data-submission era, corrected to the confirmed "
            "measurement start). A station is active in year Y if start_year ≤ Y and "
            "end_year (if present) ≥ Y. See scripts/fetch_sunshine.py for sources."
        ),
        "note": (
            "The solarstations.org catalog is not exhaustive and under-represents historical "
            "stations (it tracks data submissions, not measurement origins). Key corrections: "
            "Norrköping→1893 (Ångström origin), Davos→1909 (PMOD), Tateno→1931 (JMA), "
            "Potsdam 1937 and De Bilt 1957 added as extra stations, Uccle→1951. "
            "The 1977–1980 spike reflects US NOAA/WEST regional campaigns that ended in 1980."
        ),
        "series": series,
    }
    counts_file = output_dir / "pyranometer-network-counts.json"
    counts_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {counts_file} ({len(stations)} stations counted, {len(series)} change-points, pinned={pinned_url})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    raise SystemExit(main())
