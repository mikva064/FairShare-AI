"""Independent calculation for the Qyzyljar AI synthetic city simulator.

The model computes scores from the supplied synthetic dataset. It deliberately
does not ask an LLM to calculate numbers; an LLM can consume ``to_dict()`` and
explain those already-computed results.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite
from typing import Any, Iterable

BUDGET = 100
HORIZON = 8

DISTRICTS = ("Центральная зона", "Жилые кварталы", "Промышленная зона", "Прибрежная зона", "Новая застройка")
DISTRICT_IDS = {
    "center": "Центральная зона",
    "residential": "Жилые кварталы",
    "industrial": "Промышленная зона",
    "riverside": "Прибрежная зона",
    "developing": "Новая застройка",
}
POPULATION = {
    "Центральная зона": 0.27,
    "Жилые кварталы": 0.24,
    "Промышленная зона": 0.20,
    "Прибрежная зона": 0.13,
    "Новая застройка": 0.16,
}
INDICATORS = ("T1", "T2", "E1", "E2", "S1", "S2", "B1", "B2", "C1", "C2")
WEIGHTS = dict(zip(INDICATORS, (0.10, 0.10, 0.09, 0.11, 0.11, 0.11, 0.09, 0.09, 0.10, 0.10)))
INDICATOR_NAMES = {
    "T1": "разгрузка дорог", "T2": "доступность общественного транспорта",
    "E1": "озеленение", "E2": "качество воздуха",
    "S1": "школы и детсады", "S2": "поликлиники и первичная медпомощь",
    "B1": "безопасность городской среды", "B2": "безопасность дорожного движения",
    "C1": "надёжность ЖКХ", "C2": "скорость решения обращений",
}

BASELINE = {
    "Центральная зона": dict(zip(INDICATORS, (45, 62, 68, 72, 48, 55, 78, 60, 75, 70))),
    "Жилые кварталы": dict(zip(INDICATORS, (40, 75, 50, 55, 60, 65, 62, 52, 50, 60))),
    "Промышленная зона": dict(zip(INDICATORS, (50, 70, 42, 40, 62, 68, 58, 55, 45, 55))),
    "Прибрежная зона": dict(zip(INDICATORS, (52, 68, 55, 50, 58, 60, 52, 58, 55, 58))),
    "Новая застройка": dict(zip(INDICATORS, (55, 40, 45, 65, 38, 35, 55, 50, 60, 50))),
}


@dataclass(frozen=True)
class Initiative:
    id: str
    direction: str
    name: str
    scope: str  # "district" or "city"
    cost: int
    lag: int
    effects: dict[str, float]


INITIATIVES = {
    "M1": Initiative("M1", "Транспорт", "Приоритет автобусов на загруженных улицах", "district", 18, 2, {"T1": 6, "T2": 9}),
    "M2": Initiative("M2", "Транспорт", "Адаптивные светофоры и безопасные перекрёстки", "city", 22, 2, {"T1": 4, "B2": 3}),
    "M3": Initiative("M3", "Транспорт", "Обновление автобусов и доступные остановки", "district", 30, 4, {"T1": 16, "T2": 20, "E2": 4}),
    "M4": Initiative("M4", "Городская среда", "Дворовые скверы и общественные пространства", "district", 15, 2, {"E1": 12, "E2": 3, "B1": 2}),
    "M5": Initiative("M5", "Городская среда", "Утепление домов частного сектора", "district", 25, 3, {"E2": 14, "C1": 4}),
    "M6": Initiative("M6", "Городская среда", "Озеленение и защитные посадки", "city", 20, 4, {"E1": 5, "E2": 3}),
    "M7": Initiative("M7", "Соцсфера", "Дополнительные места в школах и детсадах", "district", 24, 3, {"S1": 16}),
    "M8": Initiative("M8", "Соцсфера", "Доступная первичная медпомощь", "district", 20, 3, {"S2": 14}),
    "M9": Initiative("M9", "Соцсфера", "Дворовые спортивные площадки", "district", 10, 1, {"S1": 3, "S2": 3, "B1": 3}),
    "M10": Initiative("M10", "Безопасность", "Освещение дворов и пешеходных маршрутов", "district", 12, 1, {"B1": 12, "B2": 2}),
    "M11": Initiative("M11", "Безопасность", "Безопасные переходы и школьные зоны", "district", 10, 1, {"B2": 12, "T1": -2}),
    "M12": Initiative("M12", "ЖКХ и сервисы", "Единое окно обращений жителей", "city", 14, 1, {"C2": 5}),
    "M13": Initiative("M13", "ЖКХ и сервисы", "Ремонт теплотрасс и водопроводов", "district", 28, 4, {"C1": 18, "E2": 2}),
    "M15": Initiative("M15", "Безопасность", "Ливневая канализация и защита от подтоплений", "district", 18, 2, {"B1": 8, "C1": 6}),
    "M14": Initiative("M14", "ЖКХ и сервисы", "Аварийные бригады ЖКХ и раннее оповещение", "city", 16, 1, {"C1": 5, "C2": 2}),
}

# Conflict rules: (initiative pair, same-district restriction or global restriction).
GLOBAL_CONFLICTS = (frozenset(("M1", "M3")),)
SAME_DISTRICT_CONFLICTS = (frozenset(("M4", "M7")), frozenset(("M5", "M13")))
SYNERGIES = {
    frozenset(("M1", "M2")): ("T1", 2, "M1"),
    frozenset(("M10", "M12")): ("B1", 2, "M10"),
    frozenset(("M5", "M6")): ("E2", 2, "M5"),
}


@dataclass(frozen=True)
class Decision:
    initiative_id: str
    district: str | None = None


@dataclass
class SimulationResult:
    valid: bool
    errors: list[str]
    score: float | None = None
    baseline_score: float = 52.56
    score_change: float | None = None
    total_cost: int = 0
    remaining_budget: int = BUDGET
    district_scores: dict[str, float] | None = None
    city_average: float | None = None
    weakest_district: str | None = None
    critical_count: int | None = None
    indicators: dict[str, dict[str, float]] | None = None
    initiative_impacts: list[dict[str, Any]] | None = None
    strengths: list[str] | None = None
    risks: list[str] | None = None
    recommendations: list[str] | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON-serializable result for a web API or an LLM explainer."""
        return asdict(self)


def _normalize_decisions(decisions: Iterable[Decision | dict[str, Any]]) -> list[Decision]:
    if decisions is None or isinstance(decisions, (str, bytes, dict)):
        raise TypeError("Решения должны быть списком из пяти объектов.")
    normalized = []
    for item in decisions:
        if isinstance(item, Decision):
            if not isinstance(item.initiative_id, str):
                raise TypeError("ID меры должен быть строкой.")
            if item.district is not None and not isinstance(item.district, str):
                raise TypeError("Название зоны должно быть строкой.")
            normalized.append(Decision(item.initiative_id.strip().upper(), item.district.strip() if item.district else None))
        elif isinstance(item, dict):
            district = item.get("district", item.get("districtId"))
            if isinstance(district, str):
                district = DISTRICT_IDS.get(district.strip().lower(), district.strip())
            initiative_id = item.get("initiative_id", item.get("measureId", item.get("id", "")))
            if not isinstance(initiative_id, str):
                raise TypeError("ID меры должен быть строкой.")
            normalized.append(Decision(
                initiative_id.strip().upper(),
                district,
            ))
        else:
            raise TypeError("Каждое решение должно быть Decision или словарём.")
    return normalized


def validate(decisions: Iterable[Decision | dict[str, Any]], budget: int = BUDGET) -> tuple[list[Decision], list[str]]:
    """Validate all game rules. Invalid scenarios are never scored."""
    budget_is_integer = type(budget) is int or (
        isinstance(budget, float) and isfinite(budget) and budget.is_integer()
    )
    if not budget_is_integer or budget < 0:
        return [], ["Бюджет должен быть неотрицательным целым числом."]
    budget = int(budget)
    try:
        picks = _normalize_decisions(decisions)
    except (TypeError, ValueError) as exc:
        return [], [str(exc)]
    errors: list[str] = []
    if len(picks) != 5:
        errors.append(f"Нужно выбрать ровно 5 мер; сейчас выбрано {len(picks)}.")
    unknown = [p.initiative_id for p in picks if p.initiative_id not in INITIATIVES]
    if unknown:
        errors.append("Неизвестные ID мер: " + ", ".join(unknown) + ".")
    ids = [p.initiative_id for p in picks]
    duplicates = sorted({x for x in ids if ids.count(x) > 1})
    if duplicates:
        errors.append("Повторно выбраны меры: " + ", ".join(duplicates) + ".")
    valid_picks = [p for p in picks if p.initiative_id in INITIATIVES]
    cost = sum(INITIATIVES[p.initiative_id].cost for p in valid_picks)
    if cost > budget:
        errors.append(f"Бюджет превышен: стоимость {cost}, доступно {budget}.")
    counts: dict[str, int] = {}
    for p in valid_picks:
        initiative = INITIATIVES[p.initiative_id]
        if initiative.scope == "district":
            if not isinstance(p.district, str) or p.district not in DISTRICTS:
                errors.append(f"Для {p.initiative_id} нужно указать район из списка: {', '.join(DISTRICTS)}.")
        elif p.district is not None:
            errors.append(f"Для городской меры {p.initiative_id} район указывать нельзя.")
        counts[initiative.direction] = counts.get(initiative.direction, 0) + 1
    for direction, count in counts.items():
        if count > 2:
            errors.append(f"В направлении «{direction}» выбрано {count} меры; максимум — 2.")
    for conflict in GLOBAL_CONFLICTS:
        if conflict.issubset(ids):
            errors.append("Несовместимые меры нельзя выбирать вместе: " + " и ".join(sorted(conflict)) + ".")
    for conflict in SAME_DISTRICT_CONFLICTS:
        if conflict.issubset(ids):
            by_id = {p.initiative_id: p for p in picks}
            first_id, second_id = sorted(conflict)
            if by_id[first_id].district == by_id[second_id].district:
                errors.append("Меры " + " и ".join(sorted(conflict)) + " несовместимы в одном районе.")
    return picks, errors


def simulate(decisions: Iterable[Decision | dict[str, Any]], budget: int = BUDGET) -> SimulationResult:
    """Calculate the exact score and a transparent, rule-based explanation."""
    picks, errors = validate(decisions, budget)
    if errors:
        cost = sum(INITIATIVES[p.initiative_id].cost for p in picks if p.initiative_id in INITIATIVES)
        safe_budget = budget if isinstance(budget, int) and not isinstance(budget, bool) and budget >= 0 else BUDGET
        return SimulationResult(False, errors, total_cost=cost, remaining_budget=safe_budget - cost)

    updated = {d: dict(values) for d, values in BASELINE.items()}
    impacts = []
    for p in picks:
        initiative = INITIATIVES[p.initiative_id]
        factor = (HORIZON - initiative.lag) / HORIZON
        targets = DISTRICTS if initiative.scope == "city" else (p.district,)
        for district in targets:
            for indicator, full_effect in initiative.effects.items():
                updated[district][indicator] += full_effect * factor
        impacts.append({
            "id": initiative.id, "name": initiative.name, "district": p.district or "все учебные зоны",
            "cost": initiative.cost, "lag": initiative.lag,
            "realized_share": round(factor, 4),
            "effects_per_target": {k: round(v * factor, 4) for k, v in initiative.effects.items()},
        })

    selected_ids = {p.initiative_id for p in picks}
    by_id = {p.initiative_id: p for p in picks}
    synergy_details = []
    for pair, (indicator, bonus, target_id) in SYNERGIES.items():
        if pair.issubset(selected_ids):
            target_measure = INITIATIVES[target_id]
            target_districts = DISTRICTS if target_measure.scope == "city" else (by_id[target_id].district,)
            for district in target_districts:
                updated[district][indicator] += bonus
            pair_label = " + ".join(sorted(pair))
            synergy_details.append(f"Сработала синергия {pair_label}: +{bonus} к {indicator} в районе меры {target_id}.")

    for district in DISTRICTS:
        for indicator in INDICATORS:
            updated[district][indicator] = min(100.0, max(0.0, updated[district][indicator]))

    district_scores = {
        district: sum(WEIGHTS[k] * updated[district][k] for k in INDICATORS)
        for district in DISTRICTS
    }
    city_average = sum(POPULATION[d] * district_scores[d] for d in DISTRICTS)
    weakest_district = min(district_scores, key=district_scores.get)
    critical_count = sum(updated[d][k] < 40 for d in DISTRICTS for k in INDICATORS)
    raw_score = 0.7 * city_average + 0.3 * district_scores[weakest_district] - critical_count
    score = round(raw_score, 2)
    base_district_scores = {d: sum(WEIGHTS[k] * BASELINE[d][k] for k in INDICATORS) for d in DISTRICTS}
    base_avg = sum(POPULATION[d] * base_district_scores[d] for d in DISTRICTS)
    base_min = min(base_district_scores.values())
    base_critical = sum(BASELINE[d][k] < 40 for d in DISTRICTS for k in INDICATORS)
    baseline_score = round(0.7 * base_avg + 0.3 * base_min - base_critical, 2)

    # Attribute each measure's realized weighted indicator contribution.
    strengths = []
    risks = []
    recommendations = []
    for impact in impacts:
        initiative = INITIATIVES[impact["id"]]
        gains = impact["effects_per_target"]
        strongest = max(gains, key=lambda k: abs(gains[k]))
        strengths.append(f"{impact['id']} улучшает показатель «{INDICATOR_NAMES[strongest]}» на {gains[strongest]:g} пункта в {impact['district']}.")
    critical_indicators = [(d, k, updated[d][k]) for d in DISTRICTS for k in INDICATORS if updated[d][k] < 40]
    if critical_indicators:
        risks.extend(f"В районе {d} сохраняется критическое значение: {INDICATOR_NAMES[k]} — {v:g}/100." for d, k, v in critical_indicators)
    else:
        risks.append("После выбранных мер показателей ниже критического порога 40 не осталось.")
    if budget - sum(INITIATIVES[p.initiative_id].cost for p in picks) > 0:
        recommendations.append(f"Осталось {budget - sum(INITIATIVES[p.initiative_id].cost for p in picks)} единиц бюджета; можно изучить сценарий с дополнительным усилением слабой зоны {weakest_district}.")
    if district_scores[weakest_district] < city_average:
        recommendations.append(f"Слабейший район — {weakest_district} ({district_scores[weakest_district]:.2f}/100); при следующем пересмотре бюджета проверьте его показатели отдельно.")
    recommendations.extend(synergy_details)
    return SimulationResult(
        valid=True, errors=[], score=score, baseline_score=baseline_score,
        score_change=round(score - baseline_score, 2),
        total_cost=sum(INITIATIVES[p.initiative_id].cost for p in picks),
        remaining_budget=budget - sum(INITIATIVES[p.initiative_id].cost for p in picks),
        district_scores={d: round(v, 2) for d, v in district_scores.items()},
        city_average=round(city_average, 2), weakest_district=weakest_district,
        critical_count=critical_count,
        indicators={d: {k: round(v, 2) for k, v in vals.items()} for d, vals in updated.items()},
        initiative_impacts=impacts, strengths=strengths, risks=risks,
        recommendations=recommendations,
    )


def explain(result: SimulationResult) -> str:
    """Produce a short Russian explanation from computed values only."""
    if not result.valid:
        return "Сценарий не рассчитан:\n" + "\n".join(f"• {e}" for e in result.errors)
    direction = "вырос" if result.score_change >= 0 else "снизился"
    lines = [
        f"Индекс городской среды: {result.score:.2f}/100 ({direction} на {abs(result.score_change):.2f} к базе {result.baseline_score:.2f}).",
        f"Стоимость решений: {result.total_cost}/{result.total_cost + result.remaining_budget}; остаток: {result.remaining_budget}.",
        f"Средний балл города: {result.city_average:.2f}; самая слабая зона: {result.weakest_district} ({result.district_scores[result.weakest_district]:.2f}).",
        f"Критических значений ниже 40: {result.critical_count}.",
        "Сильные стороны: " + " ".join(result.strengths or []),
        "Риски: " + " ".join(result.risks or []),
    ]
    if result.recommendations:
        lines.append("Рекомендации: " + " ".join(result.recommendations))
    return "\n".join(lines)


def example_scenario() -> list[Decision]:
    """Synthetic social-balance scenario. Not official city statistics."""
    return [
        Decision("M7", "Новая застройка"), Decision("M8", "Новая застройка"), Decision("M10", "Новая застройка"),
        Decision("M12"), Decision("M5", "Промышленная зона"),
    ]


def simulate_scenario(decisions: Iterable[Decision | dict[str, Any]], budget: int = BUDGET) -> dict[str, Any]:
    """Adapter for the team's shared JSON contract (measureId/districtId)."""
    result = simulate(decisions, budget=budget)
    payload = result.to_dict()
    payload["total_score"] = result.score
    category_scores = {}
    if result.valid:
        groups = {
            "transport": ("T1", "T2"), "ecology": ("E1", "E2"),
            "social": ("S1", "S2"), "safety": ("B1", "B2"),
            "services": ("C1", "C2"),
        }
        for direction_id in ("transport", "ecology", "social", "safety", "services"):
            # Indicator directions are fixed by the source dataset.
            keys = groups[direction_id]
            weight_sum = sum(WEIGHTS[k] for k in keys)
            category_scores[direction_id] = round(sum(
                POPULATION[d] * sum(WEIGHTS[k] * result.indicators[d][k] for k in keys) / weight_sum
                for d in DISTRICTS
            ), 2)
    payload["category_scores"] = category_scores if result.valid else None
    payload["budget_status"] = {
        "total": budget,
        "spent": result.total_cost,
        "remaining": result.remaining_budget,
        "within_budget": result.remaining_budget >= 0,
    }
    payload["risks"] = result.risks or []
    return payload


if __name__ == "__main__":
    result = simulate(example_scenario())
    print(explain(result))
