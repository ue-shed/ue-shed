import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("reader_replay", Path(__file__).with_name("simulate_reader_memory.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def job(size, duration, live):
    return {"inputBytes": size, "startNs": 100, "readyNs": 100+duration,
            "consumeNs": 100+duration, "endNs": 101+duration, "stagedCapacity": 0,
            "points": [{"ns": duration, "liveBytes": 0, "intervalPeakBytes": live}]}


class ReaderBudgetReplay(unittest.TestCase):
    def test_unlimited_work_overlaps_and_the_budget_serializes_inputs(self):
        jobs = [job(60, 100, 1000), job(60, 100, 1000)]
        unlimited = module.replay(jobs, None, workers=2)
        bounded = module.replay(jobs, 60, workers=2)
        self.assertEqual(unlimited["wallNs"], 102)
        self.assertEqual(unlimited["livePeakBytes"], 2000)
        self.assertEqual(bounded["wallNs"], 201)
        self.assertEqual(bounded["livePeakBytes"], 1000)
        self.assertEqual(bounded["activeInputPeakBytes"], 60)

    def test_an_oversized_input_runs_alone_without_deadlock(self):
        jobs = [job(200, 100, 1000), job(50, 100, 300)]
        result = module.replay(jobs, 100, workers=2)
        self.assertEqual(result["wallNs"], 201)
        self.assertEqual(result["activeInputPeakBytes"], 200)

    def test_peak_changes_combine_simultaneous_release_and_admission(self):
        self.assertEqual(module.peak_of_changes([(0, 50), (1, -50), (1, 70)]), 70)


if __name__ == "__main__":
    unittest.main()
