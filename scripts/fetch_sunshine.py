#!/usr/bin/env python3
"""Fetch shortwave radiation data and pair each location with a covering GHCN station.

Data sources used:
  POT (Potsdam): DWD Climate Data Centre — FG_STRAHL (real pyranometer, from 1947)
  DBL (De Bilt): KNMI daggegevens — Q global radiation (real pyranometer, from 1957-07)
  STO (Stockholm): SMHI open data — hourly W/m² aggregated to daily MJ/m² (from 1983)
  DAV, TOK, UCL, VAL: Open-Meteo Historical Weather API (placeholder — real station
    data not freely accessible without registration or proprietary API access)

For every configured location the script:
- Fetches daily GHI (MJ/m²) from the appropriate source above.
- Pairs the location with the nearest GHCN temperature station (served via klymot.com)
  covering the full date range.
- Writes a per-station JSON file ({key}.json) to the output directory.
- Writes manifest.json listing all station keys.

Output files are consumed by the sunshine-temperature lab.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import io as io_module
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path


KLYMOT_INDEX_URL = "https://www.klymot.com/data/index.json"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"

# Catalog source: AssessingSolar/solarstations on GitHub.
SOLARSTATIONS_GITHUB_REPO = "AssessingSolar/solarstations"
SOLARSTATIONS_GITHUB_API = (
    "https://api.github.com/repos/AssessingSolar/solarstations/"
    "commits?path=solarstations.csv&per_page=1"
)
SOLARSTATIONS_RAW_URL = (
    "https://raw.githubusercontent.com/AssessingSolar/solarstations/main/solarstations.csv"
)

STATION_START_OVERRIDES: dict[str, int] = {
    "Norrköping":            1893,
    "Davos":                 1909,
    "Tateno;Tsukuba":        1931,
    "Uccle":                 1951,
    "Valentia Observatory":  1954,
    "Terra Nova Bay":        1987,
    "Dongsha Atoll":         2010,
    "Summit Station":        2010,
    "Poprad-Ganovce":        1999,
    "Zagreb-Maksimir":       2003,
}

EXTRA_HISTORICAL_STATIONS: list[dict] = [
    {"name": "Potsdam (DWD)", "start": 1937, "end": None},
    {"name": "De Bilt (KNMI)", "start": 1957, "end": None},
]

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = REPO_ROOT / "public" / "sunshine-temperature" / "data"

SHORTWAVE_UNIT = "daily global horizontal irradiance (MJ/m²/day)"
STATION_PAIRING_RULE = (
    "Choose the nearest GHCN temperature station whose record starts no later "
    "than the sunshine start year and ends no earlier than the sunshine end year. "
    "Valentia is fixed to EI000003953."
)

# Source strings per source_type — written into each station's JSON.
SOURCE_LABELS = {
    "dwd":        "Deutscher Wetterdienst (DWD) Climate Data Centre — daily global radiation FG_STRAHL, station 03987 Potsdam (real pyranometer measurements from 1947)",
    "knmi":       "Royal Netherlands Meteorological Institute (KNMI) — daily global radiation Q, station De Bilt 260 (real pyranometer measurements from 1957)",
    "smhi":       "Swedish Meteorological and Hydrological Institute (SMHI) — hourly global irradiance aggregated to daily MJ/m², station 98735 Stockholm Sol (real pyranometer measurements from 1983)",
    "open_meteo": "Open-Meteo Historical Weather API (placeholder — gridded model/reanalysis data; real pyranometer records not freely accessible without registration for this station)",
}

DEFAULT_LOCATIONS = [
    {
        "key": "VAL",
        "name": "Valentia Observatory, Ireland",
        "lat": 51.9394,
        "lon": -10.2219,
        "start_date": "1940-01-01",
        "fixed_temp_station_id": "EI000003953",
        "source_type": "open_meteo",
    },
    {
        "key": "POT",
        "name": "Potsdam, Germany",
        "lat": 52.3833,
        "lon": 13.0639,
        "start_date": "1940-01-01",
        "source_type": "dwd",
    },
    {
        "key": "TOK",
        "name": "Tokyo, Japan",
        "lat": 35.683,
        "lon": 139.767,
        "start_date": "1940-01-01",
        "source_type": "open_meteo",
    },
    {
        "key": "STO",
        "name": "Stockholm, Sweden",
        "lat": 59.3293,
        "lon": 18.0686,
        "start_date": "1940-01-01",
        "source_type": "smhi",
    },
    {
        "key": "DAV",
        "name": "Davos, Switzerland",
        "lat": 46.8167,
        "lon": 9.85,
        "start_date": "1940-01-01",
        "source_type": "open_meteo",
    },
    {
        "key": "UCL",
        "name": "Uccle, Belgium",
        "lat": 50.7984,
        "lon": 4.3583,
        "start_date": "1951-01-01",
        "source_type": "open_meteo",
    },
    {
        "key": "DBL",
        "name": "De Bilt, Netherlands",
        "lat": 52.1017,
        "lon": 5.1783,
        "start_date": "1957-01-01",
        "source_type": "knmi",
    },
]


# ── Real-data fetchers ──────────────────────────────────────────────────────

def fetch_dwd_solar_potsdam(start_date: str, end_date: str) -> list[dict]:
    """DWD CDC: real pyranometer data for Potsdam, station 03987.

    FG_STRAHL = daily total global (shortwave) radiation in J/cm².
    Divide by 100 to convert to MJ/m².
    Data available from 1947-01-01.
    """
    url = (
        "https://opendata.dwd.de/climate_environment/CDC/"
        "observations_germany/climate/daily/solar/"
        "tageswerte_ST_03987_row.zip"
    )
    print("  Downloading DWD Potsdam solar ZIP...", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "fetch_sunshine.py"})
    with urllib.request.urlopen(req, timeout=90) as resp:
        zip_bytes = resp.read()

    start_dt = dt.date.fromisoformat(start_date)
    end_dt = dt.date.fromisoformat(end_date)
    rows: list[dict] = []

    with zipfile.ZipFile(io_module.BytesIO(zip_bytes)) as zf:
        data_name = next(n for n in zf.namelist() if n.startswith("produkt_"))
        with zf.open(data_name) as f:
            content = f.read().decode("latin-1")

    reader = csv.DictReader(io_module.StringIO(content), delimiter=";")
    for row in reader:
        date_str = row.get("MESS_DATUM", "").strip()
        fg_str = row.get("FG_STRAHL", "").strip()
        if not date_str or not fg_str or fg_str == "-999":
            continue
        try:
            date = dt.datetime.strptime(date_str, "%Y%m%d").date()
        except ValueError:
            continue
        if date < start_dt or date > end_dt:
            continue
        try:
            mj = round(float(fg_str) / 100.0, 3)
        except ValueError:
            continue
        rows.append({"date": date.isoformat(), "shortwave_mj_m2": mj})

    return rows


def fetch_knmi_de_bilt(start_date: str, end_date: str) -> list[dict]:
    """KNMI daggegevens: real pyranometer data for De Bilt, station 260.

    Q = daily global radiation in J/cm².
    Divide by 100 to convert to MJ/m².
    Data available from 1957-07-01.
    """
    start_str = start_date.replace("-", "")
    end_str = end_date.replace("-", "")
    url = (
        f"https://daggegevens.knmi.nl/klimatologie/daggegevens"
        f"?stns=260&vars=Q&start={start_str}&end={end_str}&type=txt"
    )
    print("  Fetching KNMI De Bilt radiation...", file=sys.stderr)
    with urllib.request.urlopen(url, timeout=60) as resp:
        content = resp.read().decode("utf-8")

    rows: list[dict] = []
    for line in content.splitlines():
        line = line.strip()
        if not line.startswith("260"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[2]:
            continue
        try:
            date = dt.datetime.strptime(parts[1], "%Y%m%d").date()
            mj = round(float(parts[2]) / 100.0, 3)
        except (ValueError, IndexError):
            continue
        rows.append({"date": date.isoformat(), "shortwave_mj_m2": mj})

    return rows


def fetch_smhi_stockholm(start_date: str, end_date: str) -> list[dict]:
    """SMHI open data: real pyranometer data for Stockholm Sol, station 98735.

    Parameter 11 = Global Irradians, hourly W/m².
    Sum hourly values × 3600 s / 1 000 000 = MJ/m²/day.
    Data available from 1983-01-01.
    """
    url = (
        "https://opendata-download-metobs.smhi.se/api/version/1.0/"
        "parameter/11/station/98735/period/corrected-archive/data.csv"
    )
    print("  Fetching SMHI Stockholm hourly radiation (may take a moment)...", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "fetch_sunshine.py"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        content = resp.read().decode("utf-8-sig")

    lines = content.splitlines()
    # Skip header block until the data header line
    try:
        data_start = next(i for i, l in enumerate(lines) if l.startswith("Datum;Tid"))
    except StopIteration:
        print("  Warning: SMHI data header not found", file=sys.stderr)
        return []

    start_dt = dt.date.fromisoformat(start_date)
    end_dt = dt.date.fromisoformat(end_date)
    daily_hourly: dict[str, list[float]] = defaultdict(list)

    for line in lines[data_start + 1:]:
        if not line.strip():
            continue
        parts = line.split(";")
        if len(parts) < 3:
            continue
        date_str = parts[0].strip()
        val_str = parts[2].strip()
        if not date_str or not val_str:
            continue
        try:
            date = dt.date.fromisoformat(date_str)
        except ValueError:
            continue
        if date < start_dt or date > end_dt:
            continue
        try:
            daily_hourly[date.isoformat()].append(float(val_str))
        except ValueError:
            continue

    rows: list[dict] = []
    for date_iso, hourly_vals in sorted(daily_hourly.items()):
        # Each value is 1-hour mean W/m²; × 3600 s / 1e6 = MJ/m² per hour; sum = daily total
        mj = round(sum(v * 3600 / 1e6 for v in hourly_vals), 3)
        rows.append({"date": date_iso, "shortwave_mj_m2": mj})

    return rows


# ── Open-Meteo fallback ─────────────────────────────────────────────────────

def fetch_open_meteo_shortwave(location: dict, start_date: str, end_date: str) -> list[dict]:
    """Open-Meteo Historical Weather API — gridded model data, used as placeholder."""
    params = {
        "latitude": location["lat"],
        "longitude": location["lon"],
        "start_date": start_date,
        "end_date": end_date,
        "daily": "shortwave_radiation_sum",
        "timezone": "UTC",
    }
    url = f"{OPEN_METEO_ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
    data = fetch_json(url)
    daily_data = data.get("daily", {})
    dates = daily_data.get("time", [])
    radiation = daily_data.get("shortwave_radiation_sum", [])

    rows = []
    for date_string, mj in zip(dates, radiation):
        if mj is None or (isinstance(mj, float) and math.isnan(mj)):
            continue
        rows.append({"date": date_string, "shortwave_mj_m2": round(mj, 3)})
    return rows


# ── Utilities ───────────────────────────────────────────────────────────────

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


def reusable_existing_records(output_dir: Path, end_date: str) -> dict[str, dict]:
    reusable: dict[str, dict] = {}
    for json_file in output_dir.glob("*.json"):
        if json_file.stem == "manifest":
            continue
        try:
            record = json.loads(json_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if record.get("end_date") == end_date and record.get("daily"):
            reusable[record["key"]] = record
    return reusable


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT_DIR))
    parser.add_argument("--locations", help="Optional JSON file of sunshine locations")
    parser.add_argument("--start-date", help="Override all configured start dates, YYYY-MM-DD")
    parser.add_argument("--end-date", help="End date, YYYY-MM-DD. Defaults to yesterday UTC.")
    parser.add_argument("--sleep", type=float, default=0.8, help="Seconds to sleep between API calls")
    parser.add_argument("--refresh-existing", action="store_true", help="Refetch all stations")
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
        source_type = location.get("source_type", "open_meteo")
        source_label = SOURCE_LABELS.get(source_type, SOURCE_LABELS["open_meteo"])

        temp_station = choose_temperature_station(location, stations, start_year, end_year)
        print(
            f"{location['key']} [{source_type}]: shortwave {start_date}..{end_date}; "
            f"temperature {temp_station['id']} {temp_station['name']} "
            f"({temp_station['ghcn_first_year']}-{temp_station['ghcn_last_year']}), "
            f"{temp_station['distance_km']:.1f} km",
            file=sys.stderr,
        )

        existing_record = existing.get(location["key"])
        if (existing_record
                and existing_record.get("start_date") == start_date
                and existing_record.get("source_type") == source_type):
            daily = existing_record["daily"]
            print(f"  {location['key']}: reused existing data", file=sys.stderr)
        else:
            if source_type == "dwd":
                daily = fetch_dwd_solar_potsdam(start_date, end_date)
            elif source_type == "knmi":
                daily = fetch_knmi_de_bilt(start_date, end_date)
            elif source_type == "smhi":
                daily = fetch_smhi_stockholm(start_date, end_date)
            else:
                daily = fetch_open_meteo_shortwave(location, start_date, end_date)
                time.sleep(args.sleep)

        print(f"  {location['key']}: {len(daily)} daily rows", file=sys.stderr)

        record = {
            "key": location["key"],
            "name": location["name"],
            "lat": location["lat"],
            "lon": location["lon"],
            "source": source_label,
            "source_type": source_type,
            "generated_at": generated_at,
            "updated": today.isoformat(),
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
            "daily": daily,
        }

        output_dir.mkdir(parents=True, exist_ok=True)
        station_file = output_dir / f"{location['key']}.json"
        station_file.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
        print(f"  Wrote {station_file}", file=sys.stderr)
        station_keys.append(location["key"])

    manifest_source = "Mixed: DWD (POT), KNMI (DBL), SMHI (STO), Open-Meteo placeholder (VAL, TOK, DAV, UCL)"
    manifest = {
        "generated_at": generated_at,
        "source": manifest_source,
        "station_pairing_rule": STATION_PAIRING_RULE,
        "stations": station_keys,
    }
    manifest_file = output_dir / "manifest.json"
    manifest_file.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {manifest_file}", file=sys.stderr)

    fetch_pyranometer_network_counts(output_dir)
    return 0


# ── Pyranometer network history ─────────────────────────────────────────────

def _resolve_catalog_url() -> tuple[str, str]:
    try:
        req = urllib.request.Request(
            SOLARSTATIONS_GITHUB_API,
            headers={"Accept": "application/vnd.github+json", "User-Agent": "fetch_sunshine.py"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            commits = json.loads(resp.read())
        sha = commits[0]["sha"]
        raw_url = f"https://raw.githubusercontent.com/{SOLARSTATIONS_GITHUB_REPO}/{sha}/solarstations.csv"
        pinned_url = f"https://github.com/{SOLARSTATIONS_GITHUB_REPO}/blob/{sha}/solarstations.csv"
        return raw_url, pinned_url
    except Exception as exc:
        print(f"Warning: could not resolve catalog commit; using main branch ({exc})", file=sys.stderr)
        return SOLARSTATIONS_RAW_URL, SOLARSTATIONS_RAW_URL


def fetch_pyranometer_network_counts(output_dir: Path) -> None:
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
    reader = csv.DictReader(io_module.StringIO(raw))
    for row in reader:
        name = row.get("Station name", "").strip()
        period = row.get("Time period", "").strip()
        parts = period.split("-")

        if name in STATION_START_OVERRIDES:
            start_year = STATION_START_OVERRIDES[name]
        else:
            try:
                start_year = int(parts[0])
            except (ValueError, IndexError):
                skipped_no_override += 1
                print(f"  Skipping {name!r}: no start date and no override entry", file=sys.stderr)
                continue

        end_year: int | None = None
        if len(parts) > 1 and parts[1].strip():
            try:
                end_year = int(parts[1].strip())
            except ValueError:
                pass
        stations.append({"start": start_year, "end": end_year})

    if skipped_no_override:
        print(f"Warning: {skipped_no_override} station(s) skipped", file=sys.stderr)

    for extra in EXTRA_HISTORICAL_STATIONS:
        stations.append({"start": extra["start"], "end": extra["end"]})
    print(f"Added {len(EXTRA_HISTORICAL_STATIONS)} extra historical station(s)", file=sys.stderr)

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
            "supplemented by EXTRA_HISTORICAL_STATIONS and STATION_START_OVERRIDES."
        ),
        "note": (
            "The solarstations.org catalog is not exhaustive and under-represents historical "
            "stations. Key corrections: Norrköping→1893, Davos→1909, Tateno→1931, "
            "Potsdam 1937 and De Bilt 1957 added as extra stations, Uccle→1951. "
            "The 1977–1980 spike reflects US NOAA/WEST regional campaigns that ended in 1980."
        ),
        "series": series,
    }
    counts_file = output_dir / "pyranometer-network-counts.json"
    counts_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {counts_file} ({len(stations)} stations, {len(series)} change-points)", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
