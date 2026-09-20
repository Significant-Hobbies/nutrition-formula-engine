"""Small, explicit unit conversion layer for formulation calculations."""

from __future__ import annotations

from decimal import Decimal

MASS_TO_G = {
    "kg": Decimal(1000),
    "g": Decimal(1),
    "mg": Decimal("0.001"),
    "ug": Decimal("0.000001"),
}

VOLUME_TO_ML = {
    "l": Decimal(1000),
    "ml": Decimal(1),
}

ENERGY_TO_KCAL = {
    "kcal": Decimal(1),
    "kj": Decimal("0.2390057361376673"),
}


def normalize_unit(unit: str) -> str:
    normalized = unit.strip().replace("µ", "u").replace("μ", "u").lower()
    aliases = {
        "gm": "g",
        "gms": "g",
        "gram": "g",
        "grams": "g",
        "kgs": "kg",
        "kilogram": "kg",
        "kilograms": "kg",
        "milligram": "mg",
        "milligrams": "mg",
        "liter": "l",
        "liters": "l",
        "litre": "l",
        "litres": "l",
        "milliliter": "ml",
        "milliliters": "ml",
        "millilitre": "ml",
        "millilitres": "ml",
        "mcg": "ug",
        "microgram": "ug",
        "micrograms": "ug",
    }
    return aliases.get(normalized, normalized)


def dimension(unit: str) -> str:
    normalized = normalize_unit(unit)
    if normalized in MASS_TO_G:
        return "mass"
    if normalized in VOLUME_TO_ML:
        return "volume"
    if normalized in ENERGY_TO_KCAL:
        return "energy"
    return "semantic"


def convert(value: Decimal, from_unit: str, to_unit: str) -> Decimal:
    source = normalize_unit(from_unit)
    target = normalize_unit(to_unit)
    if source == target:
        return value
    source_dimension = dimension(source)
    target_dimension = dimension(target)
    if source_dimension != target_dimension:
        raise ValueError(f"Cannot convert {from_unit!r} to {to_unit!r}")
    if source_dimension == "mass":
        return value * MASS_TO_G[source] / MASS_TO_G[target]
    if source_dimension == "volume":
        return value * VOLUME_TO_ML[source] / VOLUME_TO_ML[target]
    if source_dimension == "energy":
        return value * ENERGY_TO_KCAL[source] / ENERGY_TO_KCAL[target]
    raise ValueError(f"Semantic unit {from_unit!r} must exactly match {to_unit!r}")


def to_mass_g(value: Decimal, unit: str, density_g_per_ml: Decimal | None) -> Decimal:
    if dimension(unit) == "mass":
        return convert(value, unit, "g")
    if dimension(unit) == "volume" and density_g_per_ml is not None:
        return convert(value, unit, "ml") * density_g_per_ml
    raise ValueError(f"A density in g/mL is required to convert {value} {unit} to mass")


def to_volume_ml(value: Decimal, unit: str, density_g_per_ml: Decimal | None) -> Decimal:
    if dimension(unit) == "volume":
        return convert(value, unit, "ml")
    if dimension(unit) == "mass" and density_g_per_ml is not None:
        if density_g_per_ml <= 0:
            raise ValueError("Density must be greater than zero")
        return convert(value, unit, "g") / density_g_per_ml
    raise ValueError(f"A density in g/mL is required to convert {value} {unit} to volume")
