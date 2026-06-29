#!/usr/bin/env python3
"""Fetch shortwave radiation data and pair each location with a covering Klymot station.

Source: Open-Meteo Historical Weather API (ERA5 reanalysis), starting in 1940.

For every configured location the script:
- Fetches monthly shortwave_radiation_sum (MJ/m²) from Open-Meteo.
- Pairs the location with the nearest Klymot GHCN temperature station covering the full date range.
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

# Researched start years for the 17 stations whose "Time period" field in the catalog
# is missing ('?' or '-').  Confirmed entries carry a source URL in the comment.
# Unconfirmed entries fall back to 1976 (earliest year in the rest of the catalog).
STATION_START_OVERRIDES: dict[str, int] = {
    # Confirmed:
    "Valentia Observatory": 1954,   # https://www.met.ie/science/valentia/solar-radiation
    "Terra Nova Bay":        1987,  # Italian National Antarctic Program, first expedition 1986–87
    "Dongsha Atoll":         2010,  # NOAA GML DSI station, first sample date 2010-03-05
    "Summit Station":        2010,  # ICECAPS project, spring 2010 (NOAA/ARM)
    "Poprad-Ganovce":        1999,  # Slovak Hydrometeorological Institute (SHMI)
    "Zagreb-Maksimir":       2003,  # DHMZ Croatia systematic global-radiation monitoring
    # Unconfirmed — 1976 used as conservative baseline pending source verification:
    "Kishinev":     1976,
    "Heraklion":    1976,
    "Marguele":     1976,
    "Burgos":       1976,
    "Dobele":       1976,
    "Silutes":      1976,
    "Kauno":        1976,
    "Tajoura":      1976,
    "ENEA Casaccia": 1976,
    "ENEA Portici":  1976,
    "RSE Piacenza":  1976,
}

# Pre-catalog seed: origin point for the first documented pyranometer-class instrument
# (Ångström pyrheliometer, Stockholm 1893). The catalog's earliest parseable station
# start year is 1954 (Valentia Observatory, via STATION_START_OVERRIDES); the seed
# anchors the chart X-axis at the true network origin. The gap 1893→1954 reflects
# absent catalog data, not a period of no measurement activity.
PRE_CATALOG_SEEDS = [
    {"year": 1893, "active_stations": 1},
]
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "sunshine-temperature" / "data"

SOURCE = "Open-Meteo Historical Weather API (ERA5 reanalysis)"
SHORTWAVE_UNIT = (
    "monthly sum of daily shortwave_radiation_sum (MJ/m²); "
    "ERA5 downwelling shortwave radiation at the surface — "
    "equivalent to global horizontal irradiance as measured by a pyranometer"
)
STATION_PAIRING_RULE = (
    "Choose the nearest Klymot temperature station whose GHCN record starts no later "
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
            raise RuntimeError(f"Fixed station {fixed_id} for {location['key']} is not in Klymot index")
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
        raise RuntimeError(f"No Klymot station covers {location['key']} span {start_year}-{end_year}")

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
        # shortwave_radiation_sum: daily total downwelling shortwave in MJ/m²
        # (ERA5 reanalysis; equivalent to global horizontal irradiance from a pyranometer)
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

    print(f"Fetching Klymot station index from {KLYMOT_INDEX_URL}", file=sys.stderr)
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
        try:
            start_year = int(parts[0])
        except (ValueError, IndexError):
            # Missing start date — use researched override or skip.
            if name in STATION_START_OVERRIDES:
                start_year = STATION_START_OVERRIDES[name]
            else:
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

    full_series = PRE_CATALOG_SEEDS + series

    payload = {
        "source": "AssessingSolar/solarstations GitHub catalog",
        "source_url": pinned_url,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "methodology": (
            "Series begins with a hard-coded seed for the first documented pyranometer-class "
            "instrument (Ångström pyrheliometer, Stockholm 1893). Catalog-derived counts follow: "
            "a station is active in year Y if start_year ≤ Y and end_year (if present) ≥ Y. "
            "The 17 catalog stations whose Time Period field is blank use individually researched "
            "start years (see STATION_START_OVERRIDES in scripts/fetch_sunshine.py)."
        ),
        "note": (
            "The catalog covers stations documented by AssessingSolar; it is not exhaustive. "
            "The gap 1893–1954 reflects absent catalog data. The 1977–1980 spike reflects "
            "US NOAA/WEST regional campaigns that ended in 1980."
        ),
        "series": full_series,
    }
    counts_file = output_dir / "pyranometer-network-counts.json"
    counts_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {counts_file} ({len(stations)} stations, {len(series)} change-points, pinned={pinned_url})",
        file=sys.stderr,
    )


if __name__ == "__main__":
    raise SystemExit(main())
