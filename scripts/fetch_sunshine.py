#!/usr/bin/env python3
"""Fetch QC sunshine data and pair each location with a covering Klymot station.

Default source: Open-Meteo Historical Weather API, starting in 1940.

The output is consumed by docs/sunshine-temperature/index.html. For every configured sunshine location,
the script chooses the nearest Klymot temperature station whose GHCN record covers
the requested sunshine time span. Valentia is pinned to EI000003953.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
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
REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = REPO_ROOT / "public" / "sunshine-temperature" / "data" / "sunshine-qc.json"

DEFAULT_LOCATIONS = [
    {
        "key": "VAL",
        "name": "Valentia Observatory, Ireland",
        "lat": 51.9394,
        "lon": -10.2219,
        "start_date": "1940-01-01",
        "fixed_temp_station_id": "EI000003953",
        "sunshine_source": "Open-Meteo historical",
    },
    {
        "key": "POT",
        "name": "Potsdam, Germany",
        "lat": 52.3833,
        "lon": 13.0639,
        "start_date": "1940-01-01",
        "sunshine_source": "Open-Meteo historical",
    },
    {
        "key": "TOK",
        "name": "Tokyo, Japan",
        "lat": 35.683,
        "lon": 139.767,
        "start_date": "1940-01-01",
        "sunshine_source": "Open-Meteo historical",
    },
    {
        "key": "STO",
        "name": "Stockholm, Sweden",
        "lat": 59.3293,
        "lon": 18.0686,
        "start_date": "1940-01-01",
        "sunshine_source": "Open-Meteo historical",
    },
    {
        "key": "DAV",
        "name": "Davos, Switzerland",
        "lat": 46.8167,
        "lon": 9.85,
        "start_date": "1940-01-01",
        "sunshine_source": "Open-Meteo historical",
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
        match = next((station for station in stations if station.get("id") == fixed_id), None)
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
        station
        for station in stations
        if station.get("category") == "station"
        and station.get("ghcn_first_year", 9999) <= start_year
        and station.get("ghcn_last_year", 0) >= end_year
        and "lat" in station
        and "lng" in station
        and "id" in station
    ]
    if not covering:
        raise RuntimeError(f"No Klymot station covers {location['key']} sunshine span {start_year}-{end_year}")

    best = min(
        covering,
        key=lambda station: haversine_km(location["lat"], location["lon"], station["lat"], station["lng"]),
    )
    station = dict(best)
    station["distance_km"] = haversine_km(location["lat"], location["lon"], station["lat"], station["lng"])
    return station


def fetch_open_meteo_sunshine(location: dict, start_date: str, end_date: str) -> tuple[list[dict], list[dict]]:
    params = {
        "latitude": location["lat"],
        "longitude": location["lon"],
        "start_date": start_date,
        "end_date": end_date,
        # sunshine_duration: seconds of bright sunshine per day (threshold ~120 W/m², Campbell-Stokes equivalent)
        # shortwave_radiation_sum: daily total downwelling shortwave radiation in MJ/m² (ERA5 reanalysis;
        #   equivalent to what a pyranometer records as global horizontal irradiance)
        "daily": "sunshine_duration,shortwave_radiation_sum",
        "timezone": "UTC",
    }
    url = f"{OPEN_METEO_ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
    data = fetch_json(url)
    daily = data.get("daily", {})
    dates = daily.get("time", [])
    sunshine_seconds = daily.get("sunshine_duration", [])
    radiation = daily.get("shortwave_radiation_sum", [])

    daily_rows = []
    monthly = defaultdict(lambda: {"sunshine_hours": 0.0, "shortwave_mj_m2": 0.0, "days": 0})
    for date_string, seconds, mj in zip(dates, sunshine_seconds, radiation):
        if seconds is None and mj is None:
            continue
        sunshine_hours = (seconds or 0) / 3600
        shortwave_mj_m2 = mj or 0
        daily_rows.append(
            {
                "date": date_string,
                "sunshine_hours": round(sunshine_hours, 2),
                "shortwave_mj_m2": round(shortwave_mj_m2, 2),
            }
        )
        month_key = date_string[:7]
        bucket = monthly[month_key]
        bucket["sunshine_hours"] += sunshine_hours
        bucket["shortwave_mj_m2"] += shortwave_mj_m2
        bucket["days"] += 1

    monthly_rows = []
    for month_key in sorted(monthly):
        year, month = month_key.split("-")
        item = monthly[month_key]
        monthly_rows.append(
            {
                "year": int(year),
                "month": int(month),
                "sunshine_hours": round(item["sunshine_hours"], 2),
                "shortwave_mj_m2": round(item["shortwave_mj_m2"], 2),
                "days": item["days"],
            }
        )
    return monthly_rows, daily_rows


def write_csv(output_json: Path, records: list[dict]) -> None:
    csv_path = output_json.with_suffix(".csv")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "station_key",
                "year",
                "month",
                "sunshine_hours",
                "shortwave_mj_m2",
                "days",
                "temperature_station_id",
            ]
        )
        for record in records:
            station_id = record["temperature_station"]["id"]
            for row in record["monthly"]:
                writer.writerow(
                    [
                        record["key"],
                        row["year"],
                        row["month"],
                        row["sunshine_hours"],
                        row["shortwave_mj_m2"],
                        row["days"],
                        station_id,
                    ]
                )


def reusable_existing_records(output: Path, end_date: str) -> dict[str, dict]:
    if not output.exists():
        return {}
    try:
        payload = json.loads(output.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}

    reusable = {}
    for record in payload.get("stations", []):
        if record.get("end_date") == end_date and record.get("monthly") and record.get("daily"):
            reusable[record["key"]] = record
    return reusable


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Output JSON path")
    parser.add_argument("--locations", help="Optional JSON file of sunshine locations")
    parser.add_argument("--start-date", help="Override all configured start dates, YYYY-MM-DD")
    parser.add_argument("--end-date", help="End date, YYYY-MM-DD. Defaults to yesterday UTC.")
    parser.add_argument("--sleep", type=float, default=0.8, help="Seconds to sleep between API calls")
    parser.add_argument("--refresh-existing", action="store_true", help="Refetch stations already present in the output")
    args = parser.parse_args()

    today = dt.date.today()
    end_date = args.end_date or (today - dt.timedelta(days=1)).isoformat()
    end_year = parse_year(end_date)

    output = Path(args.output)
    existing = {} if args.refresh_existing else reusable_existing_records(output, end_date)
    locations = DEFAULT_LOCATIONS
    if args.locations:
        locations = json.loads(Path(args.locations).read_text(encoding="utf-8"))

    print(f"Fetching Klymot station index from {KLYMOT_INDEX_URL}", file=sys.stderr)
    station_index = fetch_json(KLYMOT_INDEX_URL)
    stations = station_index["locations"]

    records = []
    for location in locations:
        start_date = args.start_date or location["start_date"]
        start_year = parse_year(start_date)
        temp_station = choose_temperature_station(location, stations, start_year, end_year)
        print(
            f"{location['key']}: sunshine {start_date}..{end_date}; "
            f"temperature {temp_station['id']} {temp_station['name']} "
            f"({temp_station['ghcn_first_year']}-{temp_station['ghcn_last_year']}), "
            f"{temp_station['distance_km']:.1f} km",
            file=sys.stderr,
        )
        existing_record = existing.get(location["key"])
        if existing_record and existing_record.get("start_date") == start_date:
            monthly = existing_record["monthly"]
            daily = existing_record["daily"]
            print(f"{location['key']}: reused existing monthly sunshine data", file=sys.stderr)
        else:
            monthly, daily = fetch_open_meteo_sunshine(location, start_date, end_date)
        records.append(
            {
                "key": location["key"],
                "name": location["name"],
                "lat": location["lat"],
                "lon": location["lon"],
                "source": location["sunshine_source"],
                "qc": True,
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
                "monthly": monthly,
                "daily": daily,
            }
        )
        time.sleep(args.sleep)

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "source": "Open-Meteo Historical Weather API (ERA5 reanalysis)",
        "units": {
            "sunshine_hours": "monthly sum of daily sunshine duration (hours); bright-sunshine threshold ~120 W/m²",
            "shortwave_mj_m2": (
                "monthly sum of daily shortwave_radiation_sum (MJ/m²); ERA5 downwelling shortwave radiation "
                "at the surface — equivalent to global horizontal irradiance as measured by a pyranometer"
            ),
        },
        "variable_notes": {
            "sunshine_hours": (
                "Derived from ERA5 sunshine_duration. Counts hours of 'bright' sunshine (direct irradiance "
                "above ~120 W/m²). Does not capture diffuse radiation on overcast days."
            ),
            "shortwave_mj_m2": (
                "Derived from ERA5 shortwave_radiation_sum. Represents total incoming solar energy "
                "(direct + diffuse) at the surface per day. This is the physically meaningful energy-balance "
                "quantity and is what a pyranometer measures."
            ),
        },
        "station_pairing_rule": (
            "Choose the nearest Klymot temperature station whose record starts no later "
            "than the sunshine start year and ends no earlier than the sunshine end year. "
            "Valentia is fixed to EI000003953."
        ),
        "stations": records,
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    write_csv(output, records)
    print(f"Wrote {output} and {output.with_suffix('.csv')}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
