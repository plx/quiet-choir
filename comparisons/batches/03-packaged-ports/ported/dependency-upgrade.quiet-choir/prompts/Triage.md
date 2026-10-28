The workflow ran the operator's verification commands on the integrated "{{ package }}" upgrade
({{ from }} -> {{ to }}), and some failed. You are in that checkout, with the dependencies the
commands installed; read it to localize each failure. Read only; do not edit files.

Cluster the failures by root cause, not one entry per failing test, and name the files a fix must
change. Fixers may change only these files, and a file belongs to the first cluster that names it:
{%- for file in allowed %}

- {{ file }}
{%- endfor +%}

Scrutinize especially: {% if testFocus %}{{ testFocus | join('; ') }}{% else %}all touched areas{% endif %}.

{% include "_fragments/Breaking.md" +%}

{% include "_fragments/Failures.md" %}
