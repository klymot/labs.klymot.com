"""Tests for pure algorithmic functions behind the two Error Bars pipelines."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_common import (
    bu_context_from_station,
    daterange_days,
    nearest_klymot_station,
    rows_to_calendar_values,
)
from fetch_error_bars_temperature import (
    month_range,
    monthly_midpoint_means,
    monthly_to_calendar_values,
)


# ── daterange_days / rows_to_calendar_values ─────────────────────────────────

class TestDaterangeDays:
    def test_single_day(self):
        assert daterange_days("2020-01-01", "2020-01-01") == ["2020-01-01"]

    def test_spans_month_boundary(self):
        days = daterange_days("2020-01-30", "2020-02-02")
        assert days == ["2020-01-30", "2020-01-31", "2020-02-01", "2020-02-02"]

    def test_leap_year_february(self):
        days = daterange_days("2020-02-01", "2020-03-01")
        assert len(days) == 30  # 29 February days + 1 March day
        assert "2020-02-29" in days


class TestRowsToCalendarValues:
    def test_gaps_become_none(self):
        rows = [{"date": "2020-01-01", "value": 1.0}, {"date": "2020-01-03", "value": 3.0}]
        assert rows_to_calendar_values(rows, "2020-01-01", "2020-01-03") == [1.0, None, 3.0]

    def test_rows_outside_range_ignored(self):
        rows = [{"date": "2019-12-31", "value": 9.0}, {"date": "2020-01-02", "value": 2.0}]
        assert rows_to_calendar_values(rows, "2020-01-01", "2020-01-02") == [None, 2.0]

    def test_empty_rows(self):
        assert rows_to_calendar_values([], "2020-01-01", "2020-01-02") == [None, None]


# ── month_range / monthly_to_calendar_values ─────────────────────────────────

class TestMonthRange:
    def test_single_month(self):
        assert month_range("2020-05", "2020-05") == ["2020-05"]

    def test_year_boundary(self):
        assert month_range("2019-11", "2020-02") == ["2019-11", "2019-12", "2020-01", "2020-02"]

    def test_calendar_values_align(self):
        monthly = {"2020-01": 1.5, "2020-03": 3.5}
        assert monthly_to_calendar_values(monthly, "2020-01", "2020-03") == [1.5, None, 3.5]


# ── monthly_midpoint_means ────────────────────────────────────────────────────

def full_month(ym: str, ndays: int, tmax: float, tmin: float):
    dates = [f"{ym}-{d:02d}" for d in range(1, ndays + 1)]
    return dates, [tmax] * ndays, [tmin] * ndays


class TestMonthlyMidpointMeans:
    def test_constant_month_gives_midpoint(self):
        dates, tmax, tmin = full_month("2020-01", 31, 10.0, 0.0)
        assert monthly_midpoint_means(dates, tmax, tmin) == {"2020-01": 5.0}

    def test_month_below_coverage_dropped(self):
        # 31-day month with only 20 valid days: 20/31 < 0.9
        dates, tmax, tmin = full_month("2020-01", 31, 10.0, 0.0)
        for i in range(20, 31):
            tmax[i] = None
        assert monthly_midpoint_means(dates, tmax, tmin) == {}

    def test_month_just_above_coverage_kept(self):
        # 30-day month with 28 valid days: 28/30 >= 0.9
        dates, tmax, tmin = full_month("2020-04", 30, 8.0, 4.0)
        tmin[0] = None
        tmax[1] = None
        result = monthly_midpoint_means(dates, tmax, tmin)
        assert result == {"2020-04": 6.0}

    def test_mean_over_varying_days(self):
        dates = ["2020-06-%02d" % d for d in range(1, 31)]
        tmax = [20.0] * 15 + [30.0] * 15
        tmin = [10.0] * 30
        # midpoints: 15 days at 15.0, 15 days at 20.0 → mean 17.5
        assert monthly_midpoint_means(dates, tmax, tmin) == {"2020-06": 17.5}

    def test_months_partitioned_correctly(self):
        d1, x1, n1 = full_month("2020-01", 31, 2.0, 0.0)
        d2, x2, n2 = full_month("2020-02", 29, 6.0, 2.0)
        result = monthly_midpoint_means(d1 + d2, x1 + x2, n1 + n2)
        assert result == {"2020-01": 1.0, "2020-02": 4.0}


# ── nearest_klymot_station / bu_context_from_station ─────────────────────────

INDEX = [
    {"id": "AAA", "category": "station", "lat": 50.0, "lng": 10.0,
     "name": "NEAR", "bu_2020_idx": 7, "bu_2020_1km": 1.5, "bu_2020_5km": 2.5, "bu_2020_20km": 3.5},
    {"id": "BBB", "category": "station", "lat": 55.0, "lng": 10.0, "name": "FAR"},
    {"id": "CCC", "category": "country", "lat": 50.0, "lng": 10.0, "name": "NOT A STATION"},
    {"id": "DDD", "category": "station", "name": "NO COORDS"},
]


class TestNearestKlymotStation:
    def test_picks_nearest_station_category_only(self):
        best = nearest_klymot_station(50.1, 10.0, INDEX)
        assert best["id"] == "AAA"

    def test_distance_recorded(self):
        best = nearest_klymot_station(50.0, 10.0, INDEX)
        assert best["distance_km"] == pytest.approx(0.0, abs=1e-6)

    def test_empty_index(self):
        assert nearest_klymot_station(50.0, 10.0, []) is None

    def test_bu_context_shape(self):
        best = nearest_klymot_station(50.0, 10.0, INDEX)
        ctx = bu_context_from_station(best)
        assert ctx == {
            "ghcn_station_id": "AAA",
            "ghcn_station_name": "NEAR",
            "distance_km": 0.0,
            "bu_2020_idx": 7,
            "bu_2020_1km": 1.5,
            "bu_2020_5km": 2.5,
            "bu_2020_20km": 3.5,
        }

    def test_bu_context_none(self):
        assert bu_context_from_station(None) is None
