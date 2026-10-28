{% include "_fragments/Question.md" +%}

Find leads for this question through one modality. Other scouts search the other modalities, and
each modality is blind to the territory of the others, so stay inside yours.

{% if modality == 'web' %}
Your modality is web search. Hunt official documentation, engineering blog write-ups, benchmarks
and papers. Your blind spot is recency against search ranking: a 2019 blog post outranks last
month's changelog, so check dates, prefer primary sources and note versions.
{% elif modality == 'source' %}
Your modality is source code and releases. For every library or tool the question involves, find
its repository, changelog, release cadence, ratio of open to closed issues and test quality, and
fetch them over the web. Code does not overstate its capabilities the way marketing pages do.
{% elif modality == 'practitioners' %}
Your modality is practitioner discussion: issue threads, forum, Hacker News and Stack Overflow
discussions, and postmortems that mention the topic. This is where "works great until 10k QPS"
lives, the failure modes official documentation omits. Mark everything here anecdotal unless
another source corroborates it.
{% else %}
Your modality is this repository, checked out for you at commit {{ commit }}.
Search it for current usage, constraints and integration points that would make general advice
inapplicable here: this modality grounds the answer in our reality. Give repository-relative file
paths as refs, with the kind local-code.
{% endif %}

Return leads only: refs a deep reader can follow, each with what it promises for this question, its
kind and a credibility tier. Do not read anything in depth. 8 to 12 good leads beat a long list of
mediocre ones; return at most {{ maxLeads }}, and an empty list is a valid result.

{% include "_fragments/Credibility.md" +%}

{% include "_fragments/Untrusted.md" %}
