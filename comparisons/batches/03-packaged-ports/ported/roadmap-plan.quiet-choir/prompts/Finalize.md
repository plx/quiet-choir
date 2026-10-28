Produce the committed roadmap from the winning {{ strategy }} plan below. The workflow renders the
document from what you return, a milestone table, the critical path and a risk register, so return
the plan itself, revised:

- Apply the graft from a runner-up and the stress-test fixes where they improve the plan. You may
  move capabilities between milestones, split, merge or rename milestones, and sharpen goals and
  gates; the capabilities and their dependencies are fixed.
- Resolve every numbered stress-test problem exactly once: applied, saying what changed, or
  declined, saying why.
- List each milestone's key risks: what could make it slip or fail, naming the high-risk
  capabilities it carries.
- Write the strategy statement: one paragraph on the sequencing strategy and why it fits.

{% include "_fragments/Rules.md" +%}

{% if graft %}
Graft this idea from the {{ graft.from }} strategy, or decline it and say why: {{ graft.idea }}
{% else %}
No graft was offered; return graft as null.
{% endif %}

{% if problems %}
Stress-test problems:
{%- for problem in problems %}

{{ loop.index }}. {{ problem.kind }}: {{ problem.detail }}
   Fix: {{ problem.fix }}
{%- endfor +%}
{% else %}
The stress test found no problems; return an empty resolutions list.
{% endif %}

{% include "_fragments/CriticalPath.md" +%}

{% include "_fragments/Plan.md" +%}

{% include "_fragments/Capabilities.md" %}
