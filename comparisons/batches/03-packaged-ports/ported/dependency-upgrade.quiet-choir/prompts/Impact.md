Map this repository's usage of the package "{{ package }}". Read only; do not edit files. Do not read
the package's own documentation: only this repository.

{% include "_fragments/Evidence.md" +%}

Report the exact installed version from that evidence.

{% if files %}
The workflow searched every tracked file for the name "{{ package }}" and found it in these files,
manifests and lockfiles aside:
{%- for file in files %}

- {{ file }}
{%- endfor +%}
{% else %}
The workflow searched every tracked file for the name "{{ package }}" and found it in no file besides
the manifests and lockfiles.
{% endif %}
{% if unmapped %}

{{ unmapped }} further files also mention the name; the workflow reports them as unmapped.
{% endif %}

Read each listed file. Record it as a usage site when it imports or requires the package, with WHICH
of the package's APIs it touches and how heavily; otherwise record it as unrelated, with why (a
similarly named package, a comment, a string). The search is a plain text match, so also look for
the usage it misses, such as re-exports and dynamic imports, and add those files as usage sites.
Identify the wrappers or adapter modules that concentrate the usage: they make an upgrade cheaper,
so say so in the indirect exposure.
