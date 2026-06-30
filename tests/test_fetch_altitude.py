"""Tests for pure functions in scripts/fetch_altitude.py."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_altitude import StationMeta, compute_annual_stats, grid_cell, parse_inventory, parse_monthly_network_altitudes


# ── parse_inventory ───────────────────────────────────────────────────────────

INV_SAMPLE = (
    "ACW00011604  17.1167  -61.7833   10.1 ST JOHNS COOLIDGE FLD                    \n"
    "AE000041196  24.4333   54.6500   34.0 ABU DHABI INTL                            \n"
    "BAD_LINE\n"
    "ZZ000099999  10.0000   20.0000 -999.9 MISSING ELEVATION                         \n"
)


class TestParseInventory:
    def test_parses_two_valid_stations(self):
        result = parse_inventory(INV_SAMPLE)
        assert "ACW00011604" in result
        assert "AE000041196" in result

    def test_elevation_values(self):
        result = parse_inventory(INV_SAMPLE)
        assert result["ACW00011604"] == StationMeta(lat=17.1167, lon=-61.7833, elev=10.1)
        assert result["AE000041196"] == StationMeta(lat=24.4333, lon=54.6500, elev=34.0)

    def test_excludes_missing_elevation(self):
        result = parse_inventory(INV_SAMPLE)
        assert "ZZ000099999" not in result

    def test_skips_short_lines(self):
        result = parse_inventory(INV_SAMPLE)
        assert "BAD_LINE" not in result

    def test_empty_input(self):
        assert parse_inventory("") == {}


# ── parse_active_years ────────────────────────────────────────────────────────

def _dat_line(station: str, year: int, values: list[int], qc_flags: list[str] | None = None) -> str:
    """Build a minimal GHCNm .dat line with monthly values and optional QC flags."""
    header = f"{station:<11}{year:4d}TAVG"
    blocks = []
    for i, value in enumerate(values):
        qc = qc_flags[i] if qc_flags and i < len(qc_flags) else " "
        blocks.append(f"{value:5d} {qc}k")
    data = "".join(blocks)
    return header + data


class TestGridCell:
    def test_assigns_5_degree_cells(self):
        assert grid_cell(17.1, -61.8) == (21, 23)
        assert grid_cell(-89.9, 179.9) == (0, 71)


class TestMonthlyNetworkAltitude:
    def test_cells_are_equal_weighted_within_a_month(self):
        stations = {
            "A": StationMeta(lat=10.0, lon=10.0, elev=0.0),
            "B": StationMeta(lat=10.1, lon=10.2, elev=100.0),
            "C": StationMeta(lat=10.4, lon=15.0, elev=300.0),
        }
        text = "\n".join([
            _dat_line("A", 2000, [100] * 12),
            _dat_line("B", 2000, [100] * 12),
            _dat_line("C", 2000, [100] * 12),
        ])
        monthly, contributing = parse_monthly_network_altitudes(text, stations)
        jan = monthly[0]
        assert jan["year"] == 2000
        assert jan["month"] == 1
        assert jan["network_elev_m"] == pytest.approx(175.0)
        assert jan["n_cells"] == 2
        assert jan["n_stations"] == 3
        assert contributing == {"A", "B", "C"}

    def test_qc_flagged_month_is_excluded(self):
        stations = {"A": StationMeta(lat=10.0, lon=10.0, elev=100.0)}
        line = _dat_line("A", 2000, [100] * 12)
        chars = list(line)
        chars[19 + 0 * 8 + 6] = "X"
        monthly, contributing = parse_monthly_network_altitudes("".join(chars), stations)
        assert len(monthly) == 11
        assert monthly[0]["month"] == 2
        assert contributing == {"A"}


# ── compute_annual_stats ──────────────────────────────────────────────────────

class TestComputeAnnualStats:
    def test_basic_mean_and_count(self):
        monthly = [
            {"year": 2000, "month": m, "network_elev_m": float(m), "n_cells": 2, "n_stations": 3}
            for m in range(1, 13)
        ]
        result = compute_annual_stats(monthly)
        assert len(result) == 1
        assert result[0]["year"] == 2000
        assert result[0]["mean_elev_m"] == pytest.approx(6.5)
        assert result[0]["median_elev_m"] == pytest.approx(6.5)
        assert result[0]["n"] == 12

    def test_skips_years_with_no_full_month_set(self):
        monthly = [{"year": 2000, "month": 1, "network_elev_m": 100.0, "n_cells": 1, "n_stations": 1}]
        result = compute_annual_stats(monthly)
        assert result == []

    def test_excludes_incomplete_final_year(self):
        monthly = [
            {"year": 2000, "month": m, "network_elev_m": 100.0, "n_cells": 1, "n_stations": 1}
            for m in range(1, 13)
        ] + [
            {"year": 2001, "month": m, "network_elev_m": 200.0, "n_cells": 1, "n_stations": 1}
            for m in range(1, 7)
        ]
        result = compute_annual_stats(monthly)
        years = [r["year"] for r in result]
        assert 2000 in years
        assert 2001 not in years

    def test_empty_returns_empty(self):
        assert compute_annual_stats([]) == []

    def test_median_computed(self):
        monthly = [
            {"year": 2000, "month": m, "network_elev_m": v, "n_cells": 1, "n_stations": 1}
            for m, v in enumerate([10.0, 20.0, 30.0, 40.0, 50.0, 60.0, 70.0, 80.0, 90.0, 100.0, 110.0, 120.0], start=1)
        ]
        result = compute_annual_stats(monthly)
        assert result[0]["median_elev_m"] == pytest.approx(65.0)
