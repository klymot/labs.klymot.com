"""Tests for pure algorithmic functions in scripts/fetch_sunshine.py."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_sunshine import (
    choose_temperature_station,
    haversine_km,
    parse_year,
    reusable_existing_records,
)


# ── haversine_km ──────────────────────────────────────────────────────────────

class TestHaversineKm:
    def test_same_point_is_zero(self):
        assert haversine_km(51.5, -0.1, 51.5, -0.1) == pytest.approx(0.0, abs=1e-6)

    def test_london_paris_approx_340_km(self):
        # London (51.507°N, 0.128°W) → Paris (48.857°N, 2.352°E)
        dist = haversine_km(51.507, -0.128, 48.857, 2.352)
        assert 330 < dist < 345

    def test_north_south_pole_approx_20015_km(self):
        # Antipodal points on a meridian ≈ half Earth circumference ≈ 20015 km
        dist = haversine_km(90, 0, -90, 0)
        assert abs(dist - 20015) < 5

    def test_symmetry(self):
        a = haversine_km(52.5, 13.4, 48.9, 2.3)
        b = haversine_km(48.9, 2.3, 52.5, 13.4)
        assert a == pytest.approx(b, rel=1e-9)

    def test_equatorial_degree_approx_111_km(self):
        dist = haversine_km(0, 0, 0, 1)
        assert abs(dist - 111.319) < 0.5


# ── parse_year ────────────────────────────────────────────────────────────────

class TestParseYear:
    def test_iso_date(self):
        assert parse_year("2023-01-01") == 2023

    def test_mid_year_date(self):
        assert parse_year("1990-07-15") == 1990

    def test_year_only(self):
        assert parse_year("1947") == 1947

    def test_two_digit_year_prefix(self):
        # parse_year takes first 4 chars as year
        assert parse_year("2000-12-31") == 2000


# ── choose_temperature_station ────────────────────────────────────────────────

def _make_station(id_, lat, lng, first, last, category="station"):
    return {
        "id": id_,
        "name": f"Station {id_}",
        "category": category,
        "lat": lat,
        "lng": lng,
        "ghcn_first_year": first,
        "ghcn_last_year": last,
    }


class TestChooseTemperatureStation:
    def test_fixed_station_id_selected_directly(self):
        station = _make_station("EI000003953", 51.94, -10.22, 1940, 2025)
        location = {
            "key": "VAL",
            "lat": 51.9394,
            "lon": -10.2219,
            "fixed_temp_station_id": "EI000003953",
        }
        result = choose_temperature_station(location, [station], 1940, 2024)
        assert result["id"] == "EI000003953"

    def test_fixed_station_id_adds_distance_km(self):
        station = _make_station("EI000003953", 51.94, -10.22, 1940, 2025)
        location = {
            "key": "VAL",
            "lat": 51.9394,
            "lon": -10.2219,
            "fixed_temp_station_id": "EI000003953",
        }
        result = choose_temperature_station(location, [station], 1940, 2024)
        assert "distance_km" in result
        assert result["distance_km"] >= 0

    def test_fixed_station_missing_raises(self):
        location = {
            "key": "VAL",
            "lat": 51.94,
            "lon": -10.22,
            "fixed_temp_station_id": "MISSING",
        }
        with pytest.raises(RuntimeError, match="MISSING"):
            choose_temperature_station(location, [], 1940, 2024)

    def test_fixed_station_coverage_mismatch_raises(self):
        station = _make_station("EI000003953", 51.94, -10.22, 1960, 2025)
        location = {
            "key": "VAL",
            "lat": 51.94,
            "lon": -10.22,
            "fixed_temp_station_id": "EI000003953",
        }
        with pytest.raises(RuntimeError, match="does not cover"):
            choose_temperature_station(location, [station], 1940, 2024)

    def test_nearest_covering_station_selected(self):
        near = _make_station("NEAR001", 52.38, 13.06, 1890, 2025)
        far  = _make_station("FAR001",  55.0,  14.0,  1890, 2025)
        location = {"key": "POT", "lat": 52.38, "lon": 13.06}
        result = choose_temperature_station(location, [near, far], 1940, 2024)
        assert result["id"] == "NEAR001"

    def test_station_without_coverage_skipped(self):
        too_late = _make_station("LATE001", 52.38, 13.06, 1960, 2025)
        covers   = _make_station("GOOD001", 52.39, 13.07, 1890, 2025)
        location = {"key": "POT", "lat": 52.38, "lon": 13.06}
        result = choose_temperature_station(location, [too_late, covers], 1940, 2024)
        assert result["id"] == "GOOD001"

    def test_non_station_category_skipped(self):
        grid = _make_station("GRID001", 52.38, 13.06, 1890, 2025, category="gridded")
        real = _make_station("REAL001", 52.40, 13.08, 1890, 2025, category="station")
        location = {"key": "POT", "lat": 52.38, "lon": 13.06}
        result = choose_temperature_station(location, [grid, real], 1940, 2024)
        assert result["id"] == "REAL001"

    def test_no_covering_station_raises(self):
        station = _make_station("LATE001", 52.38, 13.06, 1960, 2025)
        location = {"key": "POT", "lat": 52.38, "lon": 13.06}
        with pytest.raises(RuntimeError, match="No GHCN station"):
            choose_temperature_station(location, [station], 1940, 2024)


# ── reusable_existing_records ─────────────────────────────────────────────────

class TestReusableExistingRecords:
    def _write(self, directory, name, content):
        (directory / name).write_text(json.dumps(content), encoding="utf-8")

    def test_returns_matching_records(self, tmp_path):
        self._write(tmp_path, "VAL.json", {
            "key": "VAL",
            "end_date": "2024-12-31",
            "daily": [{"date": "2024-01-01", "shortwave_mj_m2": 2.5}],
        })
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert "VAL" in result

    def test_skips_manifest(self, tmp_path):
        self._write(tmp_path, "manifest.json", {"stations": []})
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert len(result) == 0

    def test_skips_wrong_end_date(self, tmp_path):
        self._write(tmp_path, "POT.json", {
            "key": "POT",
            "end_date": "2023-12-31",
            "daily": [{"date": "2023-01-01", "shortwave_mj_m2": 3.1}],
        })
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert "POT" not in result

    def test_skips_empty_daily(self, tmp_path):
        self._write(tmp_path, "STO.json", {
            "key": "STO",
            "end_date": "2024-12-31",
            "daily": [],
        })
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert "STO" not in result

    def test_skips_malformed_json(self, tmp_path):
        (tmp_path / "bad.json").write_text("{not valid json", encoding="utf-8")
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert len(result) == 0

    def test_multiple_stations(self, tmp_path):
        for key in ("VAL", "POT", "STO"):
            self._write(tmp_path, f"{key}.json", {
                "key": key,
                "end_date": "2024-12-31",
                "daily": [{"date": "2024-06-01", "shortwave_mj_m2": 5.0}],
            })
        result = reusable_existing_records(tmp_path, "2024-12-31")
        assert set(result.keys()) == {"VAL", "POT", "STO"}
