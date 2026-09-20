## Repository operating rules

- This repository is a local-only formulation calculation prototype.
- Do not commit, push, deploy, or add network services without explicit approval.
- Preserve source values and provenance; never turn missing nutrient data into zero.
- Use decimal arithmetic for all formulation calculations.
- Run `PYTHONPATH=src uv run python -m unittest discover -s tests -v` after engine changes.
