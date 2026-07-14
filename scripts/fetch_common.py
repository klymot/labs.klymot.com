#!/usr/bin/env python3
"""Shared fetch helpers for the labs data pipelines.

Generalized versions of the source-specific download logic first written in
fetch_sunshine.py, so every lab's fetch script can reuse the *code* while
keeping its own isolated data directory (labs share fetch logic, never data
files).

Measured-series fetchers all return a list of {"date": ISO date, "value":
float} rows, sorted by date, with missing/sentinel values dropped; callers
rename "value" to whatever their output schema uses.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict

KLYMOT_INDEX_URL = "https://www.klymot.com/data/index.json"
OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
USER_AGENT = "labs.klymot.com data pipeline"


# ── Generic HTTP ────────────────────────────────────────────────────────────

def fetch_json(url: str, timeout: int = 90, retries: int = 4) -> dict:
    """GET a JSON document, retrying with backoff on HTTP 429."""
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            if error.code != 429 or attempt == retries:
                raise
            wait_seconds = 10 * (attempt + 1)
            print(
                f"Rate limited by {urllib.parse.urlparse(url).netloc}; retrying in {wait_seconds}s",
                file=sys.stderr,
            )
            time.sleep(wait_seconds)


def fetch_bytes(url: str, timeout: int = 120) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ── Geometry / dates ────────────────────────────────────────────────────────

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


def daterange_days(start_date: str, end_date: str) -> list[str]:
    """Every ISO date from start to end inclusive."""
    start = dt.date.fromisoformat(start_date)
    end = dt.date.fromisoformat(end_date)
    out = []
    day = start
    while day <= end:
        out.append(day.isoformat())
        day += dt.timedelta(days=1)
    return out


def rows_to_calendar_values(rows: list[dict], start_date: str, end_date: str) -> list[float | None]:
    """Align {date, value} rows onto the full start..end calendar, None for gaps.

    Rows outside the range are ignored, so callers can pass a fetcher's raw
    output without pre-filtering.
    """
    by_date = {row["date"]: row["value"] for row in rows}
    return [by_date.get(day) for day in daterange_days(start_date, end_date)]


# ── Klymot station index ────────────────────────────────────────────────────

def fetch_klymot_station_index() -> list[dict]:
    print(f"Fetching GHCN station index from {KLYMOT_INDEX_URL}", file=sys.stderr)
    return fetch_json(KLYMOT_INDEX_URL)["locations"]


def nearest_klymot_station(lat: float, lon: float, stations: list[dict]) -> dict | None:
    """Nearest GHCN station in the index — used for built-up context around a
    site that isn't itself a GHCN station. Returns a copy with distance_km set."""
    best = None
    best_km = math.inf
    for s in stations:
        if s.get("category") != "station" or "lat" not in s or "lng" not in s:
            continue
        km = haversine_km(lat, lon, s["lat"], s["lng"])
        if km < best_km:
            best_km = km
            best = s
    if best is None:
        return None
    station = dict(best)
    station["distance_km"] = best_km
    return station


def klymot_station_by_id(station_id: str, stations: list[dict]) -> dict | None:
    return next((s for s in stations if s.get("id") == station_id), None)


def bu_context_from_station(station: dict | None) -> dict | None:
    """The built-up fields the lab cards need, from a klymot index entry."""
    if station is None:
        return None
    return {
        "ghcn_station_id": station.get("id"),
        "ghcn_station_name": station.get("name"),
        "distance_km": round(station["distance_km"], 2) if "distance_km" in station else 0.0,
        "bu_2020_idx": station.get("bu_2020_idx"),
        "bu_2020_1km": station.get("bu_2020_1km"),
        "bu_2020_5km": station.get("bu_2020_5km"),
        "bu_2020_20km": station.get("bu_2020_20km"),
    }


# ── DWD (Deutscher Wetterdienst) daily solar ────────────────────────────────

def fetch_dwd_solar_daily(station_id: str, start_date: str, end_date: str) -> list[dict]:
    """DWD CDC daily solar: FG_STRAHL = daily global radiation in J/cm².

    Divide by 100 to convert to MJ/m². station_id is the zero-padded DWD id,
    e.g. "03987" for Potsdam.
    """
    url = (
        "https://opendata.dwd.de/climate_environment/CDC/"
        "observations_germany/climate/daily/solar/"
        f"tageswerte_ST_{station_id}_row.zip"
    )
    print(f"  Downloading DWD solar ZIP for station {station_id}...", file=sys.stderr)
    zip_bytes = fetch_bytes(url, timeout=120)

    start_dt = dt.date.fromisoformat(start_date)
    end_dt = dt.date.fromisoformat(end_date)
    rows: list[dict] = []

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        data_name = next(n for n in zf.namelist() if n.startswith("produkt_"))
        with zf.open(data_name) as f:
            content = f.read().decode("latin-1")

    reader = csv.DictReader(io.StringIO(content), delimiter=";")
    for row in reader:
        date_str = (row.get("MESS_DATUM") or "").strip()
        fg_str = (row.get("FG_STRAHL") or "").strip()
        if not date_str or not fg_str or fg_str == "-999":
            continue
        try:
            date = dt.datetime.strptime(date_str, "%Y%m%d").date()
            mj = round(float(fg_str) / 100.0, 3)
        except ValueError:
            continue
        if date < start_dt or date > end_dt:
            continue
        rows.append({"date": date.isoformat(), "value": mj})

    rows.sort(key=lambda r: r["date"])
    return rows


# ── KNMI daily radiation ────────────────────────────────────────────────────

def fetch_knmi_daily_radiation(station_number: int, start_date: str, end_date: str) -> list[dict]:
    """KNMI daggegevens: Q = daily global radiation in J/cm² (÷100 → MJ/m²)."""
    start_str = start_date.replace("-", "")
    end_str = end_date.replace("-", "")
    url = (
        f"https://daggegevens.knmi.nl/klimatologie/daggegevens"
        f"?stns={station_number}&vars=Q&start={start_str}&end={end_str}&type=txt"
    )
    print(f"  Fetching KNMI radiation for station {station_number}...", file=sys.stderr)
    content = fetch_bytes(url, timeout=90).decode("utf-8")

    rows: list[dict] = []
    prefix = str(station_number)
    for line in content.splitlines():
        line = line.strip()
        if not line.startswith(prefix):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 3 or not parts[2]:
            continue
        try:
            date = dt.datetime.strptime(parts[1], "%Y%m%d").date()
            mj = round(float(parts[2]) / 100.0, 3)
        except (ValueError, IndexError):
            continue
        rows.append({"date": date.isoformat(), "value": mj})

    rows.sort(key=lambda r: r["date"])
    return rows


# ── SMHI daily radiation (from hourly) ──────────────────────────────────────

def fetch_smhi_daily_radiation(station_number: int, start_date: str, end_date: str) -> list[dict]:
    """SMHI open data parameter 11 (global irradiance, hourly mean W/m²),
    aggregated to daily MJ/m²: each hourly mean × 3600 s ÷ 1e6, summed."""
    url = (
        "https://opendata-download-metobs.smhi.se/api/version/1.0/"
        f"parameter/11/station/{station_number}/period/corrected-archive/data.csv"
    )
    print(f"  Fetching SMHI hourly radiation for station {station_number} (may take a moment)...", file=sys.stderr)
    content = fetch_bytes(url, timeout=180).decode("utf-8-sig")

    lines = content.splitlines()
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
            val = float(val_str)
        except ValueError:
            continue
        if date < start_dt or date > end_dt:
            continue
        daily_hourly[date.isoformat()].append(val)

    rows = [
        {"date": date_iso, "value": round(sum(v * 3600 / 1e6 for v in vals), 3)}
        for date_iso, vals in sorted(daily_hourly.items())
    ]
    return rows


# ── Open-Meteo (ERA5) daily archive ─────────────────────────────────────────

def fetch_open_meteo_daily(
    lat: float,
    lon: float,
    start_date: str,
    end_date: str,
    variables: list[str],
    timezone: str = "UTC",
    elevation: float | None = None,
) -> dict[str, list]:
    """Open-Meteo Historical Weather API (ERA5-family reanalysis).

    Returns the raw "daily" block: {"time": [...], <var>: [...], ...}.

    When ``elevation`` is given, it is passed through so Open-Meteo applies its
    lapse-rate downscaling to that exact elevation rather than guessing one from
    its 90 m DEM at the coordinate. Supplying the station's true elevation
    removes the DEM-lookup artifact that otherwise biases coastal points (where
    the DEM can land ~100 m too high, cooling the model by ~1 °C). Left unset,
    behaviour is unchanged.
    """
    params = {
        "latitude": lat,
        "longitude": lon,
        "start_date": start_date,
        "end_date": end_date,
        "daily": ",".join(variables),
        "timezone": timezone,
    }
    if elevation is not None:
        params["elevation"] = elevation
    url = f"{OPEN_METEO_ARCHIVE_URL}?{urllib.parse.urlencode(params)}"
    data = fetch_json(url, timeout=180)
    return data.get("daily", {})


def open_meteo_rows(daily_block: dict, variable: str, round_to: int = 3) -> list[dict]:
    """One Open-Meteo daily variable as {date, value} rows, dropping nulls/NaN."""
    rows = []
    for date_string, value in zip(daily_block.get("time", []), daily_block.get(variable, [])):
        if value is None or (isinstance(value, float) and math.isnan(value)):
            continue
        rows.append({"date": date_string, "value": round(value, round_to)})
    return rows
