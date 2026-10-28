The workflow ran the operator's verification commands on the integrated "{{ package }}" upgrade
({{ from }} -> {{ to }}), and some failed.
{% if install %}
You are in that checkout, after the workflow ran `{{ install }}` in it; read it to localize each
failure.
{% else %}
You are in that checkout; read it to localize each failure.
{% endif %}
Read only; do not edit files.

{% if repair %}
Cluster the failures by root cause, not one entry per failing test, and name the files a fix must
change. Fixers may change only these files, and a file belongs to the first cluster that names it:
{%- else %}
This was the last verification: no fixer runs after you, and the workflow reports your clusters as
what the upgrade still breaks. Cluster the failures by root cause, not one entry per failing test,
and name the files a fix would change; the approved plan allows these:
{%- endif %}
{%- for file in allowed %}

- {{ file }}
{%- endfor +%}

Scrutinize especially: {% if testFocus %}{{ testFocus | join('; ') }}{% else %}all touched areas{% endif %}.

{% include "_fragments/Breaking.md" +%}

{% include "_fragments/Failures.md" %}
