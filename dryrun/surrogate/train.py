"""LightGBM surrogate (owner: Eng A, Day 4-5).

Data: ~200-400 solver runs from a Latin-hypercube over
  storm.total_mm [40, 250], drain capacity_factor [0.5, 3], green fraction [0, 0.3],
  pond volume [0, X], tide level [-0.5, 1.5]
Target: RunStats fields (buildings_flooded, road_km_impassable, people_exposed).
Report held-out R^2 / MAE in the README. Surrogate results carry is_surrogate=True and
the agent must confirm any recommendation with a real run_simulation before citing it.
Batch generation: Modal or a Cloud Run Job, NOT the live API.
"""
