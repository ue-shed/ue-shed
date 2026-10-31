"""The structural check must reject every change except newly decoded raw values."""

import runpy
import unittest
from pathlib import Path

compare = runpy.run_path(str(Path(__file__).with_name("compare-values.py")))["compare"]
merge = runpy.run_path(str(Path(__file__).with_name("census.py")))["merge"]


class EvidenceComparisonTests(unittest.TestCase):
    def test_accepts_raw_replacement_and_descendants(self):
        old = {(0, "/known"): ("typed", "a"), (0, "/new"): ("raw", "b")}
        new = {**old, (0, "/new"): ("array", "c"), (0, "/new/element:0"): ("typed", "d")}
        self.assertEqual(compare(old, new), 1)

    def test_rejects_changes_to_existing_values_shapes_tags_and_raw_reasons(self):
        for kind in ("typed", "typed_array", "typed_set", "tag", "array", "map", "struct", "raw"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                compare({(0, "/known"): (kind, "a")}, {(0, "/known"): (kind, "b")})

    def test_rejects_removals_and_unrelated_additions(self):
        with self.assertRaises(ValueError):
            compare({(0, "/known"): ("typed", "a")}, {})
        with self.assertRaises(ValueError):
            compare({}, {(0, "/unknown"): ("typed", "a")})

    def test_raw_replacement_does_not_allow_neighbor_or_other_export_changes(self):
        old = {(0, "/new"): ("raw", "a")}
        for key in ((0, "/new-neighbor"), (1, "/new/element:0")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                compare(old, {(0, "/new"): ("array", "b"), key: ("typed", "c")})


class CensusMergeTests(unittest.TestCase):
    def test_sums_disjoint_shards_and_all_dimensions(self):
        count = {"count": 2, "packages_affected": 1, "raw_payload_bytes": 8,
                 "unknown_payload_sizes": 1, "examples": ["fixture#property"]}
        reason = {**count, **{field: {"key": count} for field in
                  ("by_detail", "by_property_type", "by_struct_name", "by_export_class")}}
        report = {"schema": 1, "git_commit": "fixture", "scope": "properties",
                  "totals": {"packages": 1}, "stage_ns": {"decode": 10},
                  "by_reason": {"UnsupportedType": reason}, "errors": {"failure": count},
                  "buckets": [{**count, "reason": "UnsupportedType", "detail": "unknown",
                               "property_type": "StructProperty", "struct_name": "Fixture",
                               "export_class": "/Script/Engine.DataAsset"}]}
        result = merge([report, report], 1.5)
        self.assertEqual(result["totals"]["packages"], 2)
        self.assertEqual(result["stage_ns"]["decode"], 20)
        self.assertEqual(result["buckets"][0]["count"], 4)
        self.assertEqual(result["buckets"][0]["packages_affected"], 2)
        self.assertEqual(result["by_reason"]["UnsupportedType"]["by_detail"]["key"]["count"], 4)
        self.assertEqual(result["errors"]["failure"]["raw_payload_bytes"], 16)
        self.assertEqual(result["wall_seconds"], 1.5)


if __name__ == "__main__":
    unittest.main()
