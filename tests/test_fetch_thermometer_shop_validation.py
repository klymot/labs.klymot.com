"""Tests for the pure parts of the thermometer-shop validation fetch."""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_thermometer_shop_validation import (
    VALIDATION_DIR,
    load_manifest,
    subhourly_filename,
    subhourly_url,
)


class TestSubhourlyNaming:
    def test_filename_matches_uscrn_convention(self):
        assert (
            subhourly_filename(2024, "OR_Coos_Bay_8_SW")
            == "CRNS0101-05-2024-OR_Coos_Bay_8_SW.txt"
        )

    def test_url_places_year_directory(self):
        url = subhourly_url(2024, "FL_Titusville_7_E")
        assert url == (
            "https://www.ncei.noaa.gov/pub/data/uscrn/products/subhourly01/"
            "2024/CRNS0101-05-2024-FL_Titusville_7_E.txt"
        )


class TestManifest:
    def test_checked_in_manifest_is_complete(self):
        manifest = load_manifest(VALIDATION_DIR / "stations.json")
        assert manifest["year"] >= 2024
        assert len(manifest["stations"]) >= 2
        for station in manifest["stations"]:
            for key in ("id", "label", "slug", "latDeg", "lonDeg", "tzMeridian"):
                assert key in station, f"{station.get('id')} missing {key}"
            # Near sea level is the point of the station choice.
            assert station["elevationM"] < 50

    def test_rejects_empty_station_list(self, tmp_path):
        empty = tmp_path / "stations.json"
        empty.write_text(json.dumps({"year": 2024, "stations": []}))
        with pytest.raises(ValueError):
            load_manifest(empty)
