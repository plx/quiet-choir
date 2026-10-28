Draft release notes for this audience: {{ audience }}.

- Breaking changes and deprecations come first, each with its migration note.
- Then highlights: the three to five changes this audience cares about most, one short paragraph
  each.
- Then categorized lists: Features, Fixes, Performance, Deprecations.
- Leave out internal changes unless the audience is contributors.
- Every line must trace to a change below: add nothing and embellish nothing. Cite each change's
  short SHA in parentheses.

{% include "_fragments/Changes.md" +%}

Return only the markdown.
