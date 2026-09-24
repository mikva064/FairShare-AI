"""JSON-only local bridge; no network and no model API calls."""
import json
import sys
from simulator import simulate_scenario


def main():
    payload = json.load(sys.stdin)
    scenarios = payload["scenarios"]
    if not isinstance(scenarios, list) or not 1 <= len(scenarios) <= 256:
        raise ValueError("Invalid scenario batch")
    results = [simulate_scenario(decisions) for decisions in scenarios]
    json.dump(results, sys.stdout, ensure_ascii=False, allow_nan=False)


if __name__ == "__main__":
    main()
