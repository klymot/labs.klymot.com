#!/usr/bin/env python3
"""Fetch NOAA GHCNm v4 QCU archive and compute the annual network altitude.

Source: https://www.ncei.noaa.gov/pub/data/ghcn/v4/ghcnm.tavg.latest.qcu.tar.gz
        (contains versioned .inv inventory and .dat temperature files)

Algorithm:
  1. For each month, include each station only if its monthly value is present
     and has no QC flag.
  2. Assign stations to ~500×500 km global grid cells.
  3. Compute the mean station elevation within each occupied cell.
  4. Equally average occupied-cell means to obtain the monthly network altitude.
  5. Average monthly network altitudes into yearly values.
  6. Exclude the incomplete final year.

Outputs:
  public/network-altitude/data/network-altitude.json  -- monthly and annual
                                                         altitude stats
  public/network-altitude/data/station-ids.json       -- station IDs with known
                                                         location/elevation
"""

from __future__ import annotations

import json
import math
import statistics
import sys
import tarfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

GHCNM_QCU_URL = "https://www.ncei.noaa.gov/pub/data/ghcn/v4/ghcnm.tavg.latest.qcu.tar.gz"

REPO_ROOT  = Path(__file__).resolve().parents[1]
CACHE_DIR  = REPO_ROOT / ".cache"
OUTPUT_DIR = REPO_ROOT / "public" / "network-altitude" / "data"

MISSING = -9999
CELL_DEGREES = 5.0


@dataclass(frozen=True)
class StationMeta:
    lat: float
    lon: float
    elev: float


# ── Download ──────────────────────────────────────────────────────────────────

def fetch_archive(url: str, cache_dir: Path) -> Path:
    """Download url to cache_dir, using ETag to skip unchanged files."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    filename  = url.rsplit("/", 1)[-1]
    dest      = cache_dir / filename
    etag_path = cache_dir / f"{filename}.etag"

    headers: dict[str, str] = {"User-Agent": "labs.klymot.com/data-pipeline"}
    if dest.exists() and etag_path.exists():
        etag = etag_path.read_text().strip()
        if etag:
            headers["If-None-Match"] = etag

    req = urllib.request.Request(url, headers=headers)
    try:
        resp = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as exc:
        if exc.code == 304 and dest.exists():
            print(f"  {filename}: cached (ETag match)", file=sys.stderr)
            return dest
        raise

    with resp:
        if getattr(resp, "status", None) == 304 and dest.exists():
            print(f"  {filename}: cached (ETag match)", file=sys.stderr)
            return dest
        print(f"  Downloading {filename}…", file=sys.stderr)
        with dest.open("wb") as fh:
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
        etag = resp.headers.get("ETag")
        if etag:
            etag_path.write_text(etag)

    print(f"  {dest.stat().st_size:,} bytes", file=sys.stderr)
    return dest


def find_member(archive: tarfile.TarFile, suffix: str) -> str:
    for member in archive.getmembers():
        if member.isfile() and member.name.endswith(suffix):
            return member.name
    raise RuntimeError(f"No {suffix!r} member found in archive")


def read_member_text(archive: tarfile.TarFile, name: str) -> str:
    fh = archive.extractfile(name)
    if fh is None:
        raise RuntimeError(f"Cannot open {name!r} from archive")
    return fh.read().decode("latin-1")


# ── Parsing ───────────────────────────────────────────────────────────────────

def parse_inventory(text: str) -> dict[str, StationMeta]:
    """Parse GHCNm .inv fixed-width file → {station_id: StationMeta}.

    Format (1-indexed columns):
      ID       1-11
      LAT     13-20
      LON     22-30
      STNELEV 32-37
    Stations with missing elevation (-999.9 or -999.0) are excluded.
    """
    stations: dict[str, StationMeta] = {}
    for line in text.splitlines():
        if len(line) < 37:
            continue
        station_id = line[0:11].strip()
        if not station_id:
            continue
        try:
            lat = float(line[12:20])
            lon = float(line[21:30])
            elev = float(line[31:37])
        except ValueError:
            continue
        if elev > -999.0:
            stations[station_id] = StationMeta(lat=lat, lon=lon, elev=elev)
    return stations


def grid_cell(lat: float, lon: float, cell_degrees: float = CELL_DEGREES) -> tuple[int, int]:
    """Return the index of the 5°×5° global grid cell containing lat/lon."""
    lat_bins = int(round(180.0 / cell_degrees))
    lon_bins = int(round(360.0 / cell_degrees))
    lat_idx = min(int(math.floor((lat + 90.0) / cell_degrees)), lat_bins - 1)
    lon_idx = min(int(math.floor(((lon + 180.0) % 360.0) / cell_degrees)), lon_bins - 1)
    return lat_idx, lon_idx


def parse_monthly_network_altitudes(
    text: str,
    stations: dict[str, StationMeta],
) -> tuple[list[dict], set[str]]:
    """Parse GHCNm .dat file into monthly network altitude records.

    Format (1-indexed columns):
      ID      1-11
      YEAR   12-15
      ELEMENT 16-19  (TAVG only)
      VALUE1 20-24  (Jan, hundredths °C; -9999 = missing)
      FLAGS  25-27
      VALUE2 28-32  (Feb)
      …      (8 chars per month × 12 = 96 chars)

    Active = at least 9 out of 12 months that are not -9999 and have no QC flag.

    Each month occupies 8 characters:
      value   [+0:+5]  hundredths °C (-9999 = missing)
      dmflag  [+5]
      qcflag  [+6]     non-blank = failed quality control → skip
      dsflag  [+7]
    """
    month_cells: dict[tuple[int, int], dict[tuple[int, int], dict[str, float]]] = {}
    contributing_station_ids: set[str] = set()
    for line in text.splitlines():
        if len(line) < 19:
            continue
        element = line[15:19]
        if element != "TAVG":
            continue
        station_id = line[0:11].strip()
        if not station_id:
            continue
        station = stations.get(station_id)
        if station is None:
            continue
        try:
            year = int(line[11:15])
        except ValueError:
            continue
        for m in range(12):
            val_start = 19 + m * 8
            val_end = val_start + 5
            qc_pos = val_start + 6
            if val_end > len(line):
                break
            try:
                value  = int(line[val_start:val_end])
                qcflag = line[qc_pos] if qc_pos < len(line) else " "
                if value == MISSING or qcflag.strip():
                    continue
            except ValueError:
                continue
            month_key = (year, m + 1)
            cell_key = grid_cell(station.lat, station.lon)
            month_cells.setdefault(month_key, {}).setdefault(cell_key, {})[station_id] = station.elev
            contributing_station_ids.add(station_id)

    monthly = []
    for (year, month) in sorted(month_cells):
        cell_map = month_cells[(year, month)]
        cell_means = [sum(elevs.values()) / len(elevs) for elevs in cell_map.values() if elevs]
        if not cell_means:
            continue
        monthly.append({
            "year": year,
            "month": month,
            "network_elev_m": round(sum(cell_means) / len(cell_means), 1),
            "n_cells": len(cell_means),
            "n_stations": sum(len(elevs) for elevs in cell_map.values()),
        })
    return monthly, contributing_station_ids


def compute_annual_stats(
    monthly: list[dict],
) -> list[dict]:
    """Average monthly network altitudes into yearly values.

    The final year is excluded if it is incomplete.
    """
    by_year: dict[int, list[dict]] = {}
    for record in monthly:
        by_year.setdefault(record["year"], []).append(record)

    records = []
    for year in sorted(by_year):
        year_months = sorted(by_year[year], key=lambda r: r["month"])
        if len(year_months) < 12:
            continue
        records.append({
            "year": year,
            "mean_elev_m": round(sum(r["network_elev_m"] for r in year_months) / len(year_months), 1),
            "median_elev_m": round(statistics.median(r["network_elev_m"] for r in year_months), 1),
            "n": len(year_months),
        })
    return records


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    archive_path = fetch_archive(GHCNM_QCU_URL, CACHE_DIR)

    with tarfile.open(archive_path, "r:gz") as archive:
        inv_name = find_member(archive, ".inv")
        dat_name = find_member(archive, ".dat")
        print(f"  Reading {inv_name}", file=sys.stderr)
        inv_text = read_member_text(archive, inv_name)
        print(f"  Reading {dat_name}", file=sys.stderr)
        dat_text = read_member_text(archive, dat_name)

    stations = parse_inventory(inv_text)
    print(f"  {len(stations):,} stations with known elevation and location", file=sys.stderr)

    monthly, contributing_station_ids = parse_monthly_network_altitudes(dat_text, stations)
    print(f"  {len(monthly):,} monthly network altitude records", file=sys.stderr)

    annual = compute_annual_stats(monthly)
    if annual:
        print(f"  {len(annual)} annual records ({annual[0]['year']}–{annual[-1]['year']})", file=sys.stderr)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    altitude_path = OUTPUT_DIR / "network-altitude.json"
    altitude_path.write_text(
        json.dumps({"generated": generated, "monthly": monthly, "annual": annual}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  Written {altitude_path}", file=sys.stderr)

    # Only emit stations that actually contributed at least one valid monthly
    # value to the altitude calculation.
    station_ids = sorted(contributing_station_ids)
    ids_path = OUTPUT_DIR / "station-ids.json"
    ids_path.write_text(
        json.dumps({"generated": generated, "station_ids": station_ids}, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"  Written {ids_path} ({len(station_ids):,} station IDs)", file=sys.stderr)


if __name__ == "__main__":
    main()
