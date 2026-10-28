Update {{ path }} to match the code. A checker verified these claims against the repository and
found that they drifted; each has the doc text, what the code actually does and, where the checker
drafted one, replacement text:
{%- for claim in drifted %}

{{ loop.index }}. Doc text: "{{ claim.quote }}"
   Reality: {{ claim.reality }}
{%- if claim.suggestedText %}

   Suggested text: {{ claim.suggestedText }}
{%- endif %}
{%- endfor +%}

{% if kept %}
These claims were verified true; keep their text:
{%- for quote in kept %}

- "{{ quote }}"
{%- endfor +%}

{% endif %}
Edit {{ path }} in place and no other file: the workflow refuses a change that touches another file
or renames this one. Keep the doc's voice and structure; change only what is wrong, and do not add
sections. Do not run anything. The workflow checks that each drifted doc text is gone and each true
one remains, then shows a human the patch before anything is published. Return a one-line summary
per edit.
