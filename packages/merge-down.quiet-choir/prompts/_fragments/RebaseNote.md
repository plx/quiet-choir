{% if rebase.status == 'conflict' %}The rebase needed conflict resolution; double-check these spots:
{{ rebase.resolutions }}. Concerns raised:
{{ rebase.concerns }}.{% elif rebase.status == 'rebased' %}The rebase onto {{ situation.base }}
applied cleanly (upstream change: {{ rebase.upstreamDelta or 'n/a' }}).{% else %}The PR already
contained the tip of {{ situation.base }}; no rebase was needed.{% endif %}
