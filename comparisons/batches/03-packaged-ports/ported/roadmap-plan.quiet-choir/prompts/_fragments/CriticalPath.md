The critical path, the longest dependency chain by size (S 1, M 2, L 3, XL 5 points), as the
workflow computed it on this plan:
{%- for step in criticalPath.steps %} {{ step.id }} ({% if step.milestone %}milestone {{ step.milestone }}{% else %}deferred{% endif %}){% if not loop.last %} ->{% endif %}{% endfor %}, {{ criticalPath.points }} points.
