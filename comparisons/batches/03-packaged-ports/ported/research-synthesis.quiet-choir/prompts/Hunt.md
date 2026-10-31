Run one targeted research hunt for a gap in an answer to this question.

{% include "_fragments/Question.md" +%}

Gap: {{ gap.gap }}
Instruction: {{ gap.huntInstruction }}

{% if commit %}
This hunt searches this repository, checked out for you at commit {{ commit }}. You have its file
tools and no web tools. Give a repository-relative path as the ref, with the kind local-code: a
URL, an absolute path, or a path with a . or .. segment or inside .git fails the hunt.
{% else %}
This hunt searches the web with WebSearch and WebFetch. You have no access to local files.
{% endif %}

{% if known %}
These sources were already read, so prefer one that is not among them unless the instruction names
it:
{%- for ref in known %}

- {{ ref }}
{%- endfor +%}

{% endif %}
Follow the instruction, then report the one source that best fills this gap, with its ref, kind and
credibility tier, and findings for exactly this gap. An empty hunt reports no source.

{% include "_fragments/Credibility.md" +%}

{% include "_fragments/Findings.md" +%}

{% include "_fragments/Untrusted.md" %}
