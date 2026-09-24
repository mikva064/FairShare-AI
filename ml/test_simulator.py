"""Regression tests for input validation and score reproducibility."""

import math
import unittest

from simulator import Decision, example_scenario, explain, simulate, simulate_scenario, validate


class SimulatorValidationTests(unittest.TestCase):
    def test_example_score_is_stable(self):
        result = simulate(example_scenario())
        self.assertTrue(result.valid)
        self.assertEqual(result.score, 56.54)
        self.assertEqual(result.baseline_score, 52.56)
        self.assertEqual(result.total_cost, 95)
        self.assertEqual(result.remaining_budget, 5)

    def test_budget_must_be_a_finite_nonnegative_integer(self):
        for budget in (-1, 2.5, True, "100", math.inf, math.nan):
            with self.subTest(budget=budget):
                result = simulate(example_scenario(), budget)
                self.assertFalse(result.valid)
                self.assertIsNone(result.score)
        self.assertTrue(simulate(example_scenario(), 100.0).valid)

    def test_malformed_decisions_return_validation_errors(self):
        for decisions in (None, "M1", {"measureId": "M1"}, [None]):
            with self.subTest(decisions=decisions):
                _, errors = validate(decisions)
                self.assertTrue(errors)
        bad_district = [
            {"measureId": "M7", "districtId": []},
            {"measureId": "M8", "districtId": "Новая застройка"},
            {"measureId": "M10", "districtId": "Новая застройка"},
            {"measureId": "M12"},
            {"measureId": "M5", "districtId": "Промышленная зона"},
        ]
        result = simulate(bad_district)
        self.assertFalse(result.valid)
        self.assertIsNone(result.score)

    def test_contract_normalizes_id_and_district_whitespace(self):
        choices = [
            {"measureId": " m7 ", "districtId": "developing"},
            Decision("M8", "Новая застройка"), Decision("M10", "Новая застройка"),
            Decision("M12"), Decision("M5", "Промышленная зона"),
        ]
        result = simulate_scenario(choices)
        self.assertTrue(result["valid"])
        self.assertEqual(result["total_score"], 56.54)

    def test_custom_budget_round_trips_in_explanation(self):
        result = simulate(example_scenario(), budget=120)
        self.assertTrue(result.valid)
        self.assertIn("95/120", explain(result))


if __name__ == "__main__":
    unittest.main()
